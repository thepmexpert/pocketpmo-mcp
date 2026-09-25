import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portfolioRollup } from '../lib/portfolio.js';
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

  test('statusDate passes through to per-project EVM (deterministic pin)', () => {
    const dir = makeTempDir({ 'alpha.json': JSON.stringify(projA) });
    const a = withDir(dir, () => payloadOf(call(4, 'portfolio_rollup', { statusDate: '2026-01-06' })));
    const b = withDir(dir, () => payloadOf(call(5, 'portfolio_rollup', { statusDate: '2026-01-06' })));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.evm.plannedValue > 0, true, 'PV must be positive mid-schedule');
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
    // Mixed: one valid + one invalid stays analyzed, invalid id reported.
    const rmix = portfolioRollup(
      [{ id: 'pm', name: 'mixed', activities: [{ id: 'm1', duration: 6 }, { id: 'm2' }] }],
      {}
    );
    assert.equal(rmix.pert.projectCount, 1);
    assert.deepEqual(rmix.pert.skippedActivities, [{ project: 'pm', ids: ['m2'] }]);
  });

  test('assumptions array is a copy — mutating a response cannot poison later ones', () => {
    const first = portfolioRollup([projA], {});
    first.assumptions.push('MUTATED');
    const second = portfolioRollup([projA], {});
    assert.ok(second.assumptions.every((a) => a !== 'MUTATED'));
  });
});
