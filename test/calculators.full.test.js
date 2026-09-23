import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpmNetwork,
  makeRng,
  buildDistributions,
  runMonteCarlo,
  evmMetrics,
  validateActivities,
  validDuration
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

test('cpmNetwork: simple cycle is reported as an explicit path', () => {
  const acts = [
    { id: 'a', duration: 3, predecessors: ['c'] },
    { id: 'b', duration: 5, predecessors: ['a'] },
    { id: 'c', duration: 2, predecessors: ['b'] },
    { id: 'd', duration: 4, predecessors: [] }
  ];
  const net = cpmNetwork(acts);
  assert.deepEqual(net.unresolved.sort(), ['a', 'b', 'c']);
  assert.equal(net.cycles.length, 1);
  const cycle = net.cycles[0];
  assert.equal(cycle[0], cycle[cycle.length - 1]); // closes on itself
  assert.deepEqual([...cycle].slice(0, -1).sort(), ['a', 'b', 'c']);
  // The cycle-free part of the network still schedules normally.
  assert.equal(net.projectDuration, 4);
  assert.deepEqual(
    net.activities.map((a) => a.id).sort(),
    ['d']
  );
});

test('cpmNetwork: activity downstream of a cycle is unresolved but not in any cycle', () => {
  const acts = [
    { id: 'a', duration: 3, predecessors: ['b'] },
    { id: 'b', duration: 5, predecessors: ['a'] },
    { id: 'c', duration: 2, predecessors: ['b'] } // depends on the cycle, not in it
  ];
  const net = cpmNetwork(acts);
  assert.deepEqual(net.unresolved.sort(), ['a', 'b', 'c']);
  assert.equal(net.cycles.length, 1);
  const cycleNodes = new Set(net.cycles[0]);
  assert.ok(cycleNodes.has('a') && cycleNodes.has('b'));
  assert.equal(cycleNodes.has('c'), false); // c is downstream, not in the loop
});

test('validateActivities: cycles surface as issues with the path', () => {
  const acts = [
    { id: 'a', duration: 3, predecessors: ['c'] },
    { id: 'b', duration: 5, predecessors: ['a'] },
    { id: 'c', duration: 2, predecessors: ['b'] }
  ];
  const issues = validateActivities(acts);
  const cycleIssues = issues.filter((i) => i.field === 'predecessors');
  assert.equal(cycleIssues.length, 1);
  assert.match(cycleIssues[0].message, /cycle detected: [abc] -> [abc] -> [abc] -> /);
});

test('cpmNetwork: Infinity duration does not poison the network', () => {
  const acts = [
    { id: 'a', duration: Infinity, predecessors: [] },
    { id: 'b', duration: 4, predecessors: ['a'] }
  ];
  const net = cpmNetwork(structuredClone(acts));
  assert.equal(net.projectDuration, 4); // not Infinity
  assert.equal(Number.isFinite(net.activities[0].lf), true);
  const issues = validateActivities(acts);
  assert.ok(
    issues.some((i) => i.activityId === 'a' && i.field === 'duration'),
    'Infinity duration must be reported as an issue'
  );
});

test('validDuration: shared policy rejects non-finite and non-positive', () => {
  assert.equal(validDuration(5), true);
  assert.equal(validDuration(0.5), true);
  assert.equal(validDuration(Infinity), false);
  assert.equal(validDuration(-Infinity), false);
  assert.equal(validDuration(Number.NaN), false);
  assert.equal(validDuration(0), false);
  assert.equal(validDuration(-5), false);
  assert.equal(validDuration('5'), false);
  assert.equal(validDuration(null), false);
});

test('cpmNetwork is pure: input objects are never mutated', () => {
  const acts = [
    { id: 'x', duration: 3, predecessors: ['y'] },
    { id: 'y', duration: 5, predecessors: ['x'] }, // cyclic -> stays unresolved
    { id: 'z', duration: 4, predecessors: [] }
  ];
  const snapshot = JSON.stringify(acts);
  const net = cpmNetwork(acts);
  assert.equal(JSON.stringify(acts), snapshot, 'cyclic input must not gain schedule fields');
  // Unresolved/cycle report still comes back; healthy component schedules.
  assert.deepEqual(net.unresolved, ['x', 'y']);
  assert.deepEqual(net.cycles, [['x', 'y', 'x']]);
  assert.equal(net.projectDuration, 4);
  const clean = [
    { id: 'a', duration: 3, predecessors: [] },
    { id: 'b', duration: 2, predecessors: ['a'] }
  ];
  const cleanSnapshot = JSON.stringify(clean);
  cpmNetwork(clean);
  assert.equal(JSON.stringify(clean), cleanSnapshot, 'acyclic input must not gain schedule fields');
  // Result activities are new objects, not the inputs.
  assert.notEqual(cpmNetwork(clean).activities[0], clean[0]);
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
  const { distributions: d, issues } = buildDistributions([{ id: 'x', duration: 10 }]);
  assert.equal(issues.length, 0);
  // mean metadata = ACTUAL triangular mean (7+10+15)/3, not the bare
  // duration (review #19) — the sampler draws from the triple.
  assert.deepEqual(d.x, {
    type: 'triangular',
    optimistic: 7,
    mostLikely: 10,
    pessimistic: 15,
    mean: 32 / 3,
    stdDev: 2
  });
});

test('buildDistributions: explicit distribution fields honoured', () => {
  const { distributions: d } = buildDistributions([
    { id: 'x', duration: 10, distribution: { min: 4, mode: 6, max: 20 } }
  ]);
  assert.equal(d.x.optimistic, 4);
  assert.equal(d.x.mostLikely, 6);
  assert.equal(d.x.pessimistic, 20);
});

test('buildDistributions: normalization repairs and reports', () => {
  const { distributions: d, issues } = buildDistributions([
    { id: 'out-of-order', duration: 10, distribution: { optimistic: 10, mostLikely: 5, pessimistic: 2 } },
    { id: 'neg-stddev', duration: 10, distribution: { stdDev: -3 } },
    { id: 'bad-type', duration: 10, distribution: { type: 'weibull' } },
    { id: 'string-coerce', duration: 10, distribution: { mostLikely: '8' } }
  ]);
  // Out-of-order triple is sorted o <= m <= p and reported; exact repaired
  // values pinned so a value-collapsing sort bug cannot pass.
  const oo = d['out-of-order'];
  assert.deepEqual([oo.optimistic, oo.mostLikely, oo.pessimistic], [2, 5, 10]);
  // Negative stdDev repaired to the default and reported.
  assert.equal(d['neg-stddev'].stdDev, 2);
  // Unknown type coerced to triangular and reported.
  assert.equal(d['bad-type'].type, 'triangular');
  // Numeric strings coerced without an issue (valid normalization).
  assert.equal(d['string-coerce'].mostLikely, 8);
  const byId = Object.fromEntries(issues.map((i) => [i.activityId, i.field]));
  assert.equal(byId['out-of-order'], 'distribution');
  assert.equal(byId['neg-stddev'], 'distribution');
  assert.equal(byId['bad-type'], 'distribution');
  assert.equal(byId['string-coerce'], undefined);
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

test('runMonteCarlo: duplicate activity ids are reported, never silent', () => {
  // Two activities share id 'a' and 'b' references 'a'. Last-write-wins map
  // resolution makes the network ambiguous; the response must carry the
  // warning instead of silently returning incoherent stats (issue #4).
  const r = runMonteCarlo({
    activities: [
      { id: 'a', duration: 3, predecessors: [] },
      { id: 'a', duration: 9, predecessors: [] },
      { id: 'b', duration: 2, predecessors: ['a'] }
    ],
    iterations: 500
  });
  const dup = r.issues.find((i) => i.field === 'id' && /duplicate/.test(i.message));
  assert.ok(dup, 'duplicate id must produce an issue, got: ' + JSON.stringify(r.issues));
  assert.equal(dup.activityId, 'a');
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

// --- Review batch 2 regressions (#19-#28) ---------------------------------

test('#19 buildDistributions: metadata mean = actual triangular mean', () => {
  const { distributions: d, issues } = buildDistributions([
    { id: 'x', duration: 10 }
  ]);
  // Default triple 7/10/15 -> actual mean 32/3, NOT the bare duration.
  assert.equal(d.x.mean, (7 + 10 + 15) / 3);
  assert.equal(issues.length, 0);
});

test('#19 buildDistributions: explicit mean disagreeing with triple is reported and ignored', () => {
  const { distributions: d, issues } = buildDistributions([
    { id: 'x', duration: 10, distribution: { optimistic: 5, mostLikely: 10, pessimistic: 15, mean: 12 } }
  ]);
  assert.equal(d.x.mean, 10); // (5+10+15)/3, NOT the configured 12
  assert.ok(
    issues.some((i) => i.activityId === 'x' && /configured mean does not apply/.test(i.message))
  );
});

test('#19 buildDistributions: normal distributions keep their configured mean', () => {
  const { distributions: d } = buildDistributions([
    { id: 'x', duration: 10, distribution: { type: 'normal', mean: 12, stdDev: 2 } }
  ]);
  assert.equal(d.x.mean, 12);
});

test('#20 runMonteCarlo: percentiles interpolate R-7 on tiny samples', () => {
  // Controllable rng: two iterations, single activity, default triangular
  // (o=0.7, m=1, p=1.5, fc=0.375). u=0.1 -> 0.7+sqrt(0.1*0.8*0.3)=0.8549;
  // u=0.9 -> 1.5-sqrt(0.1*0.8*0.5)=1.3. Sample = [0.8549, 1.3].
  // R-7 p50 = midpoint 1.0775; the old floor-index pick would return 1.3.
  const seq = [0.1, 0.9];
  const rng = () => (seq.length ? seq.shift() : 0.5);
  const acts = [{ id: 'a', duration: 1 }];
  const r = runMonteCarlo({ activities: acts, iterations: 2, rng });
  assert.equal(r.iterations, 2);
  // R-7 p50 interpolates BETWEEN the two samples (floor would give the max).
  assert.ok(r.percentiles.p50 < 1.2, `p50 ${r.percentiles.p50} should interpolate below max 1.3`);
  assert.ok(r.percentiles.p50 > 1.0, `p50 ${r.percentiles.p50} should sit above the min`);
  // Degenerate: constant chain -> any quantile equals the constant.
  const constant = [
    { id: 'a', duration: 13, distribution: { optimistic: 13, mostLikely: 13, pessimistic: 13 } }
  ];
  const rc = runMonteCarlo({ activities: constant, iterations: 4, rng: makeRng(9) });
  assert.equal(rc.percentiles.p10, 13);
  assert.equal(rc.percentiles.p50, 13);
  assert.equal(rc.percentiles.p90, 13);
});

test('#21 runMonteCarlo: criticalActivityFrequency replaces the misnamed field', () => {
  const acts = [
    { id: 'a', duration: 5 },
    { id: 'b', duration: 5, predecessors: ['a'] }
  ];
  const r = runMonteCarlo({ activities: acts, iterations: 50, rng: makeRng(42) });
  assert.ok(Array.isArray(r.criticalActivityFrequency));
  assert.ok(r.criticalActivityFrequency.length === 2);
  for (const e of r.criticalActivityFrequency) {
    assert.equal(e.share, 1); // single chain: every activity critical every run
  }
  // Deprecated alias still present and identical for old consumers.
  assert.deepEqual(r.criticalPathFrequency, r.criticalActivityFrequency);
});

test('#22 evmMetrics: inProgressValue 0 is honored, not defaulted to 50', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: 100, cost: 1000, progress: 0.1 }],
    inProgressValue: 0,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 0);
  assert.equal(r.actualCost, 0);
});

test('#22 evmMetrics: missing inProgressValue still defaults to 50', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: 100, cost: 1000, progress: 0.1 }],
    inProgressValue: undefined,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 500);
});

test('#22 evmMetrics: out-of-range inProgressValue is clamped and reported', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: 100, cost: 1000, progress: 0.1 }],
    inProgressValue: 150,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 1000); // clamped to 100%
  assert.ok(r.issues.some((i) => i.field === 'inProgressValue'));
});

test('#23 evmMetrics: string progress sentinels are normalized', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [
      { percentage: 100, cost: 100, progress: '1' },
      { percentage: 100, cost: 100, progress: '0.1' },
      { percentage: 100, cost: 100, progress: '0' }
    ],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  // 1000*1 + 1000*0.5 + 0 = 1500 EV; AC = 100*1 + 100*0.5 + 0 = 150
  // (in-progress cost is also spread by the fraction — faithful to app).
  assert.equal(r.earnedValue, 1500);
  assert.equal(r.actualCost, 150);
});

test('#23 evmMetrics: COMPLETE/IN_PROGRESS labels are normalized', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [
      { percentage: 100, cost: 100, progress: 'COMPLETE' },
      { percentage: 100, cost: 100, progress: 'IN_PROGRESS' }
    ],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 1500);
});

test('#24 evmMetrics: negative percentage and cost are clamped with issues', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: -20, cost: -500, progress: 1 }],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 0);
  assert.equal(r.actualCost, 0);
  assert.ok(r.issues.some((i) => /percentage/.test(i.message)));
  assert.ok(r.issues.some((i) => /cost/.test(i.message)));
});

test('#24 evmMetrics: percentage >100 clamps; totals over 100 are reported', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [
      { percentage: 80, cost: 100, progress: 1 },
      { percentage: 150, cost: 100, progress: 1 }
    ],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  // 80 + clamp(150->100) = 180 total: allowed, reported, EV = 1800.
  assert.equal(r.earnedValue, 1800);
  assert.ok(r.issues.some((i) => /total 180%/.test(i.message)));
  assert.ok(r.issues.some((i) => i.received === 150));
});

test('#26 evmMetrics: invalid statusDate is reported, metrics stay finite', () => {
  const r = evmMetrics(
    evmOpts({ statusDate: 'not-a-date' })
  );
  assert.ok(r.issues.some((i) => i.field === 'dates' && /statusDate/.test(i.message)));
  assert.ok(Number.isFinite(r.plannedValue));
  assert.ok(Number.isFinite(r.spi));
});

test('#27 evmMetrics: calendar-day math is DST/timezone-exact for date-only strings', () => {
  // 2026-02-28 -> 2026-03-31 spans no DST in UTC terms; 31 days either way.
  // A DST-fragile local-time implementation in a UTC- offset runtime would
  // still count days via ms/86400000 with ceil — pin the UTC answer.
  const r = evmMetrics(
    evmOpts({ startDate: '2026-02-28', endDate: '2026-03-31', statusDate: '2026-03-16' })
  );
  assert.equal(r.timeline.projectDurationDays, 31);
  assert.equal(r.timeline.elapsedDays, 16);
});

test('#27 evmMetrics: same dates give identical fractions on UTC and +13 offsets', () => {
  const args = {
    budget: 100000,
    milestones,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  };
  // UTC calendar-day invariant: 2026-09-01 -> 2026-09-30 = 29 days,
  // status at 09-16 = 15 days elapsed. round4 boundary rounding applies.
  const r = evmMetrics(args);
  assert.equal(r.timeline.projectDurationDays, 29);
  assert.equal(r.timeline.elapsedDays, 15);
  assert.ok(Math.abs(r.timeline.actualTimePercentage - 15 / 29) < 1e-4);
});

test('#28 evmMetrics: zero actual cost yields null EAC/VAC, not a fake zero', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: 50, cost: 0, progress: 0.1 }],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.eac, null);
  assert.equal(r.vac, null);
  // CPI keeps the documented 0 convention (no recorded cost).
  assert.equal(r.cpi, 0);
});

test('#28 evmMetrics: EAC numeric when costs exist', () => {
  const r = evmMetrics(evmOpts());
  assert.equal(typeof r.eac, 'number');
  assert.equal(typeof r.vac, 'number');
});

// --- Post-push bot-review sweep (PR #3 round 1) ----------------------------

test('sweep: sub-day default distribution stays ordered and sampled', () => {
  const { distributions: d } = buildDistributions([{ id: 'x', duration: 0.5 }]);
  // No 1-day floor inverting the triple: o=0.35 <= m=0.5 <= p=0.75.
  assert.ok(d.x.optimistic <= d.x.mostLikely && d.x.mostLikely <= d.x.pessimistic);
  assert.equal(d.x.optimistic, 0.35);
  const r = runMonteCarlo({
    activities: [{ id: 'x', duration: 0.5 }],
    iterations: 200,
    rng: makeRng(11)
  });
  // Sampler honors the sub-day triple; the old 1-day fallback would give
  // exactly mean 1, so the bound must exclude it.
  assert.ok(r.mean < 1, `mean ${r.mean} should reflect the 0.5-day base, not the 1-day fallback`);
  assert.ok(r.mean > 0.3, `mean ${r.mean} should stay above the optimistic bound`);
});

test('sweep: non-numeric inProgressValue reports and falls back to 50, no NaN', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: 100, cost: 1000, progress: 0.1 }],
    inProgressValue: 'half',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.ok(
    r.issues.some((i) => i.field === 'inProgressValue' && /not a usable number/.test(i.message))
  );
  assert.ok(Number.isFinite(r.earnedValue));
  assert.equal(r.earnedValue, 500); // neutral 50% fallback, not NaN
});

test('sweep: naive timestamp (no offset) is rejected with a named issue', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [],
    startDate: '2026-01-01T08:00:00', // no offset: host-TZ dependent
    endDate: '2026-01-01T16:00:00Z',
    statusDate: '2026-01-01T12:00:00Z'
  });
  assert.ok(
    r.issues.some((i) => i.field === 'dates' && /no timezone offset/.test(i.message)),
    `expected naive-timestamp issue, got: ${JSON.stringify(r.issues)}`
  );
  assert.equal(r.timeline.projectDurationDays, 0); // no TZ-dependent compute
});

test('sweep: sub-day distribution no longer fabricates an ordering violation', () => {
  const r = runMonteCarlo({
    activities: [{ id: 'a', duration: 0.5, distribution: { mostLikely: 0.4 } }],
    iterations: 50,
    rng: makeRng(3)
  });
  assert.ok(
    !r.issues.some((i) => /violate optimistic/.test(i.message)),
    `validateActivities must use the same floorless fallback as buildDistributions: ${JSON.stringify(r.issues)}`
  );
});

test('sweep: finite unrecognized progress (0.5) earns nothing AND reports', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ percentage: 100, cost: 100, progress: 0.5 }],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  assert.equal(r.earnedValue, 0);
  assert.ok(r.issues.some((i) => /progress not recognized/.test(i.message)));
});

test('sweep: null and blank milestone fields are reported, not silently zero', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [
      { percentage: null, cost: null, progress: 1 },
      { percentage: '', cost: '', progress: 1 }
    ],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    statusDate: '2026-09-16'
  });
  // 4 reportable problems (percentage + cost per milestone).
  assert.equal(r.issues.filter((i) => i.field === 'milestone').length, 4);
  assert.equal(r.earnedValue, 0);
});

test('sweep: impossible calendar date is reported, not silently rolled', () => {
  const r = evmMetrics(
    evmOpts({ statusDate: '2026-02-30' })
  );
  assert.ok(
    r.issues.some((i) => i.field === 'dates' && /impossible calendar date/.test(i.message)),
    `expected impossible-date issue, got: ${JSON.stringify(r.issues)}`
  );
  // Timeline falls back to 0 rather than pretending March 1 happened.
  assert.equal(r.timeline.elapsedDays, 0);
});

test('sweep: slash-separated date is rejected by the strict format gate', () => {
  const r = evmMetrics(
    evmOpts({ statusDate: '2026/02/30' })
  );
  // V8 parses "2026/02/30" to March 2 — must never reach the timeline.
  assert.ok(
    r.issues.some(
      (i) => i.field === 'dates' && /use YYYY-MM-DD or a timezone-qualified ISO timestamp/.test(i.message)
    ),
    `expected strict-format issue, got: ${JSON.stringify(r.issues)}`
  );
  assert.equal(r.timeline.elapsedDays, 0);
});

test('sweep: impossible date inside an offset timestamp is rejected', () => {
  const r = evmMetrics(
    evmOpts({ statusDate: '2026-02-30T10:00:00+01:00' })
  );
  assert.ok(
    r.issues.some((i) => i.field === 'dates' && /impossible calendar date/.test(i.message)),
    `expected impossible-date issue, got: ${JSON.stringify(r.issues)}`
  );
  assert.equal(r.timeline.elapsedDays, 0);
});

test('sweep: valid offset timestamp passes textual-calendar validation', () => {
  const r = evmMetrics(
    evmOpts({ statusDate: '2026-09-16T12:00:00+01:00' })
  );
  assert.ok(
    !r.issues.some((i) => i.field === 'dates'),
    `unexpected date issue on a valid offset timestamp: ${JSON.stringify(r.issues)}`
  );
});

test('sweep: same-day timestamp schedule keeps sub-day precision', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [],
    startDate: '2026-01-01T08:00:00Z',
    endDate: '2026-01-01T16:00:00Z',
    statusDate: '2026-01-01T12:00:00Z'
  });
  assert.equal(r.timeline.projectDurationDays, 8 / 24);
  assert.equal(r.timeline.actualTimePercentage, 0.5);
  assert.ok(Number.isFinite(r.plannedValue));
});

test('sweep: empty activities result exposes criticalActivityFrequency', () => {
  const r = runMonteCarlo({ activities: [], iterations: 10 });
  assert.deepEqual(r.criticalActivityFrequency, []);
  assert.deepEqual(r.criticalPathFrequency, []);
});

test('sweep: present-but-invalid distribution mean is reported', () => {
  const { issues } = buildDistributions([
    { id: 'x', duration: 10, distribution: { mean: 'soon' } }
  ]);
  assert.ok(
    issues.some((i) => i.activityId === 'x' && /mean is present but not a usable number/.test(i.message))
  );
});

// --- External review #29-#31: raw-distribution reporting + scenario gaps ---

test('#30 raw distributions: inverted triple is repaired AND reported (no silent 1-day fallback)', () => {
  // Pre-fix this sampled the 1-day fallback with zero issues: a silent
  // fallback on critical data. Now the raw path shares buildDistributions'
  // single normalization point (sort-and-report).
  const r = runMonteCarlo({
    activities: [{ id: 'a', duration: 5, predecessors: [] }],
    distributions: { a: { type: 'triangular', optimistic: 10, mostLikely: 5, pessimistic: 2 } },
    iterations: 500
  });
  assert.ok(
    r.issues.some((i) => i.field === 'distribution' && /out of order/.test(i.message)),
    'inverted raw triple must be reported, got: ' + JSON.stringify(r.issues)
  );
  // Sampled mean must reflect the SORTED triple (2,5,10 -> mean 17/3 ≈ 5.67),
  // not the 1-day fallback (old defect produced mean 1).
  assert.ok(r.mean > 4, `mean ${r.mean} should reflect the repaired triple, not the 1-day fallback`);
});

test('#30 raw distributions: unknown type is reported, not silent', () => {
  const r = runMonteCarlo({
    activities: [{ id: 'a', duration: 5, predecessors: [] }],
    distributions: { a: { type: 'banana', optimistic: 1, mostLikely: 2, pessimistic: 3 } },
    iterations: 200
  });
  assert.ok(
    r.issues.some((i) => /unknown distribution type 'banana'/.test(i.message)),
    'unknown type must be reported'
  );
});

test('#30 raw distributions: negative stdDev and non-object spec are reported', () => {
  const r = runMonteCarlo({
    activities: [
      { id: 'a', duration: 5, predecessors: [] },
      { id: 'b', duration: 5, predecessors: ['a'] }
    ],
    distributions: { a: { type: 'normal', mean: 5, stdDev: -2 }, b: 42 },
    iterations: 200
  });
  assert.ok(r.issues.some((i) => i.activityId === 'a' && /negative stdDev/.test(i.message)));
  assert.ok(
    r.issues.some((i) => i.activityId === 'b' && /not a distribution object/.test(i.message)),
    'non-object spec must be reported: ' + JSON.stringify(r.issues)
  );
  // 'b' must still SAMPLE from its duration-derived default (5), not the
  // 1-day fallback (CodeRabbit: partial maps must not understate duration).
  assert.ok(r.mean > 3, `mean ${r.mean} reflects duration-derived defaults, not 1-day fallbacks`);
});

test('#30 raw distributions: null activities return issues, never throw (round-3 P1)', () => {
  const r = runMonteCarlo({
    activities: [null, { id: 'a', duration: 5, predecessors: [] }],
    distributions: { a: { min: 1, mode: 2, max: 3 } },
    iterations: 100
  });
  assert.ok(r.issues.some((i) => i.field === 'id' && /missing id/.test(i.message)));
  assert.ok(r.iterations === 100, 'run completes instead of throwing');
});

test('#30 raw distributions: unmatched keys are reported (round-3 P2)', () => {
  const r = runMonteCarlo({
    activities: [{ id: 'task', duration: 4, predecessors: [] }],
    distributions: { task: { min: 1, mode: 2, max: 3 }, tsk: 42 },
    iterations: 100
  });
  assert.ok(
    r.issues.some((i) => /distribution key 'tsk' matches no activity id/.test(i.message)),
    'unmatched key must be reported: ' + JSON.stringify(r.issues)
  );
});

test('#30 raw distributions: unusable stdDev is reported before its fallback', () => {
  const r = runMonteCarlo({
    activities: [{ id: 'a', duration: 5, distribution: { type: 'normal', mean: 5, stdDev: 'invalid' } }],
    iterations: 100
  });
  assert.ok(
    r.issues.some((i) => i.activityId === 'a' && /stdDev is present but not a usable number/.test(i.message)),
    JSON.stringify(r.issues)
  );
});

test('#30 raw distributions: clean specs stay untouched (no spurious issues)', () => {
  // Vacuous-test guard: the fix must not alter well-formed input behavior.
  const acts = [{ id: 'a', duration: 5, predecessors: [] }];
  const before = runMonteCarlo({ activities: structuredClone(acts), iterations: 400 });
  const after = runMonteCarlo({
    activities: structuredClone(acts),
    distributions: { a: { type: 'triangular', optimistic: 3.5, mostLikely: 5, pessimistic: 7.5 } },
    iterations: 400
  });
  assert.equal(after.issues.length, 0);
  assert.equal(after.mean, before.mean); // same spec shape the builder derives
});

test('#31 CPM: zero-duration activity resolves with zero float and is critical', () => {
  const net = cpmNetwork([{ id: 'z', duration: 0, predecessors: [] }]);
  assert.equal(net.projectDuration, 0);
  assert.equal(net.activities[0].float, 0);
  assert.equal(net.activities[0].critical, true);
  // And a zero-duration predecessor resolves downstream activities correctly.
  const net2 = cpmNetwork([
    { id: 'z', duration: 0, predecessors: [] },
    { id: 'b', duration: 4, predecessors: ['z'] }
  ]);
  assert.equal(net2.activities[1].es, 0);
  assert.equal(net2.activities[1].ef, 4);
  assert.equal(net2.projectDuration, 4);
});

test('#31 CPM: disconnected activities are independent components, each terminal to maxEF', () => {
  const net = cpmNetwork([
    { id: 'a', duration: 3, predecessors: [] },
    { id: 'b', duration: 9, predecessors: [] },
    { id: 'c', duration: 2, predecessors: ['a'] }
  ]);
  assert.equal(net.projectDuration, 9);
  const byId = Object.fromEntries(net.activities.map((a) => [a.id, a]));
  // 'a' has a successor so it can have float; 'b' is an independent terminal.
  assert.equal(byId.b.lf, 9);
  assert.equal(byId.b.float, 0);
  assert.equal(byId.c.ef, 5);
  assert.equal(byId.c.float, 4);
  assert.equal(byId.c.critical, false);
});

test('#31 MC: serial network mean ≈ 2× single and stdDev exceeds it (variance accumulates)', () => {
  // Serial: variance accumulates by sum; compare against a single-activity run.
  const one = runMonteCarlo({ activities: [{ id: 'a', duration: 5, predecessors: [] }], iterations: 3000 });
  const serial = runMonteCarlo({
    activities: [
      { id: 'a', duration: 5, predecessors: [] },
      { id: 'b', duration: 5, predecessors: ['a'] }
    ],
    iterations: 3000
  });
  // Default triangular: o=0.7d, m=d, p=1.5d. Serial mean ≈ 2x single mean.
  assert.ok(Math.abs(serial.mean - 2 * one.mean) < 0.5, `serial ${serial.mean} ≈ 2 × single ${one.mean}`);
  assert.ok(serial.stdDev > one.stdDev, 'serial stdDev exceeds single-activity stdDev');
});

test('#31 MC: truncated normal never samples negative and is deterministic per seed', () => {
  // mean 1, stdDev 3 -> ~37% of the pre-truncation mass is below zero; the
  // sampler truncates at 0, so every observed duration is >= 0 and the
  // empirical mean EXCEEDS the configured mean.
  // Explicit rngs on BOTH runs (cubic: default IS makeRng(42), so a
  // default-vs-explicit pair is identical by construction — vacuous).
  const r = runMonteCarlo({
    activities: [{ id: 'a', duration: 1, distribution: { type: 'normal', mean: 1, stdDev: 3 } }],
    iterations: 20000,
    rng: makeRng(7)
  });
  assert.ok(r.percentiles.p10 >= 0, 'no negative durations');
  assert.ok(r.mean > 1, `truncated mean ${r.mean} exceeds configured pre-truncation mean 1`);
  const r2 = runMonteCarlo({
    activities: [{ id: 'a', duration: 1, distribution: { type: 'normal', mean: 1, stdDev: 3 } }],
    iterations: 20000,
    rng: makeRng(7)
  });
  assert.equal(r.mean, r2.mean);
});

test('#31 MC: single deterministic activity gives an exact point-mass distribution', () => {
  const r = runMonteCarlo({
    activities: [{ id: 'a', duration: 7, distribution: { type: 'triangular', optimistic: 7, mostLikely: 7, pessimistic: 7 } }],
    iterations: 300,
    targets: [6.9, 7, 7.1]
  });
  assert.equal(r.mean, 7);
  assert.equal(r.stdDev, 0);
  assert.deepEqual(r.percentiles, { p10: 7, p50: 7, p90: 7 });
  assert.deepEqual(
    r.probabilityByTarget.map((t) => t.probability),
    [0, 1, 1]
  );
});

test('#31 EVM: zero budget with complete milestones earns zero, metrics stay finite', () => {
  const r = evmMetrics({
    budget: 0,
    milestones: [{ id: 'm1', percentage: 100, cost: 100, progress: 1 }],
    startDate: '2026-01-01',
    endDate: '2026-02-01',
    statusDate: '2026-01-20'
  });
  assert.equal(r.earnedValue, 0);
  assert.equal(r.actualCost, 100);
  assert.equal(r.cpi, 0);
  assert.equal(r.eac, null); // #28 policy: null EAC when CPI <= 0
  assert.equal(r.vac, null);
});

test('#31 EVM: DST spring-forward boundary does not distort date-only timeline math', () => {
  // US DST 2026: Mar 8. A 20-day schedule spanning it must still be exact
  // calendar days (UTC day arithmetic), not 23/25-hour wall-clock days.
  // Pin a DST-observing TZ (cubic: a UTC CI runner can't catch local-time
  // regressions) and restore it whatever happens.
  const prevTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const r = evmMetrics({
      budget: 1000,
      milestones: [{ id: 'm', percentage: 50, cost: 0, progress: 1 }],
      startDate: '2026-03-01',
      endDate: '2026-03-21',
      statusDate: '2026-03-11' // exactly 10 of 20 days
    });
    assert.equal(r.timeline.projectDurationDays, 20);
    assert.equal(r.timeline.elapsedDays, 10);
    assert.ok(Math.abs(r.timeline.actualTimePercentage - 0.5) < 1e-9);
    assert.ok(Math.abs(r.plannedValue - 500) < 1e-9);
  } finally {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  }
});

test('#31 EVM: DST boundary via offset timestamps keeps sub-day precision', () => {
  const r = evmMetrics({
    budget: 1000,
    milestones: [{ id: 'm', percentage: 50, cost: 0, progress: 1 }],
    startDate: '2026-03-08T00:00:00Z',
    endDate: '2026-03-08T12:00:00Z',
    statusDate: '2026-03-08T06:00:00Z' // halfway, spans the US spring-forward instant
  });
  assert.ok(Math.abs(r.timeline.actualTimePercentage - 0.5) < 1e-9, `got ${r.timeline.actualTimePercentage}`);
});
