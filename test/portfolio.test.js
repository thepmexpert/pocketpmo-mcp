import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portfolioRollup, createPortfolioFold } from '../lib/portfolio.js';
import { loadAllProjects } from '../lib/projects.js';
import { handleRequest } from '../server.js';

// portfolio_rollup is BRIDGE-ORIGINAL functionality: the app is
// single-project, so there is no app calculator to mirror. The lib layer
// reuses the app-mirrored calculators (pertStats, evmMetrics) and the
// tool layer does only IO. Rounding discipline: full precision through
// the pipeline, one rounding per reported value.

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

const projA = {
  id: 'pa',
  name: 'alpha',
  startDate: '2026-01-01',
  endDate: '2026-01-11',
  budget: 1000,
  activities: [
    { id: 'a1', duration: 10 },
    { id: 'a2', duration: 20 }
  ],
  evmData: {
    milestones: [{ id: 'm1', percentage: 40, cost: 380, progress: 1 }]
  }
};
const projB = {
  id: 'pb',
  name: 'beta',
  budget: 2000,
  activities: [{ id: 'b1', duration: 4 }],
  evmData: {}
};
const projC = { id: 'pc', name: 'gamma', activities: [] };

describe('portfolioRollup (lib)', () => {
  const r = portfolioRollup([projA, projB, projC], { statusDate: '2026-01-06' });

  test('pert totals are raw sums rounded once at the portfolio boundary', () => {
    // a1 (7,10,15): e=62/6 v=64/36; a2 (14,20,30): e=124/6 v=256/36;
    // b1 (2.8,4,6): e=24.8/6 v=10.24/36 — computed from first principles.
    const expTotal = 62 / 6 + 124 / 6 + 24.8 / 6;
    const varTotal = 64 / 36 + 256 / 36 + 10.24 / 36;
    assert.equal(r.pert.totalExpected, r2(expTotal));
    assert.equal(r.pert.totalVariance, r2(varTotal));
    assert.equal(r.pert.totalStdDev, r2(Math.sqrt(varTotal)));
    assert.equal(r.pert.projectCount, 2);
    assert.equal(r.pert.activityCount, 3);
  });

  test('per-project rows carry their own once-rounded stats', () => {
    const row = r.projects.find((p) => p.id === 'pa');
    assert.equal(row.pert.expected, 31); // (62+124)/6 = 31 exactly
  });

  test('pert.activityCount counts only ANALYZABLE activities (sums match counts)', () => {
    // cubic round 2: excluded activities must not inflate the aggregate
    // count — the count describes the inputs of the sums.
    const rmix = portfolioRollup(
      [{ id: 'pm', name: 'mixed', activities: [{ id: 'm1', duration: 6 }, { id: 'm2' }] }],
      {}
    );
    assert.equal(rmix.pert.projectCount, 1);
    assert.equal(rmix.pert.activityCount, 1);
    assert.deepEqual(rmix.pert.skippedActivities, [{ project: 'pm', ids: ['m2'] }]);
  });

  test('name-only projects stay identifiable in skip reports', () => {
    // cubic round 2: a project without an id must not collapse to null in
    // skip reports — fall back to its name. Needs a second, analyzable
    // project so the pert aggregate (and its skip report) exists at all.
    const r = portfolioRollup(
      [
        { id: 'p1', name: 'valid-one', activities: [{ id: 'v1', duration: 6 }] },
        { name: 'gamma-only', activities: [] }
      ],
      {}
    );
    assert.deepEqual(r.pert.skippedProjects, [
      { project: 'gamma-only', reason: 'no activities' }
    ]);
  });

  test('project with no activities: pert null + reason, never silent', () => {
    const row = r.projects.find((p) => p.id === 'pc');
    assert.equal(row.pert, null);
    assert.match(row.pertSkipReason, /no activities/);
  });

  test('evm aggregates sums of project values; indices computed from the sums', () => {
    assert.equal(r.evm.budgetAtComplete, 3000);
    // alpha: EV = 40% of 1000 = 400, AC = 380; beta: no milestones, EV=AC=0.
    assert.equal(r.evm.earnedValue, 400);
    assert.equal(r.evm.actualCost, 380);
    assert.equal(r.evm.cpi, r4(400 / 380));
    assert.equal(r.evm.cpi, 1.0526);
    assert.equal(r.evm.projectCount, 2);
  });

  test('project without EVM data: evm null + reason, never silent', () => {
    const row = r.projects.find((p) => p.id === 'pc');
    assert.equal(row.evm, null);
    assert.match(row.evmSkipReason, /no EVM data/);
  });

  test('zero analyzable projects -> null aggregates, never fake zeros', () => {
    const r0 = portfolioRollup([projC], { statusDate: '2026-01-06' });
    assert.equal(r0.pert, null);
    assert.equal(r0.evm, null);
  });

  test('one as-of date per fold — the default resolves ONCE at fold creation', (t) => {
    // cubic round 5: the statusDate default used to be evaluated per
    // project (inside evmMetrics), so a scan crossing UTC midnight mixed
    // as-of dates within one portfolio. Mock the clock: fold created
    // 2026-01-15T23:59Z, project added after midnight — its EVM must use
    // the fold's date (PV ≈ 466.67), not the new day's (500).
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(new Date('2026-01-15T23:59:59Z').getTime());
    const fold = createPortfolioFold({});
    t.mock.timers.setTime(new Date('2026-01-16T00:30:00Z').getTime());
    fold.add({
      id: 'pdate',
      name: 'straddler',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      budget: 1000,
      activities: [{ id: 's1', duration: 5 }]
    });
    const r = fold.result();
    // 14 of 30 days elapsed at the fold's as-of -> 1000 * 14/30
    assert.equal(r.projects[0].evm.plannedValue, r2(1000 * (14 / 30)));
  });

  test('declared-but-unsupported dependencies are counted per project row', () => {
    const rDep = portfolioRollup(
      [
        {
          id: 'pd',
          name: 'delta',
          activities: [
            { id: 'd1', duration: 3 },
            { id: 'd2', duration: 4, predecessors: [{ id: 'd1', type: 'SS' }] }
          ]
        }
      ],
      {}
    );
    assert.equal(rDep.projects[0].dependencyWarnings, 1);
  });

  test('hostile activity ids render, never leak, in pert skip reports', () => {
    // cubic round 3: skippedIds are payload data too — {"toString":null}
    // must render via the display-safe boundary like every other field.
    const r = portfolioRollup(
      [
        {
          id: 'ph',
          name: 'hostile-activity-id',
          activities: [{ id: 'ok1', duration: 6 }, { id: { toString: null } }]
        }
      ],
      {}
    );
    assert.ok(r.pert, 'mixed fixture must stay analyzable');
    assert.deepEqual(r.pert.skippedActivities, [
      { project: 'ph', ids: ['[unprintable]'] }
    ]);
    assert.equal(typeof r.projects[0].pert.skipped[0], 'string');
  });

  test('fold result() is a snapshot — mutating a response cannot poison the fold', () => {
    // cubic round 3: result() exposed the internal rows array; a caller
    // mutating one response changed every later result of the same fold.
    const fold = createPortfolioFold({});
    // One valid + one invalid activity: pert.skippedActivities then holds
    // an entry whose ids array ALIASES the internal row's skipped array.
    fold.add({
      id: 'p1',
      name: 'one',
      activities: [{ id: 'a1', duration: 4 }, { id: { toString: null } }]
    });
    const r1 = fold.result();
    r1.projects.push({ junk: true });
    r1.projects[0].dependencyWarnings = 99;
    r1.pert.totalExpected = -1;
    // CR round 4: skippedActivities ids alias the internal row arrays.
    r1.pert.skippedActivities[0].ids.push('junk');
    const r2 = fold.result();
    assert.equal(r2.projects.length, 1);
    assert.equal(r2.projects[0].dependencyWarnings, 0);
    // (o + 4m + p)/6 = (2.8 + 16 + 6)/6 = 24.8/6 = 4.1333 -> 4.13
    assert.equal(r2.pert.totalExpected, 4.13);
    assert.deepEqual(r2.pert.skippedActivities, [
      { project: 'p1', ids: ['[unprintable]'] }
    ]);
  });

  test('assumptions are stated in the payload, not just docs', () => {
    assert.ok(Array.isArray(r.assumptions) && r.assumptions.length >= 2);
    assert.ok(r.assumptions.some((a) => /independent/i.test(a)));
    assert.ok(r.assumptions.some((a) => /finish-to-start|FS/i.test(a)));
  });
});

// ---------------------------------------------------------------------------
// Tool surface (handler wiring)
// ---------------------------------------------------------------------------

function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-portfolio-test-'));
  // Register BEFORE writing: a throwing write must not leak the fresh dir.
  createdDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// Dirs are removed after the FILE's tests finish (projects.test.js
// convention): withDir may be entered several times per dir (determinism
// pins), so cleanup cannot ride withDir's finally.
const createdDirs = [];
after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // One stubborn dir must not abort the loop or fail the hook.
    }
  }
});

function withDir(dir, fn) {
  const prev = process.env.PMO_PROJECTS_DIR;
  process.env.PMO_PROJECTS_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PMO_PROJECTS_DIR;
    else process.env.PMO_PROJECTS_DIR = prev;
  }
}

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args) =>
  handleRequest(req(id, 'tools/call', { name, arguments: args }));
const payloadOf = (r) => JSON.parse(r.result.content[0].text);

describe('portfolio_rollup (tool)', () => {
  test('tools/list exposes portfolio_rollup with a description', () => {
    const r = handleRequest(req(1, 'tools/list'));
    const tool = r.result.tools.find((t) => t.name === 'portfolio_rollup');
    assert.ok(tool, 'portfolio_rollup missing from tools/list');
    assert.ok(tool.description && tool.inputSchema);
  });

  test('multi-project dir: aggregates valid projects, reports broken + duplicate files, no path leak', () => {
    const dir = makeTempDir({
      'alpha.json': JSON.stringify(projA),
      'beta.json': JSON.stringify(projB),
      // Same id as alpha: first-match-wins must not double-count it.
      'dup.json': JSON.stringify({ ...projB, name: 'dup-of-alpha', id: 'pa' }),
      'broken.json': '{not json'
    });
    const result = withDir(dir, () => call(2, 'portfolio_rollup', {}));
    const payload = payloadOf(result);
    // projectCount = parseable project entries; the malformed file is a
    // dir-level warning, not a project.
    assert.equal(payload.projectCount, 3);
    assert.equal(payload.pert.projectCount, 2);
    assert.ok(
      payload.warnings.some((w) => typeof w === 'string' && /broken/.test(w)),
      `malformed file must surface via warnings: ${JSON.stringify(payload.warnings)}`
    );
    assert.ok(
      payload.loadSkipped.some((s) => s.project === 'pa' && /duplicate id/.test(s.reason)),
      `duplicate id must be skipped and reported: ${JSON.stringify(payload.loadSkipped)}`
    );
    // Whole-payload path-leak assertion (rule: leak closure is whole-payload).
    assert.equal(
      JSON.stringify(payload).includes(dir),
      false,
      'payload must not leak the configured directory path'
    );
  });

  test('empty dir -> in-band error, generic message, no path leak', () => {
    const dir = makeTempDir({});
    const result = withDir(dir, () => call(3, 'portfolio_rollup', {}));
    assert.equal(result.result.isError, true);
    const text = result.result.content[0].text;
    assert.match(text, /no project files/);
    assert.equal(text.includes(dir), false);
  });

  test('statusDate passes through to per-project EVM (exact-value pin)', () => {
    // Vacuity fix (cubic round 2): byte-identical invocations pin nothing.
    // Pin the CONTRACT: exact EVM value at a given statusDate, and a
    // different statusDate provably changes it.
    // alpha: budget 1000, 2026-01-01 -> 2026-01-11, statusDate 01-06
    // => elapsed 5/10 => PV = 500. At endDate (01-11) => PV = 1000.
    const dir = makeTempDir({ 'alpha.json': JSON.stringify(projA) });
    const mid = withDir(dir, () => payloadOf(call(4, 'portfolio_rollup', { statusDate: '2026-01-06' })));
    assert.equal(mid.evm.plannedValue, 500);
    const end = withDir(dir, () => payloadOf(call(9, 'portfolio_rollup', { statusDate: '2026-01-11' })));
    assert.equal(end.evm.plannedValue, 1000);
  });

  test('raw hostile id never reaches the payload rows (display-safe boundary)', () => {
    // {"toString":null} is valid JSON, truthy (passes the loader's
    // id-or-name gate), and String() on it THROWS (#48). Row ids are
    // display data — they must render as strings, never leak objects.
    const hostile = { id: { toString: null }, name: 'hostile-id', activities: [{ id: 'h1', duration: 5 }] };
    const dir = makeTempDir({ 'hostile.json': JSON.stringify(hostile) });
    const payload = withDir(dir, () => payloadOf(call(10, 'portfolio_rollup', {})));
    const row = payload.projects.find((p) => p.name === 'hostile-id');
    assert.ok(row, 'hostile project row missing');
    assert.equal(typeof row.id, 'string', `row.id must render, not leak: ${JSON.stringify(row.id)}`);
    assert.equal(typeof row.name, 'string');
  });

  test('every-malformed dir: error names the skipped files, bounded, neutral label', () => {
    // cubic round 2: 'no project files' alone hides WHY. Carry a capped,
    // neutrally-labeled summary (rule: cap + pointer + neutral label).
    const dir = makeTempDir({
      'a.json': '{nope',
      'b.json': '{nope',
      'c.json': '{nope',
      'd.json': '{nope',
      'e.json': '{nope'
    });
    const result = withDir(dir, () => call(11, 'portfolio_rollup', {}));
    assert.equal(result.result.isError, true);
    const text = result.result.content[0].text;
    assert.match(text, /no project files/);
    assert.match(text, /files skipped \(invalid or unreadable\)/);
    assert.match(text, /a\.json, b\.json, c\.json/);
    assert.match(text, /\+2 more; full list via list_projects/);
    assert.equal(text.includes(dir), false);
  });

  test('same-name distinct projects are BOTH analyzed (dedupe key is id/file, never name)', () => {
    // cubic round 3: adding a name fallback to the dedupe key turned
    // first-match-wins into a duplicate-NAME rule — the loader deliberately
    // accepts name-duplicate files, so both must be analyzed.
    const x = { name: 'twin', activities: [{ id: 'x1', duration: 6 }] };
    const y = { name: 'twin', activities: [{ id: 'y1', duration: 60 }] };
    const dir = makeTempDir({ 'x.json': JSON.stringify(x), 'y.json': JSON.stringify(y) });
    const payload = withDir(dir, () => payloadOf(call(12, 'portfolio_rollup', {})));
    assert.equal(payload.projectCount, 2);
    assert.equal(payload.pert.projectCount, 2);
    assert.equal(payload.loadSkipped.length, 0);
    // x: (4.2+24+9)/6 = 6.2; y: (42+240+90)/6 = 62 -> 68.2
    assert.equal(payload.pert.totalExpected, r2(37.2 / 6 + 372 / 6));
  });

  test('a throwing analysis callback degrades to skip-and-report, never propagates', () => {
    // cubic round 3: a throw escaping loadAllProjects would skip the scan's
    // cache-eviction pass (stale entries retained). The lib converts
    // callback failures into the established skip-and-report pattern.
    const dir = makeTempDir({ 'ok.json': JSON.stringify(projA) });
    let calls = 0;
    const outcome = withDir(dir, () =>
      loadAllProjects(() => {
        calls += 1;
        throw new Error('boom');
      })
    );
    assert.equal(outcome.fatal, null, 'callback failure is not a directory fatal');
    assert.equal(outcome.count, 0);
    assert.equal(calls, 1, 'called exactly once — no retry storm');
    // cubic round 4: callback failures are their OWN class — the file
    // parsed fine, so it must not land in skippedFiles ("invalid or
    // unreadable") but in failedFiles.
    assert.deepEqual(outcome.skippedFiles, []);
    assert.deepEqual(outcome.failedFiles, ['ok.json']);
    assert.ok(
      outcome.warnings.some((w) => typeof w === 'string' && /ok\.json/.test(w)),
      `failure must be reported per file: ${JSON.stringify(outcome.warnings)}`
    );
  });

  test('an id that equals another file basename does not collide in dedupe (tagged keys)', () => {
    // CR round 4: label = project.id ?? file mixes two key namespaces —
    // a project with id 'y.json' collides with the name-only project in
    // file y.json. Tagged keys (id:... / file:...) keep them distinct.
    const a = { id: 'y.json', name: 'id-looks-like-a-filename', activities: [{ id: 'a1', duration: 6 }] };
    const b = { name: 'innocent-bystander', activities: [{ id: 'b1', duration: 60 }] };
    const dir = makeTempDir({ 'x.json': JSON.stringify(a), 'y.json': JSON.stringify(b) });
    const payload = withDir(dir, () => payloadOf(call(13, 'portfolio_rollup', {})));
    assert.equal(payload.projectCount, 2);
    assert.equal(payload.pert.projectCount, 2);
    assert.equal(payload.loadSkipped.length, 0);
    const rowB = payload.projects.find((p) => p.name === 'innocent-bystander');
    assert.ok(rowB, 'the y.json project must not be swallowed');
  });

  test('file-identity loading: a project NAMED like another project id cannot steal its row', () => {
    // Regression (cubic P1): getProject resolves by id OR name, so loading
    // beta.json's project via its id 'pb' could return alpha.json's project
    // (whose NAME is 'pb') — silently corrupting rows and totals. Portfolio
    // loading must be by FILE identity, not name re-resolution.
    const alpha = {
      id: 'pa',
      name: 'pb', // name collides with beta's id
      activities: [{ id: 'a1', duration: 10 }] // pert expected 10.333
    };
    const beta = {
      id: 'pb',
      name: 'beta',
      activities: [{ id: 'b1', duration: 100 }] // pert expected 100
    };
    const dir = makeTempDir({
      'alpha.json': JSON.stringify(alpha),
      'beta.json': JSON.stringify(beta)
    });
    const payload = withDir(dir, () => payloadOf(call(6, 'portfolio_rollup', {})));
    const rowBeta = payload.projects.find((p) => p.id === 'pb');
    assert.ok(rowBeta, 'beta row missing');
    // If alpha (10.333) had been loaded twice, beta's 103.333 would be missing.
    // beta duration 100 -> triple (70,100,150) -> expected (70+400+150)/6 = 620/6.
    assert.equal(payload.pert.totalExpected, r2(62 / 6 + 620 / 6));
    assert.equal(rowBeta.activityCount, 1);
    const rowAlpha = payload.projects.find((p) => p.id === 'pa');
    assert.equal(rowAlpha.name, 'pb', 'alpha must keep its own name');
  });

  test('unreadable directory is reported as not-readable, never as empty', () => {
    // Regression (cubic): readdir failure surfaced as the generic empty-dir
    // message, discarding the lib's own diagnostic. Point the env at a FILE
    // so readdir throws ENOTDIR deterministically.
    const filePath = path.join(makeTempDir({}), 'not-a-dir.json');
    fs.writeFileSync(filePath, '{}');
    const result = withDir(filePath, () => call(7, 'portfolio_rollup', {}));
    assert.equal(result.result.isError, true);
    const text = result.result.content[0].text;
    assert.match(text, /not readable/);
    assert.equal(text.includes(filePath), false, 'no path leak');
  });

  test('all activities PERT-invalid: pert null + reason, never fabricated zeros', () => {
    // Regression (cubic P2): an activity with no usable duration produced
    // expected: 0 rows/total contributions — the duration is UNKNOWN, not 0.
    const broken = { id: 'pz', name: 'no-durations', activities: [{ id: 'x1' }, { id: 'x2' }] };
    const r2p = portfolioRollup([broken], { statusDate: '2026-01-06' });
    const row = r2p.projects.find((p) => p.id === 'pz');
    assert.equal(row.pert, null);
    assert.match(row.pertSkipReason, /valid PERT/);
    assert.equal(r2p.pert, null, 'no analyzable pert data -> null aggregate');
  });

  test('assumptions array is a copy — mutating a response cannot poison later ones', () => {
    const first = portfolioRollup([projA], {});
    first.assumptions.push('MUTATED');
    const second = portfolioRollup([projA], {});
    assert.ok(second.assumptions.every((a) => a !== 'MUTATED'));
  });
});
