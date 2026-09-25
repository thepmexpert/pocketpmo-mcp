// ---------------------------------------------------------------------------
// Portfolio roll-up — BRIDGE-ORIGINAL functionality (no app counterpart).
// The app is single-project; there is no app calculator to mirror here.
// All math REUSES the app-mirrored calculators (pertStats, evmMetrics,
// dependencyTypeIssues, effectivePertTriple) so per-project numbers are
// exactly what the per-project tools produce — no second derivation, no
// second error style.
//
// STREAMING: createPortfolioFold() folds one project at a time; callers
// reading from the projects directory (lib/projects.js loadAllProjects)
// must NEVER retain parsed bodies — forEachEntry hands out the cache's
// own evictable objects, and collecting them re-peaks memory past the
// caps (loader contract: CodeRabbit round 2; cubic round 2 P1).
//
// Rounding discipline: full precision through the pipeline, one rounding
// per REPORTED value. PERT totals are summed RAW across all activities of
// all projects (never sums of rounded rows). EVM totals sum evmMetrics'
// published per-project values (its 2dp contract) — decimal-exact up to
// float representation — and portfolio CPI/SPI are computed from the SUMS,
// never as averages of project-level indices.
// ---------------------------------------------------------------------------

import {
  pertStats,
  evmMetrics,
  dependencyTypeIssues,
  effectivePertTriple,
  round2,
  round4
} from './calculators.js';

const ASSUMPTIONS = [
  'PERT totals assume activity and project durations are statistically independent — correlated durations (shared resources, common risks) make the true variance larger, so treat the roll-up as optimistic',
  'Dependency semantics are finish-to-start with zero lag; declared SS/FF types or lag are reported per project (dependencyWarnings) and modeled as FS',
  'Portfolio EVM sums project EV/AC/PV and computes CPI/SPI from the sums — never averages project-level indices',
  'Schedule analysis is PERT + EVM only; portfolio Monte Carlo is not offered (compute cost scales with every project)'
];

// Display-safe conversion (#48 class): String() itself throws on objects
// with no primitive conversion ({"toString":null} is valid JSON), so every
// row field rendered from raw hand-editable JSON must pass through this.
// Rows are display data — failed conversions render as the placeholder,
// they never leak objects into the payload.
function safeDisplay(value) {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function safeField(value) {
  return value === null || value === undefined ? null : safeDisplay(value);
}

/**
 * Incremental portfolio aggregation. add(project) computes ONE project's
 * row from its raw body and folds the small deltas into the running
 * totals — the body can be dropped the moment add() returns. result()
 * builds the aggregate payload from the retained rows/totals only.
 *
 * @param {{statusDate?: string}} opts as-of date handed to evmMetrics
 *   (default: today, same as the evm tool)
 */
export function createPortfolioFold({ statusDate } = {}) {
  const rows = [];
  let pertExp = 0;
  let pertVar = 0;
  let pertActivityCount = 0;
  let pertProjects = 0;
  let evmBac = 0;
  let evmPv = 0;
  let evmEv = 0;
  let evmAc = 0;
  let evmProjects = 0;

  function add(p) {
    if (!p || typeof p !== 'object') return null;
    const row = {
      id: safeField(p.id),
      name: safeField(p.name ?? p.id),
      activityCount: Array.isArray(p.activities) ? p.activities.length : 0,
      dependencyWarnings: 0,
      pert: null,
      pertSkipReason: null,
      evm: null,
      evmSkipReason: null,
      evmIssueCount: 0
    };

    // --- PERT: network-free sums of per-activity stats (the PERT rollup
    // does not traverse dependencies — same as the app and the pert tool).
    const acts = Array.isArray(p.activities) ? p.activities : [];
    row.dependencyWarnings = dependencyTypeIssues(acts).length;
    if (!acts.length) {
      row.pertSkipReason = 'no activities';
    } else {
      let exp = 0;
      let variance = 0;
      const skippedIds = [];
      for (const a of acts) {
        const { o, m, pe } = effectivePertTriple(a ?? {});
        const s = pertStats(o, m, pe);
        // Same skip-and-report rule as pertRollup: invalid stats are
        // excluded and LISTED, never coerced into the sums.
        if (Number.isFinite(s.expected) && Number.isFinite(s.variance)) {
          exp += s.expected;
          variance += s.variance;
        } else {
          // Display-safe: hostile activity ids are payload data too
          // (skippedActivities/pert.skipped serialize them).
          skippedIds.push(safeField(a?.id ?? null));
        }
      }
      if (skippedIds.length === acts.length) {
        // Every activity's stats were invalid: the durations are UNKNOWN,
        // not zero — a fabricated expected: 0 row (or zero contribution to
        // the totals) contradicts the null-means-no-data invariant that the
        // no-activities case already honors.
        row.pertSkipReason = 'no activities with valid PERT estimates';
      } else {
        row.pert = {
          expected: round2(exp),
          variance: round2(variance),
          stdDev: round2(Math.sqrt(variance)),
          skipped: skippedIds
        };
        pertExp += exp;
        pertVar += variance;
        // Count only ANALYZABLE activities: the aggregate count describes
        // the inputs of the sums, not the files' raw shapes.
        pertActivityCount += acts.length - skippedIds.length;
        pertProjects += 1;
      }
    }

    // --- EVM: run whenever the project declares EVM inputs (budget or
    // milestones). A project with neither carries no EVM signal — skipped
    // and reported, not zero-filled into the aggregate.
    const budget = p.evmData?.projectBudget ?? p.budget;
    const milestones = Array.isArray(p.evmData?.milestones) ? p.evmData.milestones : [];
    if (budget == null && !milestones.length) {
      row.evmSkipReason = 'no EVM data (no budget, no milestones)';
    } else {
      const e = evmMetrics({
        budget,
        milestones,
        inProgressValue: p.evmData?.inProgressValue ?? 50,
        startDate: p.startDate,
        endDate: p.endDate,
        statusDate
      });
      row.evm = {
        budgetAtComplete: e.budgetAtComplete,
        plannedValue: e.plannedValue,
        earnedValue: e.earnedValue,
        actualCost: e.actualCost,
        cpi: e.cpi,
        spi: e.spi
      };
      row.evmIssueCount = e.issues.length;
      evmBac += e.budgetAtComplete;
      evmPv += e.plannedValue;
      evmEv += e.earnedValue;
      evmAc += e.actualCost;
      evmProjects += 1;
    }

    rows.push(row);
    return row;
  }

  function result() {
    const pert = pertProjects === 0 ? null : {
      projectCount: pertProjects,
      activityCount: pertActivityCount,
      totalExpected: round2(pertExp),
      totalVariance: round2(pertVar),
      totalStdDev: round2(Math.sqrt(pertVar)),
      skippedActivities: rows
        .filter((r) => r.pert !== null && r.pert.skipped.length)
        .map((r) => ({ project: r.id ?? r.name, ids: [...r.pert.skipped] })),
      skippedProjects: rows
        .filter((r) => r.pert === null)
        .map((r) => ({ project: r.id ?? r.name, reason: r.pertSkipReason }))
    };

    const evm = evmProjects === 0 ? null : {
      projectCount: evmProjects,
      budgetAtComplete: round2(evmBac),
      plannedValue: round2(evmPv),
      earnedValue: round2(evmEv),
      actualCost: round2(evmAc),
      cpi: round4(evmAc > 0 ? evmEv / evmAc : 0),
      spi: round4(evmPv > 0 ? evmEv / evmPv : 0),
      skippedProjects: rows
        .filter((r) => r.evm === null)
        .map((r) => ({ project: r.id ?? r.name, reason: r.evmSkipReason }))
    };

    // Deep snapshot: the fold's internal rows must never be exposed by
    // reference — a caller mutating one response would poison every later
    // result() from the same fold (same isolation rule as the assumptions
    // copy). Row data is plain JSON-safe values, so structuredClone is safe.
    return { pert, evm, projects: structuredClone(rows), assumptions: [...ASSUMPTIONS] };
  }

  return { add, result };
}

/**
 * Convenience wrapper: fold an already-in-memory array of project objects.
 * (The tool path uses createPortfolioFold directly so the directory scan
 * streams; this form is for pure/lib use and tests.)
 *
 * @param {Array<object>} projects raw project objects (the getProject shape)
 * @param {{statusDate?: string}} opts as-of date handed to evmMetrics
 */
export function portfolioRollup(projects, { statusDate } = {}) {
  const fold = createPortfolioFold({ statusDate });
  for (const p of Array.isArray(projects) ? projects : []) {
    fold.add(p);
  }
  return fold.result();
}
