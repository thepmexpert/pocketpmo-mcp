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
      const optimistic = num(d.min ?? d.optimistic) ?? base * 0.7;
      const mostLikely = num(d.mode ?? d.mostLikely) ?? base;
      const pessimistic = num(d.max ?? d.pessimistic) ?? base * 1.5;
      let mean = num(d.mean) ?? base;
      const explicitMean = num(d.mean);
      const meanPresent = d.mean !== undefined && d.mean !== null;
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
      // A PRESENT but non-numeric mean is invalid data, not absence —
      // report it (cubic sweep: absent vs invalid were indistinguishable).
      if (meanPresent && explicitMean === null) {
        issues.push({
          activityId: activity.id,
          field: 'distribution',
          message: 'distribution mean is present but not a usable number; ignoring',
          received: d.mean
        });
      }
      let triple = { optimistic, mostLikely, pessimistic };
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
        triple = { optimistic: sorted[0], mostLikely: sorted[1], pessimistic: sorted[2] };
      }
      // Triangular sampling uses ONLY (o, m, p); report the actual
      // triangular mean (o+m+p)/3 as metadata. A configured `mean` that
      // disagrees with the triple is ignored for triangular — reported, not
      // silently kept (review #19: metadata mean used to say `duration`
      // while the sampled distribution's mean was 1.0667x duration).
      if (type === 'triangular') {
        const triMean =
          (triple.optimistic + triple.mostLikely + triple.pessimistic) / 3;
        if (explicitMean !== null && Math.abs(explicitMean - triMean) > 1e-9) {
          issues.push({
            activityId: activity.id,
            field: 'distribution',
            message:
              'configured mean does not apply to triangular sampling (actual mean = (o+m+p)/3); metadata reports the computed mean',
            received: d.mean
          });
        }
        mean = triMean;
      }
      distributions[activity.id] = {
        type,
        ...triple,
        mean,
        stdDev
      };
    } else {
      // Default distribution: report the ACTUAL triangular mean of the
      // default triple, not the bare duration (review #19). No 1-day floor
      // on the optimistic value — a floor would invert the triple for
      // sub-day durations (0.5-day base: max(1, 0.35)=1 > p=0.75).
      const oDefault = base * 0.7;
      const pDefault = base * 1.5;
      distributions[activity.id] = {
        type: 'triangular',
        optimistic: oDefault,
        mostLikely: base,
        pessimistic: pDefault,
        mean: (oDefault + base + pDefault) / 3,
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
      // Same fallback shape as buildDistributions (NO 1-day floor — a floor
      // fabricates ordering violations for sub-day durations, cubic round 2).
      const o = (finite(d.optimistic) ? d.optimistic : finite(d.min) ? d.min : null) ?? base * 0.7;
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
  // NOTE: this 1,000,000 ceiling is the LIB-level hard limit for direct
  // callers/tests; the server layer clamps agent-supplied counts to its own
  // tighter MAX_ITERATIONS (20,000, exported from server.js) before reaching
  // here, so tool consumers never see this throw.
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
      criticalActivityFrequency: [],
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
  // R-7 quantile (linear interpolation on (n-1)p), matching the app's
  // simple-statistics quantileSorted convention (review #20: the old
  // floor-index pick made tiny-sample percentiles unstable and disagreed
  // with the app engine's percentiles).
  const q = (p) => {
    if (durations.length === 0) return 0;
    if (durations.length === 1) return durations[0];
    const h = (durations.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.min(lo + 1, durations.length - 1);
    return durations[lo] + (h - lo) * (durations[hi] - durations[lo]);
  };
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

  // Review #21: these are per-activity criticality shares (how often each
  // activity lands ON a critical path), not frequencies of whole critical
  // paths. Renamed accordingly; criticalPathFrequency kept as a deprecated
  // alias so existing consumers don't break.
  const criticalActivityFrequency = Object.entries(criticalCounts)
    .map(([id, count]) => ({ id, share: round4(count / iterations) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 10);

  return {
    iterations,
    mean: round2(mean),
    stdDev: round2(Math.sqrt(variance)),
    percentiles: { p10: round2(q(0.1)), p50: round2(q(0.5)), p90: round2(q(0.9)) },
    probabilityByTarget,
    criticalActivityFrequency,
    criticalPathFrequency: criticalActivityFrequency,
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
  // Review #22: `Number(x) || 50` treated 0 as falsy, so callers could not
  // configure in-progress milestones to earn zero. Only a MISSING value
  // defaults to 50; an explicit 0 is honored (the app's
  // calculateEvmTotals does the same via `typeof number ? x : 50`).
  const effectiveInProgressValue =
    inProgressValue === undefined || inProgressValue === null
      ? 50
      : Number(inProgressValue);
  if (
    effectiveInProgressValue < 0 ||
    effectiveInProgressValue > 100 ||
    !Number.isFinite(effectiveInProgressValue)
  ) {
    issues.push({
      field: 'inProgressValue',
      message: Number.isFinite(effectiveInProgressValue)
        ? 'inProgressValue out of range; clamped to [0, 100]'
        : 'inProgressValue is not a usable number; replaced with the neutral default 50',
      received: inProgressValue
    });
  }
  // NaN survives Math.min/Math.max clamping — guard BEFORE the fraction
  // (CodeRabbit sweep: non-numeric strings poisoned EV/AC with NaN).
  const inProgressFraction =
    (Number.isFinite(effectiveInProgressValue)
      ? Math.min(Math.max(effectiveInProgressValue, 0), 100)
      : 50) / 100;
  const safeMilestones = Array.isArray(milestones) ? milestones : [];

  let ev = 0;
  let ac = 0;
  let totalPercentage = 0;
  for (const m of safeMilestones) {
    if (!m || typeof m !== 'object') continue;
    // Milestone numeric parsing: null/blank/whitespace are INVALID data,
    // not zero — they must reach the report paths below, not collapse to
    // 0 silently (cubic sweep). Only non-blank numeric strings coerce.
    const parseNum = (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
      }
      return NaN;
    };
    // Review #23/#24: progress may arrive as string ("1", "0.1") — the
    // app's exact-sentinel checks would earn these milestones nothing.
    // Normalize the known sentinels, then Number(); report unrecognized.
    let progress = m.progress;
    if (progress === 'COMPLETE' || progress === 'complete') progress = MILESTONE_PROGRESS.COMPLETE;
    else if (progress === 'IN_PROGRESS' || progress === 'in_progress') progress = MILESTONE_PROGRESS.IN_PROGRESS;
    else if (progress === 'NOT_STARTED' || progress === 'not_started') progress = MILESTONE_PROGRESS.NOT_STARTED;
    else progress = parseNum(m.progress);
    const pct = parseNum(m.percentage);
    // Review #24: percentage must be a finite number in [0, 100]; negative
    // or >100 milestones used to produce negative / over-budget EV. Clamp
    // and report (warn-and-continue, bridge convention).
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      issues.push({
        field: 'milestone',
        milestone: m.id ?? null,
        message: 'milestone percentage must be a finite number in [0, 100]; clamped',
        received: m.percentage
      });
    }
    const safePct = Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0;
    totalPercentage += safePct;
    const value = (bac / 100) * safePct;
    // Review #24: costs must be non-negative; negative cost produced
    // negative AC and a nonsensical CPI. Clamp and report.
    const cost = parseNum(m.cost);
    if (!Number.isFinite(cost) || cost < 0) {
      issues.push({
        field: 'milestone',
        milestone: m.id ?? null,
        message: 'milestone cost must be a finite non-negative number; clamped to 0',
        received: m.cost
      });
    }
    const safeCost = Number.isFinite(cost) && cost > 0 ? cost : 0;
    if (progress === MILESTONE_PROGRESS.COMPLETE) {
      ev += value;
      ac += safeCost;
    } else if (progress === MILESTONE_PROGRESS.IN_PROGRESS) {
      ev += value * inProgressFraction;
      // Review #25: AC = cost * fraction mirrors the app's evmCalculator
      // exactly (calculateEvmTotals' actualCost reduce). This treats
      // milestone cost as PLANNED cost spread proportionally to progress —
      // a faithful port, documented rather than changed. Standard-EVM
      // "actual spend" semantics would need a joint app+bridge rename
      // (cost -> actualCost) and is deferred to that decision.
      ac += safeCost * inProgressFraction;
    } else if (progress === MILESTONE_PROGRESS.NOT_STARTED) {
      // Supported sentinel: earns nothing, no issue.
    } else {
      // Unconditional: every progress value outside the three supported
      // sentinels (including finite numbers like 0.5) is reported —
      // silent no-earn milestones hide data corruption.
      issues.push({
        field: 'milestone',
        milestone: m.id ?? null,
        message: 'milestone progress not recognized; milestone earns nothing',
        received: m.progress
      });
    }
  }
  // Review #24: flag implausible milestone budgets explicitly. Policy (per
  // the app model, percentages are per-milestone weights and NOT required
  // to total 100) — over-100 totals are allowed but reported.
  if (totalPercentage > 100) {
    issues.push({
      field: 'milestones',
      message: `milestone percentages total ${totalPercentage}% (> 100); earned value may exceed BAC`,
      received: totalPercentage
    });
  }

  // Timeline: elapsed fraction between startDate and endDate at statusDate.
  // Review #26/#27 + bot sweep: (a) impossible calendar dates like
  // '2026-02-30' are validated BEFORE parsing (Date silently rolls them
  // forward); (b) date-only inputs use UTC calendar-day arithmetic —
  // exact and runtime-TZ/DST immune (documented divergence from the
  // app's local-time math); (c) full-timestamp inputs use instant
  // arithmetic so sub-day schedules keep meaning.
  const isDateOnly = (v) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  // Timezone-less timestamp strings ("2026-01-01T08:00:00") are parsed by
  // Date in the HOST's local timezone — results would vary by server TZ
  // and break across DST (cubic round 2). Only explicit-offset/date-only
  // forms are accepted; naive timestamps are reported as invalid.
  const isNaiveTimestamp = (v) =>
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) &&
    !/([Zz]|[+-]\d{2}:?\d{2})$/.test(v);
  // Strict format gate (CodeRabbit round 3): only exact YYYY-MM-DD or a
  // timezone-qualified ISO timestamp is accepted. Non-conforming textual
  // forms (slash-separated "2026/09/16", single-digit "2026-9-6", …) are
  // rejected BEFORE new Date() can silently parse or roll them forward.
  const ISO_STRICT =
    /^\d{4}-\d{2}-\d{2}(?:$|[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?$)/;
  const dateParts = (v) => /^(\d{4})-(\d{2})-(\d{2})/.exec(v) || null;
  const allDateOnly =
    isDateOnly(startDate) && isDateOnly(endDate) &&
    (statusDate === undefined || statusDate === null || isDateOnly(statusDate));
  let actualTimePercentage = 0;
  let projectDurationDays = 0;
  let elapsedDays = 0;
  const start = startDate ? new Date(startDate).getTime() : NaN;
  const end = endDate ? new Date(endDate).getTime() : NaN;
  const status = statusDate ? new Date(statusDate).getTime() : NaN;
  const checkDate = (field, value, t) => {
    if (value === undefined || value === null || value === '') return false;
    if (isNaiveTimestamp(value)) {
      issues.push({
        field: 'dates',
        message: `${field} timestamp has no timezone offset; supply an explicit offset (Z or ±hh:mm) or a plain YYYY-MM-DD date`,
        received: value
      });
      return true;
    }
    // Strict format gate before any parse: reject slash-separated and
    // other non-conforming textual forms outright (CodeRabbit round 3).
    if (typeof value === 'string' && !ISO_STRICT.test(value)) {
      issues.push({
        field: 'dates',
        message: `invalid ${field}: use YYYY-MM-DD or a timezone-qualified ISO timestamp`,
        received: value
      });
      return true;
    }
    if (!Number.isFinite(t)) {
      issues.push({ field: 'dates', message: `invalid ${field}`, received: value });
      return true;
    }
    // Validate the TEXTUAL calendar components (not the parsed UTC date):
    // an offset timestamp like "2026-02-30T10:00:00+01:00" must be checked
    // against its own written date, which native parsing rolls forward.
    const parts = dateParts(value);
    if (parts) {
      const d = new Date(t);
      const textY = Number(parts[1]);
      const textM = Number(parts[2]);
      const textD = Number(parts[3]);
      const writtenEq = (dY, dM, dD) =>
        dY === textY && dM === textM && dD === textD;
      if (isDateOnly(value)) {
        if (!writtenEq(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) {
          issues.push({
            field: 'dates',
            message: `invalid ${field} (impossible calendar date)`,
            received: value
          });
          return true;
        }
      } else {
        // Offset timestamp: compare against the instant shifted by the
        // WRITTEN offset, so the local calendar day is what must match.
        const offsetMatch = /([Zz]|[+-]\d{2}:?\d{2})$/.exec(value);
        let local = d;
        if (offsetMatch) {
          const tok = offsetMatch[1];
          if (tok !== 'Z' && tok !== 'z') {
            const sign = tok[0] === '-' ? -1 : 1;
            const hh = Number(tok.slice(1, 3));
            const mm = tok.includes(':') ? Number(tok.slice(4, 6)) : Number(tok.slice(3, 5));
            local = new Date(t + sign * (hh * 60 + mm) * 60000);
          }
        }
        if (
          !writtenEq(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate())
        ) {
          issues.push({
            field: 'dates',
            message: `invalid ${field} (impossible calendar date)`,
            received: value
          });
          return true;
        }
      }
    }
    return false;
  };
  const datesInvalid =
    checkDate('startDate', startDate, start) |
    checkDate('endDate', endDate, end) |
    checkDate('statusDate', statusDate, status);
  if (datesInvalid) {
    // A reported date defect suppresses the timeline entirely — never
    // compute from a locally-parsed or impossible date.
  } else if (!startDate || !endDate) {
    issues.push({ field: 'dates', message: 'startDate/endDate missing; timeline percentage is 0' });
  } else if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    if (Number.isFinite(start) && Number.isFinite(end)) {
      issues.push({ field: 'dates', message: 'endDate must be after startDate' });
    }
  } else if (allDateOnly) {
    // Date-only schedule: UTC calendar-day diff on Y/M/D components.
    const startDay = Date.UTC(
      new Date(startDate).getUTCFullYear(),
      new Date(startDate).getUTCMonth(),
      new Date(startDate).getUTCDate()
    );
    const endDay = Date.UTC(
      new Date(endDate).getUTCFullYear(),
      new Date(endDate).getUTCMonth(),
      new Date(endDate).getUTCDate()
    );
    const statusClamped = Math.min(
      Math.max(Number.isFinite(status) ? status : start, start),
      end
    );
    const statusDay = Date.UTC(
      new Date(statusClamped).getUTCFullYear(),
      new Date(statusClamped).getUTCMonth(),
      new Date(statusClamped).getUTCDate()
    );
    projectDurationDays = Math.round((endDay - startDay) / 86400000);
    elapsedDays = Math.round((statusDay - startDay) / 86400000);
    actualTimePercentage = Math.min(Math.max(elapsedDays / projectDurationDays, 0), 1);
  } else {
    // Timestamp schedule: instant arithmetic on the clamped interval.
    const statusClamped = Math.min(
      Math.max(Number.isFinite(status) ? status : start, start),
      end
    );
    projectDurationDays = (end - start) / 86400000;
    elapsedDays = (statusClamped - start) / 86400000;
    actualTimePercentage = Math.min(Math.max(elapsedDays / projectDurationDays, 0), 1);
  }

  const pv = (bac / 100) * (actualTimePercentage * 100);
  const cpi = ac > 0 ? ev / ac : 0;
  const spi = pv > 0 ? ev / pv : 0;
  // Review #28: EAC = BAC/CPI is meaningless with no recorded cost
  // (CPI = 0 used to force eac = 0 / vac = BAC — a false "will finish
  // under budget"). Return null EAC/VAC, matching the app's
  // calculateEvmAdvancedMetrics policy (estimateAtCompletion: null when
  // CPI <= 0). SPI keeps the 0 convention: zero PV means no schedule
  // baseline exists, not a zero performance index.
  const eac = cpi > 0 ? bac / cpi : null;

  return {
    budgetAtComplete: round2(bac),
    plannedValue: round2(pv),
    earnedValue: round2(ev),
    actualCost: round2(ac),
    cpi: round4(cpi),
    spi: round4(spi),
    eac: eac === null ? null : round2(eac),
    vac: eac === null ? null : round2(bac - eac),
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
