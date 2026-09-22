/**
 * PocketPMO calculators — read-only ports of app.pocketpmo.com's core math.
 *
 * Source-of-truth functions in the app (rebel-projectpro-suite/src/utils):
 *   pertStats      <- pertCalculator.js  (calculatePertStats, calculatePertCompletionProbability)
 *   cpmNetwork     <- cpmCalculator.js   (calculateCpmNetwork)
 *   Monte Carlo    <- monteCarloEngine.js (buildDistributionsFromActivities, runMonteCarloEngine)
 *   evmMetrics     <- evmCalculator.js   (calculateEvmTotals)
 *
 * These are faithful ports, not re-inventions: each function documents the
 * behaviour it mirrors. Determinism: the only randomness is the injected rng.
 */

// ---------------------------------------------------------------------------
// PERT (mirrors src/utils/pertCalculator.js)
// ---------------------------------------------------------------------------

/**
 * PERT statistics for one activity.
 * expected = (o + 4m + p)/6; variance = ((p-o)/6)^2; stdDev = sqrt(variance).
 * Full precision: values are rounded only at the API boundary (pertRollup,
 * the tool layer), because pertRollup sums per-activity results — rounding
 * here would compound (sum of rounded ≠ rounded sum, material at portfolio
 * scale). Invalid input -> NaN (never throws): the app's UI (PERTAnalysis
 * saveEditMode) rejects estimates that are negative or violate o <= m <= p
 * before they are stored, so this guard mirrors that data contract
 * defensively — reversed/negative triples get NaN like any other unusable
 * input, never a silently wrong estimate.
 */
export function pertStats(optimistic, mostLikely, pessimistic) {
  const o = Number(optimistic);
  const m = Number(mostLikely);
  const p = Number(pessimistic);
  if (!validPertOrdering(o, m, p)) {
    return { expected: NaN, variance: NaN, stdDev: NaN };
  }
  const expected = (o + 4 * m + p) / 6;
  const variance = Math.pow((p - o) / 6, 2);
  return {
    expected,
    variance,
    stdDev: Math.sqrt(variance)
  };
}

/**
 * Round-trip roll-up across activities (app sums expected and variance).
 * Sums full-precision inputs and rounds once here — the API boundary.
 * Non-finite per-activity values (NaN from invalid estimates, null,
 * undefined, non-numeric) are skipped — never coerced via `|| 0`, which
 * would also swallow legitimate falsy values — and reported in `skipped`
 * so callers can surface the exclusion instead of hiding it.
 *
 * ASSUMPTION — INDEPENDENCE: Var(T) = Σ Var(Xᵢ) is exact ONLY when activity
 * durations are statistically independent. Real projects routinely violate
 * this: shared resources, common-cause risks (weather, supplier, funding),
 * and estimation bias correlate durations, and the true variance is
 * Var(T) = Σ Var(Xᵢ) + 2 Σ Cov(Xᵢ,Xⱼ) — typically LARGER than the
 * independent estimate, so roll-ups here tend to be OPTIMISTIC when
 * activities share risks. This mirrors the app's pertCalculator behaviour
 * (same assumption, same formula); the completion-probability output
 * inherits it. Correlation-aware roll-ups are a future feature (needs
 * covariance input the app does not collect today).
 */
export function pertRollup(activities) {
  let expected = 0;
  let variance = 0;
  const skipped = [];
  for (const a of activities) {
    const e = a?.expected;
    const v = a?.variance;
    if (typeof e === 'number' && Number.isFinite(e) && typeof v === 'number' && Number.isFinite(v)) {
      expected += e;
      variance += v;
    } else {
      skipped.push(a?.id ?? null);
    }
  }
  return {
    expected: round2(expected),
    variance: round2(variance),
    stdDev: round2(Math.sqrt(variance)),
    skipped
  };
}

/** Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26). */
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Completion probability by a target duration, normal approximation.
 *
 * Deliberate divergence from the app (calculatePertCompletionProbability):
 * the ±3-sigma clamp is NOT ported. Clamping flattens every target beyond
 * 3 standard deviations to Φ(±3) ≈ 0.0013/0.9987, which is not a normal
 * CDF. The erf approximation is numerically safe for any finite z —
 * exp(-z²) just underflows to 0, so tail probabilities degrade smoothly
 * to 0/1 instead of being clipped.
 *
 * Invalid stdDev (negative or non-finite) -> 0.5, consistent with the
 * invalid-input convention; a negative stdDev is invalid input, NOT zero
 * variance. Zero stdDev -> deterministic 0/1.
 */
export function pertCompletionProbability(totalExpected, totalStdDev, targetDuration) {
  const expected = Number(totalExpected);
  const stdDev = Number(totalStdDev);
  const target = Number(targetDuration);
  if (!Number.isFinite(expected) || !Number.isFinite(stdDev) || !Number.isFinite(target)) {
    return 0.5;
  }
  if (stdDev < 0) return 0.5;
  if (stdDev === 0) return target >= expected ? 1 : 0;
  return round4(normalCdf((target - expected) / stdDev));
}

// ---------------------------------------------------------------------------
// CPM (mirrors src/utils/cpmCalculator.js calculateCpmNetwork)
// ---------------------------------------------------------------------------

function predecessorIds(activity) {
  const preds = activity.predecessors;
  if (Array.isArray(preds)) {
    return preds
      .map((p) => (typeof p === 'string' ? p : p && p.id ? p.id : null))
      .filter(Boolean);
  }
  if (typeof preds === 'string' && preds.trim()) {
    return preds.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Shared duration validity policy across CPM, PERT and Monte Carlo.
 * Infinity passes `> 0` and once inside a network poisons everything
 * downstream of it (ef/l/float become Infinity/NaN), so require a finite
 * positive number. Exports used by server.js (pert tool path) too.
 */
export function validDuration(d) {
  return typeof d === 'number' && Number.isFinite(d) && d > 0;
}

/**
 * Shared PERT-estimate ordering policy — the ONE policy for o/m/p triples
 * across pertStats, validateActivities and the server pert tool path:
 * all finite, >= 0, and o <= m <= p (zero and equality allowed, matching
 * pertStats' guard and the app's stored-data contract; the app's UI
 * rejects inverted/negative triples before they are ever stored).
 * Inverted estimates are not cosmetic — the triangular inverse-CDF
 * sampler produces NEGATIVE durations for inverted inputs
 * (o=10,m=5,p=2 samples -0.683 at u=0.7), and PERT's variance squares
 * the inverted (p-o) so the result silently LOOKS valid.
 */
export function validPertOrdering(o, m, p) {
  return (
    typeof o === 'number' && Number.isFinite(o) && o >= 0 &&
    typeof m === 'number' && Number.isFinite(m) && m >= 0 &&
    typeof p === 'number' && Number.isFinite(p) && p >= 0 &&
    o <= m &&
    m <= p
  );
}

/**
 * Extract cycle paths from the unresolved subgraph via colored DFS.
 * Returns arrays of ids, each ending where it started: [a, b, c, a].
 * Gray = on the current DFS stack (back edge -> cycle found),
 * black = fully explored (skipped, no duplicate cycles from cross-edges).
 */
function findCyclePaths(effPredecessors, unresolvedSet) {
  const color = new Map([...unresolvedSet].map((id) => [id, 0]));
  const stack = [];
  const cycles = [];
  function dfs(id) {
    color.set(id, 1);
    stack.push(id);
    for (const p of effPredecessors.get(id)) {
      if (!unresolvedSet.has(p)) continue;
      const c = color.get(p);
      if (c === 1) {
        cycles.push([...stack.slice(stack.indexOf(p)), p]);
      } else if (c === 0) {
        dfs(p);
      }
    }
    stack.pop();
    color.set(id, 2);
  }
  for (const id of unresolvedSet) {
    if (color.get(id) === 0) dfs(id);
  }
  return cycles;
}

/**
 * Forward/backward CPM pass. Iterative forward pass handles non-topological
 * order (same as the app). Cycles are detected explicitly: `unresolved`
 * lists every activity that never scheduled, `cycles` reports the actual
 * dependency loop as a path (`a -> b -> a`), and any unresolved activity
 * outside a cycle is downstream of one — derivable by subtraction, and
 * flagged in validateActivities issues.
 *
 * Returns { activities: [{id, es, ef, ls, lf, float, critical}], projectDuration,
 *           unresolved, cycles }.
 */
export function cpmNetwork(activities) {
  if (!Array.isArray(activities) || activities.length === 0) {
    return { activities: [], projectDuration: 0, unresolved: [], cycles: [] };
  }
  // Work on shallow clones: the calculator is pure — callers (including the
  // Monte Carlo loop reusing simActivities across iterations) never observe
  // es/ef/ls/lf/float/critical written onto their input objects.
  const work = activities.map((a) => ({ ...a }));
  const map = new Map(work.map((a) => [a.id, a]));
  const done = new Set();
  const predsOf = new Map(work.map((a) => [a.id, predecessorIds(a)]));
  const effPredecessors = new Map();

  // Resolve predecessor references; unknown ids are ignored like the app.
  for (const a of work) {
    effPredecessors.set(
      a.id,
      predsOf.get(a.id).filter((p) => map.has(p))
    );
  }

  let changed = true;
  while (changed && done.size < work.length) {
    changed = false;
    for (const a of work) {
      if (done.has(a.id)) continue;
      const preds = effPredecessors.get(a.id);
      const duration = validDuration(a.duration) ? a.duration : 0;
      if (preds.length === 0) {
        a.es = 0;
        a.ef = duration;
        done.add(a.id);
        changed = true;
      } else if (preds.every((p) => done.has(p))) {
        a.es = Math.max(...preds.map((p) => map.get(p).ef || 0));
        a.ef = a.es + duration;
        done.add(a.id);
        changed = true;
      }
    }
  }

  const unresolved = work.filter((a) => !done.has(a.id)).map((a) => a.id);
  const cycles = unresolved.length
    ? findCyclePaths(effPredecessors, new Set(unresolved))
    : [];
  const processed = work.filter((a) => done.has(a.id));
  const maxEF = processed.length ? Math.max(...processed.map((a) => a.ef || 0)) : 0;

  // Backward pass: process in reverse finish order.
  const byEfDesc = [...processed].sort((a, b) => (b.ef || 0) - (a.ef || 0));
  const successors = new Map(processed.map((a) => [a.id, []]));
  for (const a of processed) {
    for (const p of effPredecessors.get(a.id)) {
      if (successors.has(p)) successors.get(p).push(a.id);
    }
  }
  for (const a of byEfDesc) {
    const sucs = successors.get(a.id);
    if (!sucs || sucs.length === 0) {
      // Terminal activity: late finish is the project duration (max EF),
      // matching the app's src/utils/cpmCalculator.js. Using a.ef here would
      // give every independent terminal activity zero float and mark it
      // critical — wrong whenever two activities run in parallel and both
      // end with no successor.
      a.lf = maxEF;
    } else {
      a.lf = Math.min(...sucs.map((s) => map.get(s).ls ?? maxEF));
    }
    a.ls = a.lf - (validDuration(a.duration) ? a.duration : 0);
    a.float = a.ls - a.es;
    // Epsilon comparison: sampled (non-integer) durations leave ~1e-15 residue.
    a.critical = Math.abs(a.float) < 1e-9;
  }

  return {
    activities: processed.map((a) => ({
      id: a.id,
      name: a.name || a.id,
      duration: typeof a.duration === 'number' ? a.duration : 0,
      es: a.es,
      ef: a.ef,
      ls: a.ls,
      lf: a.lf,
      float: a.float,
      critical: a.critical
    })),
    projectDuration: maxEF,
    unresolved,
    cycles
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo (mirrors src/utils/monteCarloEngine.js)
// ---------------------------------------------------------------------------

/**
 * Seeded LCG rng factory — deterministic runs for tests and reproducible demos.
 */
export function makeRng(seed = 42) {
  let state = seed >>> 0 || 1;
  return function rng() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Build per-activity distributions (mirrors buildDistributionsFromActivities).
 * Every parameter passes through the shared normalization: numeric strings
 * coerced, non-finite rejected back to the duration-derived default, stdDev
 * clamped non-negative, unknown distribution types coerced to triangular.
 * Returns { distributions, issues } — issues describe each repair so the
 * caller can surface what was silently assumed.
 */
export function buildDistributions(activities) {
  const distributions = {};
  const issues = [];
  if (!Array.isArray(activities)) return { distributions, issues };
  for (const activity of activities) {
    if (!activity || !activity.id) continue;
    const base =
      validDuration(activity.duration) ? activity.duration : 1;
    if (activity.distribution) {
      const d = activity.distribution;
      // Unknown types fall back to triangular (duration estimates are
      // three-point by nature); the repair is reported.
      const type = d.type === 'normal' ? 'normal' : 'triangular';
      if (d.type !== undefined && d.type !== 'normal' && d.type !== 'triangular') {
        issues.push({
          activityId: activity.id,
          field: 'distribution',
          message: `unknown distribution type '${d.type}'; using triangular`,
          received: d.type
        });
      }
      const num = (v) => {
        if (typeof v === 'number') {
          return Number.isFinite(v) ? v : null;
        }
        // Numeric strings coerce; blank/whitespace-only strings are
        // malformed data, not zero — reject rather than collapse to 0.
        if (typeof v === 'string' && v.trim() !== '') {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };
      const optimistic = num(d.min ?? d.optimistic) ?? Math.max(1, base * 0.7);
      const mostLikely = num(d.mode ?? d.mostLikely) ?? base;
      const pessimistic = num(d.max ?? d.pessimistic) ?? base * 1.5;
      let mean = num(d.mean) ?? base;
      let stdDev = num(d.stdDev) ?? base * 0.2;
      if (stdDev < 0) {
        issues.push({
          activityId: activity.id,
          field: 'distribution',
          message: `negative stdDev invalid; using ${base * 0.2}`,
          received: d.stdDev
        });
        stdDev = base * 0.2;
      }
      // Triangular ordering repair (normalization, not just reporting):
      // the sampler requires o <= m <= p; sort the triple and report.
      if (type === 'triangular' && (optimistic > mostLikely || mostLikely > pessimistic)) {
        issues.push({
          activityId: activity.id,
          field: 'distribution',
          message: `triangular estimates out of order; sorting o <= m <= p`,
          received: [optimistic, mostLikely, pessimistic]
        });
        const sorted = [optimistic, mostLikely, pessimistic].sort((x, y) => x - y);
        distributions[activity.id] = {
          type,
          optimistic: sorted[0],
          mostLikely: sorted[1],
          pessimistic: sorted[2],
          mean,
          stdDev
        };
        continue;
      }
      distributions[activity.id] = {
        type,
        optimistic,
        mostLikely,
        pessimistic,
        mean,
        stdDev
      };
    } else {
      distributions[activity.id] = {
        type: 'triangular',
        optimistic: Math.max(1, base * 0.7),
        mostLikely: base,
        pessimistic: base * 1.5,
        mean: base,
        stdDev: base * 0.2
      };
    }
  }
  return { distributions, issues };
}

function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return candidates[candidates.length - 1];
}

/**
 * Validate + normalize a triangular parameter triple. Returns null if the
 * triple is unusable (non-finite, negative, or strictly out of order);
 * flags the degenerate o = m = p case so the sampler can return the
 * constant directly instead of dividing by a zero width.
 */
function normalizeTriangular(o, m, p) {
  if (
    !Number.isFinite(o) ||
    !Number.isFinite(m) ||
    !Number.isFinite(p) ||
    o < 0 ||
    o > m ||
    m > p
  ) {
    return null;
  }
  return { o, m, p, degenerate: o === m && m === p };
}

/**
 * Validate + normalize a normal parameter pair (mean, stdDev). Returns null
 * if unusable; negative stdDev is invalid input, not a distribution.
 */
function normalizeNormal(mean, stdDev) {
  if (!Number.isFinite(mean) || !Number.isFinite(stdDev) || stdDev < 0) {
    return null;
  }
  return { mean, stdDev, degenerate: stdDev === 0 };
}

/** Sample from a validated distribution spec. */
function sampleDuration(dist, rng) {
  const isNormal = dist.type === 'normal';
  const normalized = isNormal
    ? normalizeNormal(dist.mean, dist.stdDev)
    : normalizeTriangular(dist.optimistic, dist.mostLikely, dist.pessimistic);
  if (normalized === null) {
    // Invalid distribution parameters: sample the 1-day fallback the same
    // way a missing distribution would — never NaN (NaN would poison the
    // whole network through cpmNetwork's arithmetic).
    return 1;
  }
  if (normalized.degenerate) {
    return isNormal ? normalized.mean : normalized.o;
  }
  if (isNormal) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    // Truncated at zero: negative durations are impossible. This makes the
    // effective distribution a truncated normal — the configured mean/stdDev
    // describe the PRE-truncation normal, documented here (intentional
    // truncation, matching the app's sampler semantics).
    return Math.max(0, normalized.mean + normalized.stdDev * z);
  }
  // Triangular via inverse CDF.
  const { o, m, p } = normalized;
  const u = rng();
  const fc = (m - o) / (p - o);
  if (u < fc) {
    return o + Math.sqrt(u * (p - o) * (m - o));
  }
  return p - Math.sqrt((1 - u) * (p - o) * (p - m));
}

/** Validate activities (mirrors validateMonteCarloActivities reporting style). */
export function validateActivities(activities) {
  const issues = [];
  if (!Array.isArray(activities) || activities.length === 0) {
    issues.push({ field: 'activities', message: 'activities must be a non-empty array' });
    return issues;
  }
  const idList = activities.filter((a) => a && a.id != null).map((a) => a.id);
  const ids = new Set(idList);
  // Duplicate ids make the network ambiguous: cpmNetwork's id map is
  // last-write-wins, so predecessor references resolve to an arbitrary twin
  // while stats accumulate across both objects. Report rather than guess.
  const seen = new Set();
  for (const id of idList) {
    if (seen.has(id)) {
      issues.push({
        activityId: id,
        field: 'id',
        message: `duplicate activity id '${id}': predecessor references and stats are ambiguous`
      });
    }
    seen.add(id);
  }
  const effPredecessors = new Map();
  for (const a of activities) {
    if (!a || a.id == null) continue;
    effPredecessors.set(
      a.id,
      predecessorIds(a).filter((p) => ids.has(p))
    );
  }
  const cycles = findCyclePaths(effPredecessors, new Set(ids));
  for (const cycle of cycles) {
    issues.push({
      activityId: cycle[0],
      field: 'predecessors',
      message: `dependency cycle detected: ${cycle.join(' -> ')}`
    });
  }
  for (const a of activities) {
    if (!a || a.id == null) {
      issues.push({ activityId: null, field: 'id', message: 'activity missing id' });
      continue;
    }
    if (!validDuration(a.duration)) {
      issues.push({
        activityId: a.id,
        field: 'duration',
        message: 'duration not a positive finite number; using 1-day fallback',
        received: a.duration
      });
    }
    const d = a.distribution;
    if (d) {
      // Resolve the min/mode/max aliases with the same precedence
      // buildDistributions uses, so alias-based distributions can't bypass
      // the ordering check.
      const base = validDuration(a.duration) ? a.duration : 1;
      const finite = (v) => typeof v === 'number' && Number.isFinite(v);
      const o = (finite(d.optimistic) ? d.optimistic : finite(d.min) ? d.min : null) ?? Math.max(1, base * 0.7);
      const m = (finite(d.mostLikely) ? d.mostLikely : finite(d.mode) ? d.mode : null) ?? base;
      const pe = (finite(d.pessimistic) ? d.pessimistic : finite(d.max) ? d.max : null) ?? base * 1.5;
      if (!validPertOrdering(o, m, pe)) {
        issues.push({
          activityId: a.id,
          field: 'distribution',
          message: `pert estimates violate optimistic <= mostLikely <= pessimistic; triangular sampling produces negative durations`,
          received: {
            optimistic: d.optimistic ?? d.min ?? null,
            mostLikely: d.mostLikely ?? d.mode ?? null,
            pessimistic: d.pessimistic ?? d.max ?? null
          }
        });
      }
    }
    for (const p of predecessorIds(a)) {
      if (!ids.has(p)) {
        issues.push({
          activityId: a.id,
          field: 'predecessors',
          message: `predecessor reference '${p}' matches no activity id`,
          received: p
        });
      }
    }
  }
  return issues;
}

/**
 * Monte Carlo simulation. Project duration per iteration = CPM longest-path
 * end (max EF after forward pass with sampled durations) — matches the app's
 * calculateProjectDuration semantics. Also records critical-path frequency.
 *
 * Returns { iterations, mean, stdDev, percentiles: {p10,p50,p90},
 *           probabilityByTarget: [{target, probability}], criticalPathFrequency }.
 */
export function runMonteCarlo({
  activities,
  distributions,
  iterations = 2000,
  rng = makeRng(42),
  targets = []
}) {
  const issues = validateActivities(activities);
  const safe = Array.isArray(activities) ? activities : [];
  // Strict iteration validation: fractional values would run the loop a
  // different number of times than the stats assume (shares > 1), and
  // non-finite values never terminate. Throw — the MCP layer converts
  // handler throws into isError responses, never a crashed process.
  const iterationCount = Number(iterations);
  if (
    !Number.isSafeInteger(iterationCount) ||
    iterationCount <= 0 ||
    iterationCount > 1_000_000
  ) {
    throw new Error('iterations must be a positive safe integer (max 1,000,000)');
  }
  if (!safe.length) {
    return {
      iterations: 0,
      mean: 0,
      stdDev: 0,
      percentiles: { p10: 0, p50: 0, p90: 0 },
      probabilityByTarget: [],
      criticalPathFrequency: [],
      issues
    };
  }
  iterations = iterationCount;
  let dists;
  if (distributions && Object.keys(distributions).length > 0) {
    dists = distributions;
  } else {
    const built = buildDistributions(safe);
    dists = built.distributions;
    issues.push(...built.issues);
  }

  const durations = [];
  const criticalCounts = {};
  const simActivities = safe.map((a) => ({ ...a }));

  for (let i = 0; i < iterations; i++) {
    for (const a of simActivities) {
      const d = dists[a.id];
      a.duration = d ? sampleDuration(d, rng) : 1;
    }
    const net = cpmNetwork(simActivities);
    durations.push(net.projectDuration);
    for (const a of net.activities) {
      if (a.critical) criticalCounts[a.id] = (criticalCounts[a.id] || 0) + 1;
    }
  }

  durations.sort((a, b) => a - b);
  const q = (p) => durations[Math.min(durations.length - 1, Math.floor(p * durations.length))];
  const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
  const variance =
    durations.reduce((s, d) => s + (d - mean) * (d - mean), 0) / durations.length;

  // Target probabilities come from the simulated project-duration
  // distribution — the same samples behind mean/percentiles — so every
  // number in the response describes one distribution. (A PERT-style sum of
  // per-activity means/variances ignores network topology: parallel paths
  // combine by max, not by sum, and would contradict the percentiles.)
  const probabilityByTarget = (targets || []).map((t) => {
    // Non-finite/null targets previously produced a false-certain 0
    // (NaN comparisons are always false); pert-style fallback for such
    // malformed input is the neutral 0.5, consistent with
    // pertCompletionProbability's documented convention.
    const numericTarget = Number(t);
    if (!Number.isFinite(numericTarget)) {
      return { target: numericTarget, probability: 0.5, issue: 'non-finite target; neutral probability reported' };
    }
    const completed = durations.filter((d) => d <= numericTarget).length;
    return {
      target: numericTarget,
      probability: round4(completed / durations.length)
    };
  });

  const criticalPathFrequency = Object.entries(criticalCounts)
    .map(([id, count]) => ({ id, share: round4(count / iterations) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 10);

  return {
    iterations,
    mean: round2(mean),
    stdDev: round2(Math.sqrt(variance)),
    percentiles: { p10: round2(q(0.1)), p50: round2(q(0.5)), p90: round2(q(0.9)) },
    probabilityByTarget,
    criticalPathFrequency,
    issues
  };
}

// ---------------------------------------------------------------------------
// EVM (mirrors src/utils/evmCalculator.js calculateEvmTotals)
// ---------------------------------------------------------------------------

const MILESTONE_PROGRESS = { NOT_STARTED: 0, IN_PROGRESS: 0.1, COMPLETE: 1 };

function parseBudget(budget) {
  const n = typeof budget === 'string' ? parseFloat(budget) : Number(budget);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Earned value metrics.
 * EV = sum over milestones of budget*pct/100 weighted by progress
 *      (complete=1, in-progress=0.5 fraction of the in-progress value —
 *      the app passes inProgressValue as a % recognized, default 50).
 * AC mirrors EV using milestone costs. PV = budget * elapsed/total (clamped).
 */
export function evmMetrics({
  budget,
  milestones = [],
  inProgressValue = 50,
  startDate,
  endDate,
  statusDate = new Date().toISOString().slice(0, 10)
}) {
  const issues = [];
  const bac = parseBudget(budget);
  if (!(Number(budget) >= 0) || bac === 0) {
    if (budget !== 0 && budget !== null && budget !== undefined) {
      issues.push({ field: 'budget', message: 'budget not a usable number; treating as 0', received: budget });
    }
  }
  const inProgressFraction = Math.min(Math.max(Number(inProgressValue) || 50, 0), 100) / 100;
  const safeMilestones = Array.isArray(milestones) ? milestones : [];

  let ev = 0;
  let ac = 0;
  for (const m of safeMilestones) {
    const pct = typeof m.percentage === 'number' ? m.percentage : 0;
    const value = (bac / 100) * pct;
    const cost = typeof m.cost === 'number' ? m.cost : 0;
    if (m.progress === MILESTONE_PROGRESS.COMPLETE) {
      ev += value;
      ac += cost;
    } else if (m.progress === MILESTONE_PROGRESS.IN_PROGRESS) {
      ev += value * inProgressFraction;
      ac += cost * inProgressFraction;
    }
  }

  // Timeline: elapsed fraction between startDate and endDate at statusDate.
  let actualTimePercentage = 0;
  let projectDurationDays = 0;
  let elapsedDays = 0;
  if (startDate && endDate) {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const status = new Date(statusDate).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      projectDurationDays = Math.ceil((end - start) / 86400000);
      elapsedDays = Math.ceil((Math.min(Math.max(status, start), end) - start) / 86400000);
      actualTimePercentage = Math.min(Math.max(elapsedDays / projectDurationDays, 0), 1);
    } else {
      issues.push({ field: 'dates', message: 'endDate must be after startDate' });
    }
  } else {
    issues.push({ field: 'dates', message: 'startDate/endDate missing; timeline percentage is 0' });
  }

  const pv = (bac / 100) * (actualTimePercentage * 100);
  const cpi = ac > 0 ? ev / ac : 0;
  const spi = pv > 0 ? ev / pv : 0;
  const eac = cpi > 0 ? bac / cpi : 0;

  return {
    budgetAtComplete: round2(bac),
    plannedValue: round2(pv),
    earnedValue: round2(ev),
    actualCost: round2(ac),
    cpi: round4(cpi),
    spi: round4(spi),
    eac: round2(eac),
    vac: round2(bac - eac),
    timeline: {
      projectDurationDays,
      elapsedDays,
      actualTimePercentage: round4(actualTimePercentage)
    },
    issues
  };
}

/** Round to 2 decimal places (NaN-safe). Exported for tool-layer display rounding. */
export function round2(n) {
  return Number.isFinite(n) ? parseFloat(n.toFixed(2)) : NaN;
}
function round4(n) {
  return Number.isFinite(n) ? parseFloat(n.toFixed(4)) : NaN;
}
