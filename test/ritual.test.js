import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSubscriptions } from '../lib/pulse/subscriptions.js';
import { buildRitualBrief, resolveRitualBriefKind, MAX_SLIPPED, MAX_DECISIONS, MAX_CHANGES } from '../lib/pulse/ritual.js';
import { renderRitualBrief } from '../lib/pulse/render-ritual.js';
import { runPulse, cadenceDue } from '../pulse.js';

const createdDirs = [];
function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-ritual-test-'));
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

// Anchor: Friday 2026-10-02, UTC midnight (calendar-anchored like pulseBody).
const FRIDAY = new Date('2026-10-02T00:00:00Z');
const MONDAY = new Date('2026-09-28T00:00:00Z');
const PM = { email: 'd.byrne@example.com', name: 'D. Byrne', cadence: 'ritual', projects: ['Northgate Platform Migration'] };

const sampleProject = JSON.parse(fs.readFileSync(new URL('../data/sample-project.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// cadence + brief-kind resolution
// ---------------------------------------------------------------------------

describe('ritual cadence guard', () => {
  test('ritual is due Monday and Friday only', () => {
    assert.equal(cadenceDue('ritual', new Date('2026-09-28T00:00:00Z')), true);  // Mon
    assert.equal(cadenceDue('ritual', new Date('2026-10-02T00:00:00Z')), true);  // Fri
    assert.equal(cadenceDue('ritual', new Date('2026-09-29T00:00:00Z')), false); // Tue
    assert.equal(cadenceDue('ritual', new Date('2026-09-27T00:00:00Z')), false); // Sun
  });

  test('subscriptions loader accepts cadence "ritual"', () => {
    const dir = makeTempDir({ 'subs.json': '{"subscribers":[{"email":"r@x.io","cadence":"ritual"}]}' });
    const { subscribers, warnings, error } = loadSubscriptions(path.join(dir, 'subs.json'));
    assert.equal(error, null);
    assert.deepEqual(warnings, []);
    assert.equal(subscribers[0].cadence, 'ritual');
  });
});

describe('resolveRitualBriefKind', () => {
  test('Monday → monday, Friday → friday', () => {
    assert.equal(resolveRitualBriefKind({}, MONDAY).kind, 'monday');
    assert.equal(resolveRitualBriefKind({}, FRIDAY).kind, 'friday');
  });
  test('PULSE_BRIEF overrides any weekday', () => {
    assert.equal(resolveRitualBriefKind({ PULSE_BRIEF: 'friday' }, MONDAY).kind, 'friday');
    assert.equal(resolveRitualBriefKind({ PULSE_BRIEF: 'Monday' }, FRIDAY).kind, 'monday');
    assert.equal(resolveRitualBriefKind({ PULSE_BRIEF: 'Monday' }, FRIDAY).warning, null);
  });
  test('invalid PULSE_BRIEF warns and falls back to weekday default', () => {
    const resolved = resolveRitualBriefKind({ PULSE_BRIEF: 'wedsday' }, FRIDAY);
    assert.equal(resolved.kind, 'friday');
    assert.match(resolved.warning, /invalid PULSE_BRIEF/);
  });
  test('forced run on a non-ritual day defaults to monday', () => {
    assert.equal(resolveRitualBriefKind({}, new Date('2026-09-30T00:00:00Z')).kind, 'monday');
  });
});

// ---------------------------------------------------------------------------
// Monday brief — what slipped + decisions you owe
// ---------------------------------------------------------------------------

describe('monday brief content', () => {
  const brief = buildRitualBrief({ subscriber: PM, projects: [sampleProject], now: MONDAY, kind: 'monday' });

  test('slipped lists overdue work with owner, mine flag, and days', () => {
    // sample project at 2026-09-28: only a2 (due 2026-09-18) is past due —
    // a3/a4/milestones are all future-dated.
    assert.equal(brief.slipped.length, 1);
    assert.equal(brief.slipped[0].title, 'Target architecture design');
    assert.equal(brief.slipped[0].days, 10);
    assert.equal(brief.slipped[0].owner, 'D. Byrne');
    assert.equal(brief.slipped[0].mine, true);
  });

  test('others\u2019 overdue work appears in the ritual view, flagged not-mine', () => {
    const withPriyaSlip = {
      ...sampleProject,
      activities: [
        ...sampleProject.activities,
        { id: 'a3x', name: 'Slipped on Priya', status: 'in_progress', owner: 'Priya N.', dueDate: '2026-09-25' }
      ]
    };
    const brief = buildRitualBrief({ subscriber: PM, projects: [withPriyaSlip], now: MONDAY, kind: 'monday' });
    const priya = brief.slipped.find((s) => s.owner === 'Priya N.');
    assert.ok(priya, 'others\u2019 overdue work appears in the ritual view');
    assert.equal(priya.mine, false);
    assert.equal(priya.days, 3);
  });

  test('slipped excludes closed items', () => {
    assert.ok(!brief.slipped.some((s) => s.title === 'Discovery & requirements')); // done
  });

  test('decisions you owe = pending decisions owned by the recipient', () => {
    const titles = brief.decisions.map((d) => d.title);
    assert.ok(titles.includes('Approve dual-run cloud budget through October'));
    assert.ok(!titles.includes('Pick UAT defect triage cadence')); // done
    const decision = brief.decisions.find((d) => d.title === 'Approve dual-run cloud budget through October');
    assert.equal(decision.days, 6); // requestedOn 2026-09-22 → 2026-09-28
  });

  test('monday brief carries no friday-only sections', () => {
    assert.deepEqual(brief.drafts, []);
    assert.deepEqual(brief.changes, []);
    assert.equal(brief.changedTotal, 0);
  });

  test('slipped and decisions respect caps', () => {
    const noisy = {
      ...sampleProject,
      name: 'Northgate Platform Migration',
      activities: Array.from({ length: MAX_SLIPPED + 5 }, (_, i) => ({
        id: `x${i}`, name: `Activity ${i}`, status: 'in_progress',
        owner: 'Priya N.', dueDate: '2026-09-01'
      }))
    };
    const capped = buildRitualBrief({ subscriber: PM, projects: [noisy], now: MONDAY, kind: 'monday' });
    assert.equal(capped.slipped.length, MAX_SLIPPED);
    assert.equal(capped.slippedTotal, MAX_SLIPPED + 5);
    const noisyDecisions = {
      ...sampleProject,
      name: 'Northgate Platform Migration',
      decisions: Array.from({ length: MAX_DECISIONS + 3 }, (_, i) => ({
        id: `d${i}`, title: `Decision ${i}`, status: 'pending', owner: 'D. Byrne'
      }))
    };
    const cappedDecisions = buildRitualBrief({ subscriber: PM, projects: [noisyDecisions], now: MONDAY, kind: 'monday' });
    assert.equal(cappedDecisions.decisions.length, MAX_DECISIONS);
    assert.equal(cappedDecisions.decisionsTotal, MAX_DECISIONS + 3);
  });
});

// ---------------------------------------------------------------------------
// Friday brief — status draft + changes since last week
// ---------------------------------------------------------------------------

describe('friday brief content', () => {
  const brief = buildRitualBrief({ subscriber: PM, projects: [sampleProject], now: FRIDAY, kind: 'friday' });

  test('one factual paste-ready draft per referenced project', () => {
    assert.equal(brief.drafts.length, 1);
    const draft = brief.drafts[0];
    assert.equal(draft.projectName, 'Northgate Platform Migration');
    assert.match(draft.text, /Northgate Platform Migration — 42% complete\./);
    assert.match(draft.text, /overdue/);
    assert.match(draft.text, /Top risk: "Legacy data quality worse than assessed" \(probability 4 × impact 4/);
  });

  test('draft omits unreported fields instead of inventing them', () => {
    const quiet = {
      id: 7, name: 'Northgate Platform Migration', status: 'active',
      activities: [], risks: [], decisions: [], evmData: {}
    };
    const drafts = buildRitualBrief({ subscriber: PM, projects: [quiet], now: FRIDAY, kind: 'friday' }).drafts;
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].text, /progress not reported in the export\./);
    assert.match(drafts[0].text, /Nothing overdue\./);
    assert.ok(!drafts[0].text.includes('Top risk'));
    assert.ok(!drafts[0].text.includes('Next due'));
  });

  test('null or blank progress is "not reported", never a false 0%', () => {
    for (const progress of [null, '', '   ']) {
      const p = {
        id: 8, name: 'Northgate Platform Migration', status: 'active',
        progress, activities: [], risks: [], decisions: [], evmData: {}
      };
      const drafts = buildRitualBrief({ subscriber: PM, projects: [p], now: FRIDAY, kind: 'friday' }).drafts;
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].progress, null);
      assert.match(drafts[0].text, /progress not reported in the export\./);
      assert.ok(!drafts[0].text.includes('0% complete'));
    }
    // An explicit numeric 0 is a true headline and must still render.
    const zero = {
      id: 10, name: 'Northgate Platform Migration', status: 'active',
      progress: 0, activities: [], risks: [], decisions: [], evmData: {}
    };
    const zeroDraft = buildRitualBrief({ subscriber: PM, projects: [zero], now: FRIDAY, kind: 'friday' }).drafts[0];
    assert.match(zeroDraft.text, /Northgate Platform Migration — 0% complete\./);
  });

  test('non-primitive progress (hostile toString, plain object) fails soft', () => {
    // pulse.js retains only numeric/string progress at the collectProjects
    // boundary; buildStatusDraft must hold the same line for direct callers.
    for (const progress of [
      { toString() { throw new Error('boom'); } },
      {}, [42], true
    ]) {
      const p = {
        id: 12, name: 'Northgate Platform Migration', status: 'active',
        progress, activities: [], risks: [], decisions: [], evmData: {}
      };
      const drafts = buildRitualBrief({ subscriber: PM, projects: [p], now: FRIDAY, kind: 'friday' }).drafts;
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].progress, null);
      assert.match(drafts[0].text, /progress not reported in the export\./);
    }
  });

  test('changes window captures items that came due in the last 7 days', () => {
    // a2 due 2026-09-18 is outside [2026-09-26..2026-10-02]; a3 due 2026-09-25 too.
    // Feed a project with in-window dates instead:
    const project = {
      id: 9, name: 'Northgate Platform Migration', status: 'active',
      activities: [
        { id: 'w1', name: 'Came due still open', status: 'in_progress', owner: 'Priya N.', dueDate: '2026-09-30' },
        { id: 'w2', name: 'Came due and closed', status: 'done', owner: 'D. Byrne', dueDate: '2026-09-28' },
        { id: 'w3', name: 'Due long ago', status: 'in_progress', owner: 'D. Byrne', dueDate: '2026-08-01' },
        { id: 'w4', name: 'Due tomorrow', status: 'in_progress', owner: 'D. Byrne', dueDate: '2026-10-03' }
      ],
      decisions: [
        { id: 'wd', title: 'Raised this week', status: 'pending', owner: 'D. Byrne', requestedOn: '2026-09-29' },
        { id: 'wd2', title: 'Raised last month', status: 'pending', owner: 'D. Byrne', requestedOn: '2026-09-01' }
      ],
      risks: [], evmData: {}
    };
    const changes = buildRitualBrief({ subscriber: PM, projects: [project], now: FRIDAY, kind: 'friday' }).changes;
    const titles = changes.map((c) => c.title);
    assert.ok(titles.includes('Came due still open'));
    assert.ok(titles.includes('Came due and closed'));
    assert.ok(titles.includes('Raised this week'));
    assert.ok(!titles.includes('Due long ago'));
    assert.ok(!titles.includes('Due tomorrow'));
    assert.ok(!titles.includes('Raised last month'));
    const open = changes.find((c) => c.title === 'Came due still open');
    assert.equal(open.open, true);
    assert.equal(open.kind, 'came-due');
    const closed = changes.find((c) => c.title === 'Came due and closed');
    assert.equal(closed.open, false);
  });

  test('milestone with progress >= 1 in window is not "still open"', () => {
    // The fraction-progress completion rule (needs.js, slippedItem) must also
    // govern the change list, or the Friday brief contradicts its own drafts.
    const project = {
      id: 10, name: 'Northgate Platform Migration', status: 'active',
      activities: [], decisions: [], risks: [],
      evmData: {
        milestones: [
          { id: 'm1', name: 'Completed milestone came due', status: 'in_progress', progress: 1, dueDate: '2026-09-30' },
          { id: 'm2', name: 'Partial milestone came due', status: 'in_progress', progress: 0.5, dueDate: '2026-09-30' }
        ]
      }
    };
    const changes = buildRitualBrief({ subscriber: PM, projects: [project], now: FRIDAY, kind: 'friday' }).changes;
    const done = changes.find((c) => c.title === 'Completed milestone came due');
    const partial = changes.find((c) => c.title === 'Partial milestone came due');
    assert.ok(done, 'completed milestone still counts as a dated change');
    assert.equal(done.open, false);
    assert.ok(partial, 'partial milestone counts as a dated change');
    assert.equal(partial.open, true);
  });

  test('updatedAt-style timestamps count as changes when present', () => {
    const project = {
      id: 11, name: 'Northgate Platform Migration', status: 'active',
      activities: [
        { id: 'u1', name: 'Recently touched', status: 'in_progress', owner: 'Priya N.', dueDate: '2026-11-01', updatedAt: '2026-09-30' },
        { id: 'u2', name: 'Old touch', status: 'in_progress', owner: 'Priya N.', dueDate: '2026-11-01', updatedAt: '2026-09-01' }
      ],
      decisions: [], risks: [], evmData: {}
    };
    const changes = buildRitualBrief({ subscriber: PM, projects: [project], now: FRIDAY, kind: 'friday' }).changes;
    const titles = changes.map((c) => c.title);
    assert.ok(titles.includes('Recently touched'));
    assert.ok(!titles.includes('Old touch'));
  });

  test('updated decisions surface via updatedAt-style timestamps too', () => {
    const project = {
      id: 12, name: 'Northgate Platform Migration', status: 'active',
      activities: [],
      decisions: [
        { id: 'd1', title: 'Recently updated decision', status: 'pending', owner: 'D. Byrne', requestedOn: '2026-08-15', updatedAt: '2026-09-30' },
        { id: 'd2', title: 'Old decision, never touched', status: 'pending', owner: 'D. Byrne', requestedOn: '2026-08-15' },
        { id: 'd3', title: 'Old touch decision', status: 'pending', owner: 'D. Byrne', requestedOn: '2026-08-15', updatedAt: '2026-09-01' }
      ],
      risks: [], evmData: {}
    };
    const changes = buildRitualBrief({ subscriber: PM, projects: [project], now: FRIDAY, kind: 'friday' }).changes;
    const updated = changes.find((c) => c.title === 'Recently updated decision');
    assert.ok(updated, 'recently updated decision should appear');
    assert.equal(updated.kind, 'updated');
    assert.equal(updated.open, true);
    const titles = changes.map((c) => c.title);
    assert.ok(!titles.includes('Old decision, never touched'));
    assert.ok(!titles.includes('Old touch decision'));
  });

  test('honest empty state when nothing changed in the window', () => {
    const quiet = { id: 13, name: 'Northgate Platform Migration', status: 'active', activities: [], decisions: [], risks: [], evmData: {} };
    const brief = buildRitualBrief({ subscriber: PM, projects: [quiet], now: FRIDAY, kind: 'friday' });
    assert.equal(brief.changes.length, 0);
    assert.equal(brief.changedTotal, 0);
  });

  test('changes respect MAX_CHANGES with total preserved', () => {
    const project = {
      id: 15, name: 'Northgate Platform Migration', status: 'active',
      activities: Array.from({ length: MAX_CHANGES + 4 }, (_, i) => ({
        id: `c${i}`, name: `Changer ${i}`, status: 'done', owner: 'D. Byrne', dueDate: '2026-09-29'
      })),
      decisions: [], risks: [], evmData: {}
    };
    const brief = buildRitualBrief({ subscriber: PM, projects: [project], now: FRIDAY, kind: 'friday' });
    assert.equal(brief.changes.length, MAX_CHANGES);
    assert.equal(brief.changedTotal, MAX_CHANGES + 4);
  });
});

// ---------------------------------------------------------------------------
// fail-soft + rendering
// ---------------------------------------------------------------------------

describe('ritual fail-soft and rendering', () => {
  test('malformed projects never throw', () => {
    const garbage = [null, undefined, 42, 'nope', { name: 7 }, { activities: 'not-an-array' }];
    // Empty project filter = all projects, so every entry reaches the
    // tolerant extractors instead of being filtered out by isReferencedProject.
    for (const kind of ['monday', 'friday']) {
      const brief = buildRitualBrief({ subscriber: { ...PM, projects: [] }, projects: garbage, now: FRIDAY, kind });
      assert.equal(brief.kind, kind);
      assert.deepEqual(brief.slipped, []);
    }
  });

  test('unknown brief kind throws (programmer error, not data error)', () => {
    assert.throws(() => buildRitualBrief({ subscriber: PM, projects: [], now: FRIDAY, kind: 'tuesday' }), /unknown brief kind/);
  });

  test('renderer: monday HTML escapes titles, both formats carry footer', () => {
    const hostile = {
      id: 17, name: 'Northgate <script>alert(1)</script>', status: 'active',
      activities: [{ id: 'h1', name: '<img src=x onerror=alert(1)>', status: 'in_progress', owner: 'D. Byrne', dueDate: '2026-09-01' }],
      decisions: [{ id: 'h2', title: "Decision with 'quotes' & <tags>", status: 'pending', owner: 'D. Byrne' }],
      risks: [], evmData: {}
    };
    const allProjects = { ...PM, projects: [] };
    const brief = buildRitualBrief({ subscriber: allProjects, projects: [hostile], now: MONDAY, kind: 'monday' });
    const { subject, html, text } = renderRitualBrief({
      brief, subscriber: allProjects, now: MONDAY, fromName: 'PocketPMO Pulse', fromEmail: 'pulse@pocketpmo.com', unsubscribeUrl: ''
    });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;img src=x'));
    assert.ok(html.includes('pulse@pocketpmo.com'));
    assert.ok(html.includes('UNSUBSCRIBE'));
    assert.ok(text.includes('UNSUBSCRIBE'));
    assert.ok(subject.includes('Monday brief'));
    assert.ok(text.includes('What slipped:'));
    assert.ok(text.includes('Decisions you owe:'));
    assert.ok(text.includes('(yours)'));
  });

  test('renderer normalizes malformed brief entries instead of throwing', () => {
    const brief = {
      kind: 'monday',
      slipped: [null, 42, { title: 'Real slip', projectName: 'P', owner: 'X', mine: false, days: 2 }],
      decisions: [undefined, 'bad', { title: 'Real decision', projectName: 'P', days: 1 }],
      drafts: [null, { projectName: 'P', text: 'draft text' }],
      changes: [7, null, { kind: 'came-due', title: 'T', projectName: 'P', dueDate: FRIDAY, open: true }],
      slippedTotal: 3,
      decisionsTotal: 3,
      changedTotal: 3
    };
    const { text } = renderRitualBrief({
      brief, subscriber: PM, now: MONDAY, fromName: 'PocketPMO Pulse', fromEmail: 'pulse@pocketpmo.com', unsubscribeUrl: ''
    });
    assert.ok(text.includes('Real slip'));
    assert.ok(text.includes('Real decision'));
  });

  test('renderer: friday includes paste-ready draft and honest empty changes', () => {
    const quiet = { id: 19, name: 'Northgate Platform Migration', status: 'active', activities: [], decisions: [], risks: [], evmData: {} };
    const brief = buildRitualBrief({ subscriber: PM, projects: [quiet], now: FRIDAY, kind: 'friday' });
    const { subject, text } = renderRitualBrief({
      brief, subscriber: PM, now: FRIDAY, fromName: 'PocketPMO Pulse', fromEmail: 'pulse@pocketpmo.com', unsubscribeUrl: ''
    });
    assert.ok(subject.includes('Friday brief'));
    assert.ok(text.includes('Status drafts — paste-ready:'));
    assert.ok(text.includes('No dated changes in the project exports over the last 7 days.'));
  });

  test('renderer: monday clean slate', () => {
    const quiet = { id: 21, name: 'Northgate Platform Migration', status: 'active', activities: [], decisions: [], risks: [], evmData: {} };
    const brief = buildRitualBrief({ subscriber: PM, projects: [quiet], now: FRIDAY, kind: 'monday' });
    const { text } = renderRitualBrief({
      brief, subscriber: PM, now: FRIDAY, fromName: 'PocketPMO Pulse', fromEmail: 'pulse@pocketpmo.com', unsubscribeUrl: ''
    });
    assert.ok(text.includes('Clean slate.'));
  });

  test('renderer: monday subject uses pre-cap totals, not capped array lengths', () => {
    const slipped = Array.from({ length: 12 }, (_, i) => ({
      title: `Slip ${i + 1}`, projectName: 'P', owner: 'X', mine: false, days: i + 1
    }));
    const brief = {
      kind: 'monday',
      slipped: slipped.slice(0, MAX_SLIPPED),
      slippedTotal: slipped.length,
      decisions: [],
      decisionsTotal: 0,
      drafts: [],
      changes: [],
      changedTotal: 0
    };
    const { subject } = renderRitualBrief({
      brief, subscriber: PM, now: MONDAY, fromName: 'PocketPMO Pulse', fromEmail: 'pulse@pocketpmo.com', unsubscribeUrl: ''
    });
    assert.ok(subject.includes('12 slipped'), subject);
    assert.ok(!subject.includes('8 slipped'), subject);
  });
});

// ---------------------------------------------------------------------------
// end-to-end runPulse with a ritual subscriber (dry-run default)
// ---------------------------------------------------------------------------

describe('runPulse ritual end-to-end', () => {
  // writeDryRun slugs recipient emails with encodeURIComponent (identity-
  // preserving across lookalike addresses), so files land as name%40domain.ext
  const slug = encodeURIComponent(PM.email).toLowerCase();

  test('Friday run writes a friday brief; Tuesday skips; forced Tuesday defaults to monday brief, PULSE_BRIEF=friday overrides', async () => {
    const dir = makeTempDir({
      'project.json': JSON.stringify(sampleProject),
      'subs.json': JSON.stringify({ subscribers: [PM] })
    });
    const baseEnv = {
      PMO_PROJECTS_DIR: dir,
      PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
      PULSE_OUT_DIR: path.join(dir, 'out')
    };

    // Friday 2026-10-02 → friday brief, written.
    const friday = await runPulse({ ...baseEnv, PULSE_DATE: '2026-10-02', PULSE_TZ: 'UTC' });
    assert.equal(friday.ok, true);
    assert.equal(friday.sent, 0);
    assert.equal(friday.written, 3);
    const fridayText = fs.readFileSync(path.join(dir, 'out', '2026-10-02', `${slug}.txt`), 'utf8');
    assert.ok(fridayText.includes('Status drafts — paste-ready:'));
    // Regression: collectProjects' bounded-retention copy must keep
    // project.progress or the paste-ready draft loses its headline fact.
    assert.ok(fridayText.includes('Northgate Platform Migration — 42% complete.'));

    // Tuesday 2026-09-29 → skipped, no output.
    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
    const tuesday = await runPulse({ ...baseEnv, PULSE_DATE: '2026-09-29', PULSE_TZ: 'UTC' });
    assert.equal(tuesday.skipped, 1);
    assert.equal(tuesday.written, 0);

    // Forced Tuesday + PULSE_BRIEF=friday → friday brief (staging override).
    const forced = await runPulse({
      ...baseEnv, PULSE_DATE: '2026-09-29', PULSE_TZ: 'UTC', PULSE_FORCE: '1', PULSE_BRIEF: 'friday'
    });
    assert.equal(forced.written, 3);
    assert.equal(forced.dryRun, true);
    const forcedText = fs.readFileSync(path.join(dir, 'out', '2026-09-29', `${slug}.txt`), 'utf8');
    assert.ok(forcedText.includes('Status drafts — paste-ready:'));

    // Forced Tuesday with no PULSE_BRIEF → weekday default (Tuesday ≠ Friday)
    // = monday brief, end-to-end.
    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
    const forcedMonday = await runPulse({
      ...baseEnv, PULSE_DATE: '2026-09-29', PULSE_TZ: 'UTC', PULSE_FORCE: '1'
    });
    assert.equal(forcedMonday.written, 3);
    const forcedMondayText = fs.readFileSync(path.join(dir, 'out', '2026-09-29', `${slug}.txt`), 'utf8');
    assert.ok(forcedMondayText.includes('What slipped:'));
    assert.ok(forcedMondayText.includes('Decisions you owe:'));
  });

  test('PULSE_FORCE must be exactly "1" — "0"/"true" do not bypass the cadence guard', async () => {
    const dir = makeTempDir({
      'project.json': JSON.stringify(sampleProject),
      'subs.json': JSON.stringify({ subscribers: [PM] })
    });
    const baseEnv = {
      PMO_PROJECTS_DIR: dir,
      PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
      PULSE_OUT_DIR: path.join(dir, 'out'),
      PULSE_DATE: '2026-09-29', // Tuesday — ritual not due
      PULSE_TZ: 'UTC'
    };
    for (const notOne of ['0', 'true', 'yes']) {
      const summary = await runPulse({ ...baseEnv, PULSE_FORCE: notOne });
      assert.equal(summary.skipped, 1, `PULSE_FORCE=${notOne} must not bypass`);
      assert.equal(summary.written, 0);
    }
  });

  test('malformed project.progress stays fail-soft: brief still written, no fabricated headline', async () => {
    // R1 (P2) regression: collectProjects copied raw progress into the
    // bounded project copy, so a malformed value rode into buildStatusDraft;
    // null coerces through Number() to 0 → a false "0% complete" headline
    // in a paste-ready draft. Primitive-only retention degrades to "not
    // reported" and the Friday brief still gets written.
    const malformed = { ...sampleProject, progress: null };
    const dir = makeTempDir({
      'project.json': JSON.stringify(malformed),
      'subs.json': JSON.stringify({ subscribers: [PM] })
    });
    const summary = await runPulse({
      PMO_PROJECTS_DIR: dir,
      PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
      PULSE_OUT_DIR: path.join(dir, 'out'),
      PULSE_DATE: '2026-10-02',
      PULSE_TZ: 'UTC'
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.written, 3);
    assert.equal(summary.errors.length, 0);
    const text = fs.readFileSync(path.join(dir, 'out', '2026-10-02', `${slug}.txt`), 'utf8');
    assert.ok(text.includes('Northgate Platform Migration — progress not reported in the export.'));
    assert.ok(!text.includes('0% complete'));
  });

  test('Monday run writes a monday brief with slipped + decisions', async () => {
    const dir = makeTempDir({
      'project.json': JSON.stringify(sampleProject),
      'subs.json': JSON.stringify({ subscribers: [PM] })
    });
    const summary = await runPulse({
      PMO_PROJECTS_DIR: dir,
      PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
      PULSE_OUT_DIR: path.join(dir, 'out'),
      PULSE_DATE: '2026-09-28',
      PULSE_TZ: 'UTC'
    });
    assert.equal(summary.written, 3);
    const text = fs.readFileSync(path.join(dir, 'out', '2026-09-28', `${slug}.txt`), 'utf8');
    assert.ok(text.includes('What slipped:'));
    assert.ok(text.includes('Decisions you owe:'));
    assert.ok(text.includes('Target architecture design'));
    assert.ok(text.includes('(yours)'));
  });

  test('ambient PULSE_BRIEF without PULSE_FORCE never overrides the weekday brief', async () => {
    // PULSE_BRIEF is a staging/forced-run override only: a production Monday
    // run with an ambient PULSE_BRIEF=friday must still write the monday brief.
    const dir = makeTempDir({
      'project.json': JSON.stringify(sampleProject),
      'subs.json': JSON.stringify({ subscribers: [PM] })
    });
    const summary = await runPulse({
      PMO_PROJECTS_DIR: dir,
      PULSE_SUBSCRIPTIONS: path.join(dir, 'subs.json'),
      PULSE_OUT_DIR: path.join(dir, 'out'),
      PULSE_DATE: '2026-09-28',
      PULSE_TZ: 'UTC',
      PULSE_BRIEF: 'friday'
    });
    assert.equal(summary.written, 3);
    const text = fs.readFileSync(path.join(dir, 'out', '2026-09-28', `${slug}.txt`), 'utf8');
    assert.ok(text.includes('What slipped:'), 'monday brief expected');
    assert.ok(!text.includes('Status drafts — paste-ready:'), 'friday brief must not leak into a production Monday run');
  });
});
