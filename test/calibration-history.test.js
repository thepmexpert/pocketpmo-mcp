// Tool-level tests for calibration_history — follows the test/server.test.js
// pattern: handleRequest against a temp PMO_PROJECTS_DIR with hand-built
// project export files.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from '../server.js';

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args) =>
  handleRequest(req(id, 'tools/call', { name, arguments: args }));

let seq = 0;
function resolved(capturedAt, errDefendable, errPromised, extra = {}) {
  seq += 1;
  return {
    id: `e${seq}`,
    weekId: `2026-W${seq}`,
    capturedAt,
    chance: 0.5,
    defendableDate: '2026-03-01',
    promisedDate: '2026-03-15',
    p80Days: 80,
    computedAt: capturedAt,
    signature: `sig-${seq}`,
    resolved: true,
    resolvedAt: capturedAt,
    actualFinishDate: '2026-04-01',
    errorDaysVsDefendable: errDefendable,
    errorDaysVsPromised: errPromised,
    ...extra
  };
}

function open(extra = {}) {
  seq += 1;
  return {
    id: `o${seq}`,
    weekId: `2026-W${seq}`,
    capturedAt: '2026-03-02T09:00:00.000Z',
    chance: 0.5,
    defendableDate: '2026-03-01',
    promisedDate: null,
    p80Days: 80,
    computedAt: '2026-03-02T09:00:00.000Z',
    signature: `sig-${seq}`,
    resolved: false,
    ...extra
  };
}

// Hand-computed trail fixtures (same numbers as test/calibration.test.js):
// READY: defendable errors +5,+3,+7,+1 -> mean 4 -> optimistic;
//        promised errors +8,+2,+10,+4 -> mean 6 -> optimistic.
function readyProject() {
  return {
    id: 'c1',
    name: 'Calibrated Cafe',
    activities: [],
    calibrationTrail: [
      resolved('2026-01-05T09:00:00.000Z', 5, 8),
      resolved('2026-01-12T09:00:00.000Z', 3, 2),
      resolved('2026-01-19T09:00:00.000Z', 7, 10),
      resolved('2026-01-26T09:00:00.000Z', 1, 4),
      open()
    ]
  };
}

// INSUFFICIENT: 2 usable resolved entries.
function insufficientProject() {
  return {
    id: 'c2',
    name: 'Thin Trail Tweed',
    activities: [],
    calibrationTrail: [
      resolved('2026-02-02T09:00:00.000Z', 5, 5),
      resolved('2026-02-09T09:00:00.000Z', 7, 7)
    ]
  };
}

// NO TRAIL: an export that predates the calibration trail entirely.
function noTrailProject() {
  return { id: 'c3', name: 'Fresh Fen', activities: [] };
}

function withProjectsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-calib-'));
  fs.writeFileSync(path.join(dir, 'c1.json'), JSON.stringify(readyProject()));
  fs.writeFileSync(path.join(dir, 'c2.json'), JSON.stringify(insufficientProject()));
  fs.writeFileSync(path.join(dir, 'c3.json'), JSON.stringify(noTrailProject()));
  const prev = process.env.PMO_PROJECTS_DIR;
  process.env.PMO_PROJECTS_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PMO_PROJECTS_DIR;
    else process.env.PMO_PROJECTS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('tools/list', () => {
  test('calibration_history is declared with read-only annotations and optional projectId', () => {
    const r = handleRequest(req(41, 'tools/list'));
    const t = r.result.tools.find((tool) => tool.name === 'calibration_history');
    assert.ok(t, 'calibration_history must be listed');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.deepEqual(t.inputSchema.required, undefined);
    assert.ok(t.inputSchema.properties.projectId);
    // do-not-claim fence: no accuracy-score/percentile claims in the description
    assert.ok(!/accuracy score|percentile/i.test(t.description));
    assert.match(t.description, /coaching/);
    assert.match(t.description, /insufficient_data/);
  });
});

describe('calibration_history — discovery mode (no projectId)', () => {
  test('returns one status row per project across the repository', () => {
    withProjectsDir(() => {
      const r = call(42, 'calibration_history', {});
      assert.equal(r.result.isError, false);
      const payload = JSON.parse(r.result.content[0].text);
      assert.equal(payload.projects.length, 3);
      assert.equal(payload.read_only, true);
      const byId = Object.fromEntries(payload.projects.map((p) => [p.id, p]));
      assert.deepEqual(byId.c1, {
        id: 'c1',
        name: 'Calibrated Cafe',
        file: 'c1.json',
        status: 'ready',
        resolvedCount: 4,
        openCount: 1,
        excludedCount: 0
      });
      assert.equal(byId.c2.status, 'insufficient_data');
      assert.equal(byId.c2.resolvedCount, 2);
      assert.equal(byId.c3.status, 'no_trail');
      assert.equal(byId.c3.resolvedCount, 0);
      assert.deepEqual(payload.loadSkipped, []);
    });
  });

  test('empty projects dir yields an honest empty payload, never an error', () => {
    withProjectsDir((dir) => {
      // remove the seeded fixtures: directory now exists but has no exports
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      const r = call(47, 'calibration_history', {});
      assert.equal(r.result.isError, false);
      const payload = JSON.parse(r.result.content[0].text);
      assert.deepEqual(payload.projects, []);
      assert.deepEqual(payload.loadSkipped, []);
      assert.equal(payload.read_only, true);
    });
  });

  test('displayString hygiene: a truthy non-string name cannot leak a raw object', () => {
    withProjectsDir((dir) => {
      // hand-edited file with an object where a string belongs (the class
      // list_projects already hardened against in CR round 5 on #13)
      const p = noTrailProject();
      p.name = { toString: null, evil: true };
      fs.writeFileSync(path.join(dir, 'weird.json'), JSON.stringify(p));
      const r = call(48, 'calibration_history', {});
      const payload = JSON.parse(r.result.content[0].text);
      const row = payload.projects.find((x) => x.file === 'weird.json');
      assert.ok(typeof row.name === 'string', `name must be a string, got ${typeof row.name}`);
      assert.ok(!row.name.includes('evil'));
    });
  });

  test('malformed neighbors are skipped and reported, never breaking good rows', () => {
    withProjectsDir((dir) => {
      fs.writeFileSync(path.join(dir, 'torn.json'), '{ torn');
      const r = call(43, 'calibration_history', {});
      const payload = JSON.parse(r.result.content[0].text);
      assert.equal(payload.projects.length, 3);
      assert.ok(payload.projects.every((p) => p.id !== null));
      assert.ok(payload.loadSkipped.some((s) => s.file === 'torn.json'));
      assert.ok(payload.warnings.some((w) => w.includes('torn.json')));
    });
  });
});

describe('calibration_history — single project', () => {
  test('ready project: full record with bias, series stats, newest-first entries', () => {
    withProjectsDir(() => {
      const r = call(44, 'calibration_history', { projectId: 'c1' });
      assert.equal(r.result.isError, false);
      const p = JSON.parse(r.result.content[0].text);
      assert.equal(p.id, 'c1');
      assert.equal(p.status, 'ready');
      assert.equal(p.read_only, true);
      assert.equal(p.trailSummary.resolvedCount, 4);
      assert.equal(p.trailSummary.openCount, 1);
      assert.equal(p.trailSummary.excludedCount, 0);
      // (5+3+7+1)/4 = 4 -> optimistic
      assert.equal(p.series.defendable.meanSignedErrorDays, 4);
      assert.equal(p.series.defendable.bias, 'runs optimistic (finishes late)');
      // (8+2+10+4)/4 = 6 -> optimistic
      assert.equal(p.series.promised.meanSignedErrorDays, 6);
      assert.equal(p.series.promised.meanAbsoluteErrorDays, 6);
      assert.ok(p.series.defendable.precisionTrend);
      assert.equal(p.entries.length, 4);
      assert.deepEqual(
        p.entries.map((e) => e.capturedAt),
        [
          '2026-01-26T09:00:00.000Z',
          '2026-01-19T09:00:00.000Z',
          '2026-01-12T09:00:00.000Z',
          '2026-01-05T09:00:00.000Z'
        ]
      );
      assert.equal(p.entryCap, 20);
      assert.equal(p.entriesTruncated, false);
    });
  });

  test('insufficient project: explicit reason, no series, no fabricated numbers', () => {
    withProjectsDir(() => {
      const p = JSON.parse(call(45, 'calibration_history', { projectId: 'c2' }).result.content[0].text);
      assert.equal(p.status, 'insufficient_data');
      assert.equal(p.reason, 'Only 2 of 3 required resolved entries have an actual finish date.');
      assert.equal(p.usableCount, 2);
      assert.equal(p.neededMin, 3);
      assert.equal(p.series, undefined);
      assert.equal(p.entries, undefined);
    });
  });

  test('project with no trail key: honest no_trail state, never an error', () => {
    withProjectsDir(() => {
      const r = call(46, 'calibration_history', { projectId: 'c3' });
      assert.equal(r.result.isError, false);
      const p = JSON.parse(r.result.content[0].text);
      assert.equal(p.status, 'no_trail');
      assert.equal(p.trailSummary.status, 'no_trail');
      assert.equal(p.series, undefined);
    });
  });

  test('unknown id uses the existing per-project error convention', () => {
    withProjectsDir(() => {
      const r = call(47, 'calibration_history', { projectId: 'ghost' });
      assert.equal(r.result.isError, true);
      const text = r.result.content[0].text;
      assert.match(text, /^no project matching 'ghost'/);
      assert.ok(text.includes('Available:'));
    });
  });

  test('name lookup works like every other per-project tool', () => {
    withProjectsDir(() => {
      const p = JSON.parse(call(48, 'calibration_history', { projectId: 'calibrated cafe' }).result.content[0].text);
      assert.equal(p.status, 'ready');
    });
  });

  test('non-string projectId -> field+type error naming the parameter', () => {
    withProjectsDir(() => {
      const r = call(49, 'calibration_history', { projectId: { evil: true } });
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /invalid parameter 'projectId': expected a string, received object/);
    });
  });

  test('malformed neighbor does not break a good project\u2019s full record', () => {
    withProjectsDir((dir) => {
      fs.writeFileSync(path.join(dir, 'aaa-torn.json'), '{ torn');
      const r = call(50, 'calibration_history', { projectId: 'c1' });
      assert.equal(r.result.isError, false);
      assert.equal(JSON.parse(r.result.content[0].text).status, 'ready');
    });
  });

  test('bundled sample project (predates the trail) reads as no_trail over ./data', () => {
    const prevDir = process.env.PMO_PROJECTS_DIR;
    const origCwd = process.cwd();
    try {
      delete process.env.PMO_PROJECTS_DIR;
      process.chdir(path.join(import.meta.dirname, '..')); // repo root, default ./data
      const r = call(51, 'calibration_history', { projectId: '101' });
      assert.equal(r.result.isError, false);
      assert.equal(JSON.parse(r.result.content[0].text).status, 'no_trail');
    } finally {
      process.chdir(origCwd);
      if (prevDir === undefined) delete process.env.PMO_PROJECTS_DIR;
      else process.env.PMO_PROJECTS_DIR = prevDir;
    }
  });
});
