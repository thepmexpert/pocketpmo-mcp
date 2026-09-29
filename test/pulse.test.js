import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSubscriptions } from '../lib/pulse/subscriptions.js';
import {
  buildDigestItems,
  ownerMatches,
  parseDate,
  calendarDays,
  isClosed,
  MAX_ITEMS
} from '../lib/pulse/needs.js';
import { renderDigest } from '../lib/pulse/render.js';
import {
  isSendEnabled,
  sendViaPostmark,
  sendViaAgentmail,
  resolveProvider,
  writeDryRun,
  POSTMARK_URL,
  AGENTMAIL_URL
} from '../lib/pulse/provider.js';
import { runPulse, cadenceDue } from '../pulse.js';

// Temp-dir discipline matching test/projects.test.js: register before use,
// one cleanup hook, one stubborn dir never aborts the suite.
const createdDirs = [];
function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-pulse-test-'));
  createdDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

const NOW = new Date('2026-09-29T09:00:00Z');
const BYRNE = { email: 'd.byrne@example.com', name: 'D. Byrne', cadence: 'daily', projects: [] };

// ---------------------------------------------------------------------------
// subscriptions.js
// ---------------------------------------------------------------------------

describe('subscriptions loader', () => {
  test('loads valid roster, normalizes email case, defaults cadence', () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({
        subscribers: [
          { email: 'PM@Example.COM', name: 'D. Byrne' },
          { email: 'x@y.io', cadence: 'weekly', projects: ['Alpha'] }
        ]
      })
    });
    const { subscribers, warnings, error } = loadSubscriptions(path.join(dir, 'subs.json'));
    assert.equal(error, null);
    assert.deepEqual(warnings, []);
    assert.equal(subscribers.length, 2);
    assert.equal(subscribers[0].email, 'pm@example.com');
    assert.equal(subscribers[0].cadence, 'daily');
    assert.deepEqual(subscribers[1].projects, ['Alpha']);
  });

  test('accepts a top-level bare array', () => {
    const dir = makeTempDir({ 'subs.json': '[{"email":"a@b.co"}]' });
    const { subscribers, error } = loadSubscriptions(path.join(dir, 'subs.json'));
    assert.equal(error, null);
    assert.equal(subscribers.length, 1);
  });

  test('skips invalid entries with warnings, keeps the rest', () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({
        subscribers: [
          { name: 'no email here' },
          { email: 'not-an-email' },
          'a string, not an object',
          { email: 'ok@ok.io' }
        ]
      })
    });
    const { subscribers, warnings } = loadSubscriptions(path.join(dir, 'subs.json'));
    assert.equal(subscribers.length, 1);
    assert.equal(warnings.length, 3);
  });

  test('deduplicates by email', () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({
        subscribers: [
          { email: 'dup@dup.io', name: 'first' },
          { email: 'DUP@dup.io', name: 'second' }
        ]
      })
    });
    const { subscribers, warnings } = loadSubscriptions(path.join(dir, 'subs.json'));
    assert.equal(subscribers.length, 1);
    assert.equal(subscribers[0].name, 'first');
    assert.equal(warnings.length, 1);
  });

  test('unreadable and malformed files fail soft with an error, never throw', () => {
    const missing = loadSubscriptions(path.join(os.tmpdir(), 'no-such-pulse-file.json'));
    assert.ok(missing.error);
    assert.equal(missing.subscribers.length, 0);

    const dir = makeTempDir({ 'bad.json': '{ not json' });
    const bad = loadSubscriptions(path.join(dir, 'bad.json'));
    assert.ok(bad.error.includes('JSON'));

    const dir2 = makeTempDir({ 'shape.json': '{"noSubscribersKey": true}' });
    const shape = loadSubscriptions(path.join(dir2, 'shape.json'));
    assert.ok(shape.error.includes('subscribers'));
  });
});

// ---------------------------------------------------------------------------
// needs.js primitives
// ---------------------------------------------------------------------------

describe('needs primitives', () => {
  test('parseDate accepts ISO, date-only, and Date; rejects garbage', () => {
    assert.ok(parseDate('2026-09-18') instanceof Date);
    assert.ok(parseDate('2026-09-18T10:00:00Z') instanceof Date);
    assert.ok(parseDate(new Date()) instanceof Date);
    assert.equal(parseDate('not a date'), null);
    assert.equal(parseDate(42), null);
    assert.equal(parseDate({ nested: true }), null);
    assert.equal(parseDate(null), null);
  });

  test('calendarDays is calendar-based, DST-safe', () => {
    // Europe/Dublin DST boundary 2026-10-25: 86400000-ms math drifts by an
    // hour; calendar-day math must not. From Mar 27 2026 (DST start) the
    // millisecond gap to Mar 30 is 3 days minus 1 hour → floor drifts.
    const from = new Date('2026-03-27T12:00:00Z');
    const to = new Date('2026-03-30T11:00:00Z');
    assert.equal(calendarDays(from, to), 3);
    assert.equal(calendarDays(to, from), -3);
  });

  test('isClosed knows the closed vocabulary and treats unknown as open', () => {
    for (const status of ['done', 'Completed', 'CANCELLED', 'approved', 'rejected']) {
      assert.ok(isClosed(status), status);
    }
    for (const status of [undefined, '', 'in_progress', 'pending', 'weird']) {
      assert.equal(isClosed(status), false, String(status));
    }
  });

  test('ownerMatches: exact, email, and shared-token matching; role labels never match', () => {
    assert.ok(ownerMatches('D. Byrne', BYRNE));
    assert.ok(ownerMatches('d. byrne', BYRNE));
    assert.ok(ownerMatches('David Byrne', BYRNE)); // shared token 'byrne'
    assert.ok(ownerMatches('D.BYRNE@EXAMPLE.COM', BYRNE));
    assert.ok(!ownerMatches('Priya N.', BYRNE));
    assert.ok(!ownerMatches('PM', BYRNE)); // 2-letter role label, not a name
    assert.ok(!ownerMatches('', BYRNE));
    assert.ok(!ownerMatches(undefined, BYRNE));
    // Emails never token-match: 'byrne@example.com' is not the person.
    assert.ok(!ownerMatches('byrne@elsewhere.io', BYRNE));
    // Hostile owner values must not throw.
    assert.ok(!ownerMatches({ toString: null }, BYRNE));
  });
});

// ---------------------------------------------------------------------------
// needs.js — digest computation
// ---------------------------------------------------------------------------

function project(overrides = {}) {
  return {
    id: 'p1',
    name: 'Alpha',
    manager: 'D. Byrne',
    activities: [],
    evmData: { milestones: [] },
    risks: [],
    ...overrides
  };
}

describe('buildDigestItems', () => {
  test('ranks overdue > decision > risk and caps at 3', () => {
    const projects = [
      project({
        activities: [
          { id: 'a1', name: 'Overdue task', owner: 'D. Byrne', dueDate: '2026-09-20' },
          { id: 'a2', name: 'Future task', owner: 'D. Byrne', dueDate: '2026-10-20' }
        ],
        decisions: [
          { title: 'Pending call', owner: 'D. Byrne', requestedOn: '2026-09-25', status: 'pending' }
        ],
        risks: [{ name: 'Big risk', probability: 5, impact: 5, status: 'open', owner: 'Priya N.' }]
      })
    ];
    const { items } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(items.length, MAX_ITEMS);
    assert.deepEqual(items.map((i) => i.kind), ['overdue-activity', 'decision', 'risk']);
    assert.equal(items[0].days, 9);
    assert.equal(items[2].score, 2500);
  });

  test('empty state: no matching items yields zero items (still renderable)', () => {
    const projects = [project({ activities: [{ id: 'a1', name: 'Nobody task', owner: 'Priya N.', dueDate: '2026-09-01' }] })];
    const { items, chases } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(items.length, 0);
    assert.ok(chases.length >= 1); // Priya's overdue work shows as a chase instead
  });

  test('project refs filter; done/complete/closed work is excluded', () => {
    const projects = [
      project({
        name: 'Mine',
        activities: [{ id: 'a1', name: 'Done overdue', owner: 'D. Byrne', dueDate: '2026-09-01', status: 'done' }]
      }),
      project({
        name: 'Not mine',
        activities: [{ id: 'a2', name: 'Other project overdue', owner: 'D. Byrne', dueDate: '2026-09-01' }]
      })
    ];
    const { items } = buildDigestItems({
      subscriber: { ...BYRNE, projects: ['Mine'] },
      projects,
      now: NOW
    });
    assert.equal(items.length, 0);
  });

  test('milestones: overdue open milestone surfaces, completed one does not', () => {
    const projects = [
      project({
        evmData: {
          milestones: [
            { id: 'm1', name: 'Done milestone', progress: 1, owner: 'D. Byrne', dueDate: '2026-09-01' },
            { id: 'm2', name: 'Late milestone', progress: 0.1, owner: 'D. Byrne', dueDate: '2026-09-02' }
          ]
        }
      })
    ];
    const { items } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'overdue-milestone');
    assert.equal(items[0].title, 'Late milestone');
  });

  test('decisions with missing status are pending; closed vocabulary is not', () => {
    const projects = [
      project({
        decisions: [
          { title: 'No status', owner: 'D. Byrne', requestedOn: '2026-09-28' },
          { title: 'Approved', owner: 'D. Byrne', requestedOn: '2026-09-28', status: 'approved' }
        ]
      })
    ];
    const { items } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'No status');
  });

  test('risks: own open risks rank by P×I; manager sees top project risk; closed excluded', () => {
    const projects = [
      project({
        risks: [
          { name: 'Small', probability: 1, impact: 1, status: 'open', owner: 'D. Byrne' },
          { name: 'Huge unowned', probability: 5, impact: 4, status: 'open', owner: 'Ops' },
          { name: 'Closed big', probability: 5, impact: 5, status: 'closed', owner: 'D. Byrne' }
        ]
      })
    ];
    const { items } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    // Small (100) + Huge unowned (2000, manager awareness). Closed big excluded.
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Huge unowned');
  });

  test('non-manager subscriber does not inherit unowned risks', () => {
    const projects = [project({ manager: 'Someone Else', risks: [{ name: 'Unowned', probability: 5, impact: 5, status: 'open' }] })];
    const { items } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(items.length, 0);
  });

  test('chases: explicit asks owed to the recipient, ranked by days outstanding', () => {
    const projects = [
      project({
        asks: [
          { from: 'Priya N.', to: 'D. Byrne', what: 'Capacity answer', requestedOn: '2026-09-15', status: 'open' },
          { from: 'D. Byrne', to: 'Priya N.', what: 'My own ask — never chased back at me', requestedOn: '2026-09-01' },
          { from: 'Ops', to: 'D. Byrne', what: 'Closed ask', status: 'done', requestedOn: '2026-09-01' }
        ]
      })
    ];
    const { chases } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(chases.length, 1);
    assert.equal(chases[0].who, 'Priya N.');
    assert.equal(chases[0].days, 14);
  });

  test('chases derived from overdue work owned by others', () => {
    const projects = [
      project({
        activities: [{ id: 'a1', name: 'Their late task', owner: 'Priya N.', dueDate: '2026-09-20' }]
      })
    ];
    const { chases } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.equal(chases.length, 1);
    assert.equal(chases[0].who, 'Priya N.');
    assert.equal(chases[0].days, 9);
  });

  test('fail-soft: hostile project shapes never throw', () => {
    const projects = [
      null,
      42,
      {},
      {
        id: 'hostile',
        name: 'Hostile',
        activities: [{ owner: { toString: null }, dueDate: { toString: null }, name: { toString: null } }, 'a string'],
        evmData: { milestones: 'not an array' },
        risks: [{ probability: 'high', impact: null, status: 'open' }],
        decisions: [{ title: { weird: true }, owner: ['array'], requestedOn: 'garbage' }],
        asks: [{ from: 42, what: null }],
        manager: { toString: null }
      }
    ];
    const { items, chases } = buildDigestItems({ subscriber: BYRNE, projects, now: NOW });
    assert.deepEqual(items, []);
    assert.deepEqual(chases, []);
  });
});

// ---------------------------------------------------------------------------
// render.js
// ---------------------------------------------------------------------------

const FROM = { fromName: 'PocketPMO Pulse', fromEmail: 'pulse@pocketpmo.com' };

describe('renderDigest', () => {
  const items = [
    { kind: 'overdue-activity', title: 'Target architecture <design>', projectName: 'Alpha & Beta', days: 11, score: 10011, dueDate: new Date('2026-09-18') },
    { kind: 'risk', title: 'Data quality risk', projectName: 'Alpha', probability: 4, impact: 4, days: null, score: 1600 }
  ];
  const chases = [
    { who: 'Priya N.', what: 'Capacity answer', projectName: 'Alpha', days: 14 }
  ];

  test('renders both formats with subject, sender identity, unsubscribe line', () => {
    const digest = renderDigest({
      subscriber: BYRNE, items, chases, now: NOW, ...FROM,
      unsubscribeUrl: 'https://pocketpmo.com/unsub/x'
    });
    assert.match(digest.subject, /^PocketPMO: 2 things need you — 2026-09-29$/);
    assert.ok(digest.html.includes('Target architecture &lt;design&gt;'));
    assert.ok(digest.html.includes('PocketPMO Pulse'));
    assert.ok(digest.html.includes('pulse@pocketpmo.com'));
    assert.ok(digest.html.includes('https://pocketpmo.com/unsub/x'));
    assert.ok(digest.text.includes('Target architecture <design>')); // text stays raw
    assert.ok(digest.text.includes('PocketPMO Pulse <pulse@pocketpmo.com>'));
    assert.ok(digest.text.includes('Unsubscribe: https://pocketpmo.com/unsub/x'));
    assert.ok(digest.text.includes('14 days outstanding'));
  });

  test('without unsubscribeUrl, reply-UNSUBSCRIBE line is used', () => {
    const digest = renderDigest({ subscriber: BYRNE, items: [], chases: [], now: NOW, ...FROM });
    assert.ok(digest.text.includes('Reply UNSUBSCRIBE to stop'));
    assert.ok(digest.html.includes('UNSUBSCRIBE'));
  });

  test('empty state: short digest still renders both formats', () => {
    const digest = renderDigest({ subscriber: BYRNE, items: [], chases: [], now: NOW, ...FROM });
    assert.match(digest.subject, /^PocketPMO: nothing needs you today/);
    assert.ok(digest.html.includes('Nothing needs you today'));
    assert.ok(digest.text.includes('Nothing needs you today'));
    assert.ok(digest.html.length > 200);
    assert.ok(digest.text.includes('PocketPMO Pulse <pulse@pocketpmo.com>'));
  });

  test('HTML is escaped for hostile titles; text output is plain', () => {
    const hostile = [{
      kind: 'decision',
      title: '<script>alert("x")</script>',
      projectName: '<img src=x onerror=alert(1)>',
      days: 3,
      score: 5003
    }];
    const digest = renderDigest({ subscriber: BYRNE, items: hostile, chases: [], now: NOW, ...FROM });
    assert.ok(!digest.html.includes('<script>alert'));
    assert.ok(digest.html.includes('&lt;script&gt;'));
    assert.ok(!digest.html.includes('<img src=x'));
  });
});

// ---------------------------------------------------------------------------
// provider.js — dry-run default + gated send
// ---------------------------------------------------------------------------

describe('provider send gate', () => {
  test('dry-run is the default: no flag or no token means no send', () => {
    assert.equal(isSendEnabled({}), false);
    assert.equal(isSendEnabled({ PULSE_SEND: '1' }), false);
    assert.equal(isSendEnabled({ POSTMARK_SERVER_TOKEN: 'tok' }), false);
    assert.equal(isSendEnabled({ PULSE_SEND: 'true', POSTMARK_SERVER_TOKEN: 'tok' }), false); // must be exactly '1'
    assert.equal(isSendEnabled({ PULSE_SEND: '1', POSTMARK_SERVER_TOKEN: 'tok' }), true);
  });

  test('sendViaPostmark posts to Postmark with token header and digest body', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ MessageID: 'abc-123' })
      };
    };
    const result = await sendViaPostmark({
      fetchImpl, token: 'tok', from: 'pulse@pocketpmo.com', to: 'x@y.io',
      subject: 's', html: '<p>h</p>', text: 't'
    });
    assert.deepEqual(result, { ok: true, messageId: 'abc-123' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, POSTMARK_URL);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['X-Postmark-Server-Token'], 'tok');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.To, 'x@y.io');
    assert.equal(body.MessageStream, 'broadcast');
  });

  test('sendViaPostmark: missing token fails fast without any network call', async () => {
    let called = false;
    const result = await sendViaPostmark({ fetchImpl: async () => { called = true; }, token: null });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('POSTMARK_SERVER_TOKEN'));
    assert.equal(called, false);
  });

  test('sendViaPostmark: API and network errors become results, never throws', async () => {
    const apiErr = await sendViaPostmark({
      fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ Message: 'Bad evidence' }) }),
      token: 'tok'
    });
    assert.equal(apiErr.ok, false);
    assert.ok(apiErr.error.includes('Bad evidence'));
    const netErr = await sendViaPostmark({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, token: 'tok' });
    assert.equal(netErr.ok, false);
    assert.ok(netErr.error.includes('ECONNRESET'));
    const nonJson = await sendViaPostmark({ fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }), token: 'tok' });
    assert.equal(nonJson.ok, false);
    assert.ok(nonJson.error.includes('502'));
  });

  test('resolveProvider: default postmark; only exact agentmail selects AgentMail', () => {
    assert.equal(resolveProvider({}), 'postmark');
    assert.equal(resolveProvider({ PULSE_PROVIDER: 'postmark' }), 'postmark');
    assert.equal(resolveProvider({ PULSE_PROVIDER: 'postmakr' }), 'postmark'); // typo fails toward dry-run, not a crash
    assert.equal(resolveProvider({ PULSE_PROVIDER: 'agentmail' }), 'agentmail');
  });

  test('send gate is provider-aware: agentmail needs key AND inbox id', () => {
    assert.equal(isSendEnabled({ PULSE_SEND: '1', PULSE_PROVIDER: 'agentmail' }), false);
    assert.equal(isSendEnabled({ PULSE_SEND: '1', PULSE_PROVIDER: 'agentmail', AGENTMAIL_API_KEY: 'k' }), false);
    assert.equal(isSendEnabled({ PULSE_SEND: '1', PULSE_PROVIDER: 'agentmail', AGENTMAIL_INBOX_ID: 'i' }), false);
    assert.equal(isSendEnabled({ PULSE_SEND: '1', PULSE_PROVIDER: 'agentmail', AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'i' }), true);
    // provider default unchanged: postmark token still gates
    assert.equal(isSendEnabled({ PULSE_SEND: '1', AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'i' }), false);
  });

  test('sendViaAgentmail posts to the inbox send endpoint with bearer auth and digest body', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ message_id: 'am-1', thread_id: 't-1' }) };
    };
    const result = await sendViaAgentmail({
      fetchImpl, apiKey: 'k', inboxId: 'pulse@agentmail.to', from: 'PocketPMO Pulse <pulse@pocketpmo.com>',
      to: 'x@y.io', subject: 's', html: '<p>h</p>', text: 't'
    });
    assert.deepEqual(result, { ok: true, messageId: 'am-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${AGENTMAIL_URL}/inboxes/${encodeURIComponent('pulse@agentmail.to')}/messages/send`);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer k');
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body.to, ['x@y.io']);
    // envelope-from is the inbox; the configured pulse address rides as Reply-To
    assert.deepEqual(body.reply_to, ['PocketPMO Pulse <pulse@pocketpmo.com>']);
    assert.equal(body.subject, 's');
    assert.equal(body.html, '<p>h</p>');
    assert.equal(body.text, 't');
  });

  test('sendViaAgentmail: missing key or inbox id fails fast without any network call', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; };
    const noKey = await sendViaAgentmail({ fetchImpl, apiKey: null, inboxId: 'i', to: 'x@y.io' });
    assert.equal(noKey.ok, false);
    assert.ok(noKey.error.includes('AGENTMAIL_API_KEY'));
    const noInbox = await sendViaAgentmail({ fetchImpl, apiKey: 'k', inboxId: '', to: 'x@y.io' });
    assert.equal(noInbox.ok, false);
    assert.ok(noInbox.error.includes('AGENTMAIL_INBOX_ID'));
    assert.equal(called, false);
  });

  test('sendViaAgentmail: API and network errors become results, never throws', async () => {
    const apiErr = await sendViaAgentmail({
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'rejected' }) }),
      apiKey: 'k', inboxId: 'i', to: 'x@y.io'
    });
    assert.equal(apiErr.ok, false);
    assert.ok(apiErr.error.includes('rejected'));
    const netErr = await sendViaAgentmail({
      fetchImpl: async () => { throw new Error('EAI_AGAIN'); },
      apiKey: 'k', inboxId: 'i', to: 'x@y.io'
    });
    assert.equal(netErr.ok, false);
    assert.ok(netErr.error.includes('EAI_AGAIN'));
    const nonJson = await sendViaAgentmail({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }),
      apiKey: 'k', inboxId: 'i', to: 'x@y.io'
    });
    assert.equal(nonJson.ok, false);
    assert.ok(nonJson.error.includes('500'));
  });

  test('writeDryRun persists html/txt/json under outDir/date and returns paths', () => {
    const outDir = makeTempDir({});
    const digest = renderDigest({ subscriber: BYRNE, items: [], chases: [], now: NOW, ...FROM });
    const result = writeDryRun({ outDir, now: NOW, subscriber: BYRNE, digest });
    assert.equal(result.ok, true);
    assert.equal(result.written.length, 3);
    for (const file of result.written) assert.ok(fs.existsSync(file));
    const meta = JSON.parse(fs.readFileSync(result.written[2], 'utf8'));
    assert.equal(meta.email, BYRNE.email);
    assert.ok(result.written[0].includes('2026-09-29'));
    // Identity-preserving slug: encodeURIComponent keeps @ (and +) distinct.
    assert.equal(path.basename(result.written[0]), 'd.byrne%40example.com.html');
  });

  test('distinct emails (plus-tag vs underscore variants) never share a slug', () => {
    // CodeRabbit PR #20 R1: user+tag@example.com and user_tag@example.com
    // are distinct recipients; folding both to user_tag@example.com made
    // dry-run files overwrite each other.
    const outDir = makeTempDir({});
    const digest = renderDigest({ subscriber: BYRNE, items: [], chases: [], now: NOW, ...FROM });
    const plus = writeDryRun({ outDir, now: NOW, subscriber: { ...BYRNE, email: 'user+tag@example.com' }, digest });
    const under = writeDryRun({ outDir, now: NOW, subscriber: { ...BYRNE, email: 'user_tag@example.com' }, digest });
    assert.equal(plus.ok, true);
    assert.equal(under.ok, true);
    const plusSet = new Set(plus.written);
    for (const file of under.written) assert.ok(!plusSet.has(file), `collision: ${file}`);
    assert.ok(fs.existsSync(plus.written[0]), 'plus-tag digest intact after second write');
  });
});

// ---------------------------------------------------------------------------
// pulse.js — orchestration (runPulse) + cadence guard
// ---------------------------------------------------------------------------

describe('cadenceDue', () => {
  const monday = new Date('2026-09-28T09:00:00Z');   // Mon
  const saturday = new Date('2026-10-03T09:00:00Z'); // Sat
  assert.equal(cadenceDue('daily', monday), true);
  assert.equal(cadenceDue('daily', saturday), false);
  assert.equal(cadenceDue('weekly', monday), true);
  assert.equal(cadenceDue('weekly', saturday), false);
  assert.equal(cadenceDue(undefined, monday), true);
});

describe('runPulse', () => {
  const repoRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
  const dataDir = path.join(repoRoot, 'data');

  function pulseEnv(dir, extra = {}) {
    return {
      PMO_PROJECTS_DIR: dataDir,
      PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
      PULSE_OUT_DIR: path.join(dir, 'out'),
      PULSE_DATE: '2026-09-29T09:00:00Z', // a Tuesday
      PULSE_FORCE: '1',
      ...extra
    };
  }

  test('ACCEPTANCE: dry-run renders a complete digest from data/sample-project.json', async () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({
        subscribers: [{ email: 'd.byrne@example.com', name: 'D. Byrne', projects: ['Northgate Platform Migration'], cadence: 'daily' }]
      })
    });
    const summary = await runPulse(pulseEnv(dir));
    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.sent, 0);
    assert.equal(summary.written, 3);
    assert.equal(summary.recipients, 1);
    const files = fs.readdirSync(path.join(dir, 'out', '2026-09-29'));
    const html = fs.readFileSync(path.join(dir, 'out', '2026-09-29', files.find((f) => f.endsWith('.html'))), 'utf8');
    const txt = fs.readFileSync(path.join(dir, 'out', '2026-09-29', files.find((f) => f.endsWith('.txt'))), 'utf8');
    // ≤3 ranked needs-you items (overdue activity first, then decision, then top risk)
    assert.ok(html.includes('3 things need you'));
    assert.ok(html.includes('Target architecture design'));
    assert.ok(html.includes('11 days overdue'));
    assert.ok(html.includes('Approve dual-run cloud budget'));
    assert.ok(html.includes('Legacy data quality worse than assessed'));
    // chases with days-outstanding
    assert.ok(html.includes('Chases — who owes what'));
    assert.ok(html.includes('14 days outstanding'));
    // both formats carry unsubscribe + sender identity
    assert.ok(html.includes('pulse@pocketpmo.com'));
    assert.ok(txt.includes('Reply UNSUBSCRIBE to stop'));
    assert.ok(txt.includes('PocketPMO Pulse <pulse@pocketpmo.com>'));
    assert.ok(txt.includes('Approve dual-run cloud budget'));
    assert.ok(txt.includes('11 days overdue'));
  });

  test('weekend cadence guard: daily subscriber skipped without PULSE_FORCE', async () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({ subscribers: [{ email: 'x@y.io', cadence: 'daily' }] })
    });
    const summary = await runPulse({ ...pulseEnv(dir), PULSE_DATE: '2026-10-03T09:00:00Z', PULSE_FORCE: '' });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.written, 0);
  });

  test('send path requires flag + token; dry-run writes when gate closed', async () => {
    const dir = makeTempDir({
      'subs.json': '[{"email":"x@y.io"}]'
    });
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { networkCalls += 1; return { ok: true, json: async () => ({}) }; };
    try {
      const closed = await runPulse(pulseEnv(dir, { PULSE_SEND: '', POSTMARK_SERVER_TOKEN: '' }));
      assert.equal(closed.dryRun, true);
      assert.equal(networkCalls, 0);
      const gated = await runPulse(pulseEnv(dir, { PULSE_SEND: '1', POSTMARK_SERVER_TOKEN: '' }));
      assert.equal(gated.dryRun, true);
      assert.equal(networkCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('real send with flag + token delivers via provider', async () => {
    const dir = makeTempDir({ 'subs.json': '[{"email":"x@y.io"}]' });
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ MessageID: 'mid-1' }) };
    };
    try {
      const summary = await runPulse(pulseEnv(dir, { PULSE_SEND: '1', POSTMARK_SERVER_TOKEN: 'test-token' }));
      assert.equal(summary.sent, 1);
      assert.equal(summary.written, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.headers['X-Postmark-Server-Token'], 'test-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('real send via PULSE_PROVIDER=agentmail delivers through the AgentMail client', async () => {
    const dir = makeTempDir({ 'subs.json': '[{"email":"x@y.io"}]' });
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ message_id: 'am-e2e' }) };
    };
    try {
      const summary = await runPulse(pulseEnv(dir, {
        PULSE_SEND: '1',
        PULSE_PROVIDER: 'agentmail',
        AGENTMAIL_API_KEY: 'test-key',
        AGENTMAIL_INBOX_ID: 'pulse@agentmail.to'
      }));
      assert.equal(summary.sent, 1);
      assert.equal(summary.written, 0);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes('/inboxes/pulse%40agentmail.to/messages/send'));
      assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('agentmail gate closed without creds: PULSE_SEND=1 still dry-runs', async () => {
    const dir = makeTempDir({ 'subs.json': '[{"email":"x@y.io"}]' });
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { networkCalls += 1; return { ok: true, json: async () => ({}) }; };
    try {
      const summary = await runPulse(pulseEnv(dir, {
        PULSE_SEND: '1',
        PULSE_PROVIDER: 'agentmail',
        AGENTMAIL_API_KEY: '',
        AGENTMAIL_INBOX_ID: ''
      }));
      assert.equal(summary.dryRun, true);
      assert.equal(summary.written, 3);
      assert.equal(networkCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fail-soft: malformed project files never crash the run', async () => {
    const badDir = makeTempDir({
      'good.json': JSON.stringify({ id: 'g1', name: 'Good', activities: 'not-an-array', risks: {} }),
      'broken.json': '{ invalid json',
      'null.json': 'null'
    });
    const dir = makeTempDir({ 'subs.json': '[{"email":"x@y.io"}]' });
    const summary = await runPulse({ ...pulseEnv(dir), PMO_PROJECTS_DIR: badDir });
    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, true);
    assert.ok(summary.written > 0);
    assert.ok(summary.warnings.length >= 2); // malformed files reported
  });

  test('lazy load: skipped-only runs never touch the projects directory', async () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({ subscribers: [{ email: 'x@y.io', cadence: 'daily' }] })
    });
    // PMO_PROJECTS_DIR does not exist — a scan would record a fatal and
    // produce per-subscriber errors. The cadence guard (Saturday, no
    // PULSE_FORCE) must skip before any scan happens.
    const summary = await runPulse({
      ...pulseEnv(dir),
      PMO_PROJECTS_DIR: '/nonexistent/pulse-projects-dir',
      PULSE_DATE: '2026-10-03T09:00:00Z', // Saturday
      PULSE_FORCE: ''
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.errors.length, 0);
    assert.equal(summary.written, 0);
  });

  test('cached load: two due subscribers produce one scan; fatal dir errors per subscriber', async () => {
    const dir = makeTempDir({
      'subs.json': JSON.stringify({
        subscribers: [
          { email: 'a@x.io', cadence: 'daily' },
          { email: 'b@x.io', cadence: 'daily' }
        ]
      })
    });
    const summary = await runPulse({
      ...pulseEnv(dir),
      PMO_PROJECTS_DIR: '/nonexistent/pulse-projects-dir',
      PULSE_FORCE: '1'
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.recipients, 2);
    // One cached load, fatal preserved per subscriber: both recipients get
    // an error entry, neither crashes the run, nothing is written.
    assert.equal(summary.errors.length, 2);
    assert.ok(summary.errors.every((e) => e.includes('not readable')));
    assert.equal(summary.written, 0);
  });

  test('unreadable roster: ok=false so cron observability catches it', async () => {
    const summary = await runPulse(pulseEnv(makeTempDir({}), { PULSE_SUBSCRIPTIONS: '/nonexistent/subs.json' }));
    assert.equal(summary.ok, false);
    assert.ok(summary.error);
  });

  test('CLI smoke: node pulse.js exits 0, writes dry-run files, prints summary', () => {
    const dir = makeTempDir({ 'subs.json': '[{"email":"smoke@x.io","name":"Smoke"}]' });
    const out = path.join(dir, 'cli-out');
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [path.join(repoRoot, 'pulse.js')], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PMO_PROJECTS_DIR: dataDir,
          PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
          PULSE_OUT_DIR: out,
          PULSE_DATE: '2026-09-29T09:00:00Z',
          PULSE_FORCE: '1'
        },
        encoding: 'utf8'
      });
    } catch (err) {
      assert.fail(`pulse.js exited non-zero: ${err.message}\n${err.stderr || ''}`);
    }
    const summary = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.sent, 0);
    assert.ok(fs.existsSync(path.join(out, '2026-09-29', 'smoke%40x.io.html')));
  });
});
