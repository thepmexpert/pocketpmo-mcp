import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpmNetwork,
  makeRng,
  buildDistributions,
  runMonteCarlo,
  evmMetrics
} from '../lib/calculators.js';

// ---------------------------------------------------------------------------
// CPM
// ---------------------------------------------------------------------------

const chain = [
  { id: 'a', name: 'A', duration: 3, predecessors: [] },
  { id: 'b', name: 'B', duration: 5, predecessors: ['a'] },
  { id: 'c', name: 'C', duration: 2, predecessors: ['b'] }
];

test('cpmNetwork: linear chain A->B->C is all-critical', () => {
  const net = cpmNetwork(structuredClone(chain));
  assert.deepEqual(
    net.activities.map((a) => [a.id, a.es, a.ef, a.float, a.critical]),
    [
      ['a', 0, 3, 0, true],
      ['b', 3, 8, 0, true],
      ['c', 8, 10, 0, true]
    ]
  );
  assert.equal(net.projectDuration, 10);
  assert.deepEqual(net.unresolved, []);
});

test('cpmNetwork: parallel branches give the shorter one float', () => {
  const acts = [
    { id: 'start', duration: 1, predecessors: [] },
    { id: 'long', duration: 10, predecessors: ['start'] },
    { id: 'short', duration: 3, predecessors: ['start'] },
    { id: 'end', duration: 1, predecessors: ['long', 'short'] }
  ];
  const net = cpmNetwork(acts);
  const byId = Object.fromEntries(net.activities.map((a) => [a.id, a]));
  assert.equal(byId.long.critical, true);
  assert.equal(byId.short.critical, false);
  assert.equal(byId.short.float, 7); // can slip 7 days
  assert.equal(net.projectDuration, 12);
});

test('cpmNetwork: independent parallel terminal activities are not all critical', () => {
  // Two unrelated terminal activities: only the longest defines the project
  // duration, so the shorter one must carry float. Terminal lf = project
  // duration, not the activity's own ef.
  const acts = [
    { id: 'A', duration: 10, predecessors: [] },
    { id: 'B', duration: 5, predecessors: [] }
  ];
  const net = cpmNetwork(acts);
  const byId = Object.fromEntries(net.activities.map((a) => [a.id, a]));
  assert.equal(byId.A.critical, true);
  assert.equal(byId.B.critical, false);
  assert.equal(byId.B.float, 5);
  assert.equal(byId.B.lf, 10); // project duration, not its own ef of 5
  assert.equal(net.projectDuration, 10);
});

test('cpmNetwork: diamond dependency', () => {
  const acts = [
    { id: 's', duration: 2, predecessors: [] },
    { id: 'l', duration: 6, predecessors: ['s'] },
    { id: 'r', duration: 4, predecessors: ['s'] },
    { id: 'j', duration: 3, predecessors: ['l', 'r'] }
  ];
  const net = cpmNetwork(acts);
  const byId = Object.fromEntries(net.activities.map((a) => [a.id, a]));
  assert.equal(byId.l.critical, true);
  assert.equal(byId.r.critical, false);
  assert.equal(net.projectDuration, 11);
});

test('cpmNetwork: non-topological input order still resolves', () => {
  const acts = [
    { id: 'c', duration: 2, predecessors: ['b'] },
    { id: 'b', duration: 5, predecessors: ['a'] },
    { id: 'a', duration: 3, predecessors: [] }
  ];
  const net = cpmNetwork(acts);
  assert.equal(net.projectDuration, 10);
  assert.equal(net.unresolved.length, 0);
});

test('cpmNetwork: unknown predecessor refs are ignored', () => {
  const acts = [{ id: 'x', duration: 4, predecessors: ['ghost'] }];
  const net = cpmNetwork(acts);
  assert.equal(net.projectDuration, 4);
});

test('cpmNetwork: empty / non-array input is safe', () => {
  assert.deepEqual(cpmNetwork([]).activities, []);
  assert.deepEqual(cpmNetwork(null).activities, []);
});

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

test('makeRng: seeded rng is reproducible', () => {
  const a = makeRng(7);
  const b = makeRng(7);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('makeRng: different seeds diverge', () => {
  const a = makeRng(1);
  const b = makeRng(2);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.notDeepEqual(seqA, seqB);
});

test('buildDistributions: defaults triangular around base duration', () => {
  const d = buildDistributions([{ id: 'x', duration: 10 }]);
  assert.deepEqual(d.x, {
    type: 'triangular',
    optimistic: 7,
    mostLikely: 10,
    pessimistic: 15,
    mean: 10,
    stdDev: 2
  });
});

test('buildDistributions: explicit distribution fields honoured', () => {
  const d = buildDistributions([
    { id: 'x', duration: 10, distribution: { min: 4, mode: 6, max: 20 } }
  ]);
  assert.equal(d.x.optimistic, 4);
  assert.equal(d.x.mostLikely, 6);
  assert.equal(d.x.pessimistic, 20);
});

test('runMonteCarlo: deterministic with same seed', () => {
  const acts = structuredClone(chain);
  const r1 = runMonteCarlo({ activities: acts, iterations: 300, rng: makeRng(99) });
  const r2 = runMonteCarlo({ activities: acts, iterations: 300, rng: makeRng(99) });
  assert.deepEqual(r1, r2);
});

test('runMonteCarlo: percentiles are monotonic and sane', () => {
  const r = runMonteCarlo({ activities: structuredClone(chain), iterations: 1000 });
  assert.ok(r.percentiles.p10 <= r.percentiles.p50);
  assert.ok(r.percentiles.p50 <= r.percentiles.p90);
  // chain expected duration: (2.1+4*5+7.5)/6 + ... ~ 10; p90 should exceed it
  assert.ok(r.percentiles.p90 > r.mean);
  assert.ok(r.issues.length === 0);
});

test('runMonteCarlo: probability rises as target moves out', () => {
  const r = runMonteCarlo({
    activities: structuredClone(chain),
    iterations: 1000,
    targets: [8, 10, 12, 15]
  });
  const probs = r.probabilityByTarget.map((t) => t.probability);
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] >= probs[i - 1], `P(${i}) should be >= P(${i - 1})`);
  }
  assert.ok(probs[probs.length - 1] > 0.9); // 15 days is near-certain
});

test('runMonteCarlo: target probabilities agree with the simulated percentiles', () => {
  // probabilityByTarget must describe the SAME distribution as
  // mean/percentiles (simulated CPM durations). P(t <= p50) must be ~0.5
  // regardless of network shape — the old PERT-sum approximation (sum of
  // per-activity means/variances) ignored topology and contradicted the
  // percentiles whenever parallel paths existed.
  const acts = [
    { id: 'start', duration: 1, predecessors: [] },
    { id: 'long', duration: 10, predecessors: ['start'] },
    { id: 'short', duration: 3, predecessors: ['start'] },
    { id: 'end', duration: 1, predecessors: ['long', 'short'] }
  ];
  const first = runMonteCarlo({ activities: structuredClone(acts), iterations: 2000 });
  const p50 = first.percentiles.p50;

  // Seeded RNG → second run reproduces the same simulated durations.
  const second = runMonteCarlo({
    activities: structuredClone(acts),
    iterations: 2000,
    targets: [p50 - 0.5, p50, p50 + 0.5]
  });
  const [below, at, above] = second.probabilityByTarget.map((t) => t.probability);
  assert.ok(at > 0.4 && at < 0.6, `P(finish <= p50) should be ~0.5, got ${at}`);
  assert.ok(above > at, `P(<= p50+0.5) ${above} should exceed P(<= p50) ${at}`);
  assert.ok(below < at, `P(<= p50-0.5) ${below} should be below P(<= p50) ${at}`);
});

test('runMonteCarlo: iterations validation', () => {
  const acts = [{ id: 'a', duration: 3, predecessors: [] }];
  for (const bad of [2.5, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'abc']) {
    assert.throws(
      () => runMonteCarlo({ activities: acts, iterations: bad }),
      (e) => /positive safe integer/.test(e.message),
      `should reject ${String(bad)}`
    );
  }
  // String integer coerces and reports as a real integer.
  const coerced = runMonteCarlo({ activities: acts, iterations: '1000' });
  assert.equal(coerced.iterations, 1000);
  assert.ok(Number.isSafeInteger(coerced.iterations));
  // Max bound.
  assert.throws(
    () => runMonteCarlo({ activities: acts, iterations: 1_000_001 }),
    /positive safe integer/
  );
});

test('runMonteCarlo: the dominant branch owns the critical path', () => {
  const acts = [
    { id: 'tiny', duration: 1, predecessors: [] },
    { id: 'short', duration: 2, predecessors: ['tiny'] },
    { id: 'huge', duration: 30, predecessors: ['tiny'] },
    { id: 'end', duration: 1, predecessors: ['short', 'huge'] }
  ];
  const r = runMonteCarlo({ activities: acts, iterations: 500 });
  const byId = Object.fromEntries(r.criticalPathFrequency.map((c) => [c.id, c]));
  // Chain members (tiny, huge, end) are on every critical path; the short
  // branch is almost never critical with a 30-day giant beside it.
  assert.ok(byId.tiny.share > 0.99, `tiny always critical, got ${byId.tiny.share}`);
  assert.ok(byId.huge.share > 0.99, `huge always critical, got ${byId.huge.share}`);
  const shortShare = byId.short ? byId.short.share : 0; // absent = never critical
  assert.ok(shortShare < 0.05, `short should rarely be critical, got ${shortShare}`);
});

test('runMonteCarlo: invalid durations are reported, not silent', () => {
  const acts = [
    { id: 'ok', duration: 5, predecessors: [] },
    { id: 'bad', duration: 'nine', predecessors: [] }
  ];
  const r = runMonteCarlo({ activities: acts, iterations: 100 });
  assert.ok(r.issues.some((i) => i.activityId === 'bad' && i.field === 'duration'));
});

test('runMonteCarlo: empty activities returns zeroed result with issue', () => {
  const r = runMonteCarlo({ activities: [], iterations: 100 });
  assert.equal(r.iterations, 0);
  assert.ok(r.issues.length > 0);
});

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

const milestones = [
  { name: 'M1', percentage: 30, cost: 20000, progress: 1 },  // complete
  { name: 'M2', percentage: 40, cost: 30000, progress: 0.1 }, // in progress
  { name: 'M3', percentage: 30, cost: 20000, progress: 0 }   // not started
];

function evmOpts(over = {}) {
  return {
    budget: 100000,
    milestones,
    inProgressValue: 50,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16', // ~50% through
    ...over
  };
}

test('evmMetrics: all-complete milestones earn the full BAC', () => {
  const r = evmMetrics({
    budget: 100000,
    milestones: milestones.map((m) => ({ ...m, progress: 1 })),
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 100000);
  assert.equal(r.actualCost, 70000);
  assert.equal(r.cpi, 1.4286); // 100000/70000
});

test('evmMetrics: in-progress milestone earns 50% of its value', () => {
  const r = evmMetrics({
    budget: 100000,
    milestones: [{ percentage: 100, cost: 50000, progress: 0.1 }],
    inProgressValue: 50,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 50000);
  assert.equal(r.actualCost, 25000);
});

test('evmMetrics: over-budget actuals push CPI below 1 and EAC above BAC', () => {
  const r = evmMetrics(evmOpts());
  // EV = 30000 + 40000*0.5 = 50000; AC = 20000 + 30000*0.5 = 35000 -> CPI > 1
  assert.equal(r.earnedValue, 50000);
  assert.equal(r.actualCost, 35000);
  assert.equal(r.cpi, 1.4286);
  assert.ok(r.eac < r.budgetAtComplete);
});

test('evmMetrics: CPI<1 inflates EAC and makes VAC negative', () => {
  const r = evmMetrics(
    evmOpts({ milestones: [{ percentage: 50, cost: 90000, progress: 1 }] })
  );
  // EV = 50000, AC = 90000 -> CPI 0.5556, EAC = 100000/0.5556 = 180000
  assert.equal(r.cpi, 0.5556);
  assert.equal(r.eac, 180000);
  assert.equal(r.vac, -80000);
});

test('evmMetrics: timeline fraction clamps to [0,1]', () => {
  const r = evmMetrics(evmOpts({ statusDate: '2026-10-15' })); // after end
  assert.equal(r.timeline.actualTimePercentage, 1);
  assert.equal(r.plannedValue, 100000);
});

test('evmMetrics: missing dates -> zero timeline plus issue flag', () => {
  const r = evmMetrics(evmOpts({ startDate: null, endDate: null }));
  assert.equal(r.timeline.projectDurationDays, 0);
  assert.ok(r.issues.some((i) => i.field === 'dates'));
});

test('evmMetrics: bad budget -> zeros and issue', () => {
  const r = evmMetrics(evmOpts({ budget: 'lots' }));
  assert.equal(r.earnedValue, 0);
  assert.ok(r.issues.some((i) => i.field === 'budget'));
});
