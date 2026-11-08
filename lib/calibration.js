/**
 * Calibration history (Phase 2 kickoff — the first coach-enabling MCP tool).
 *
 * Port of the app's calibrationMetrics.js
 * (rebel-projectpro-suite/src/utils/calibrationMetrics.js, master) — same
 * parity rule as lib/calculators.js: the semantics below mirror the app
 * module exactly, so the MCP server and the UI agree on what a project's
 * forecast-vs-actual record says.
 *
 * Pure computation over resolved `project.calibrationTrail` entries. No UI,
 * no writes, no mutation: every function reads its inputs and returns new
 * objects only. No Date.now() anywhere — everything derives from stored
 * capturedAt/resolvedAt strings.
 *
 * Honesty contract (mirrors the app module verbatim):
 * - Only RESOLVED entries with a usable actualFinishDate are scored. Entries
 *   missing it are excluded and the exclusion is reported, never hidden.
 * - Fewer than MIN_USABLE_ENTRIES usable entries => an explicit
 *   `insufficient_data` status with NO numeric claims (no fabricated means).
 * - Stored error values that are not finite numbers (NaN/garbage from older
 *   writes) are excluded from their series by explicit finite guards, never
 *   propagated.
 * - Every numeric field in a returned object is a finite number or absent.
 *
 * ESTIMATOR NOTE (carried over from the app module): the means are plain
 * arithmetic means (sum/count) — no sample/population ambiguity.
 */

// Minimum usable resolved entries before any numeric claim is made.
export const MIN_USABLE_ENTRIES = 3;

// |meanSignedErrorDays| at or below this is "well-calibrated".
export const BIAS_WELL_CALIBRATED_THRESHOLD_DAYS = 2;

// Series counts below this make the precision trend too noisy to trust.
export const TREND_NOISY_MAX_COUNT = 6;

// Response-boundary cap on the resolved-entry list returned by
// computeCalibrationHistory (the trail itself is unbounded in the app).
export const MAX_LISTED_ENTRIES = 20;

/**
 * A value is usable in a series only when it is a finite number. This guard
 * is the firewall against the repo's known NaN-propagation bug class.
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Date-shaped string check mirroring the app's actualFinishErrorDays rule:
 * only YYYY-MM-DD-prefixed strings can ever be scored. A resolved entry
 * whose actualFinishDate is any other non-empty string counts as EXCLUDED,
 * not usable, so 'ready' never overstates how much data is actually scored.
 * @param {unknown} value
 * @returns {boolean}
 */
function isScorableDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return false;
  // Calendar round-trip: the regex alone accepts impossible dates like
  // 2026-02-30 (Date.UTC normalizes them), and an entry with an impossible
  // finish must count as excluded, not scored.
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const result = sum / values.length;
  // Inputs are already finite-guarded upstream; this re-check is
  // belt-and-braces only, NOT the finite firewall.
  return isFiniteNumber(result) ? result : null;
}

/**
 * Mean absolute error of a plain number array. Returns null for empty input.
 * @param {number[]} values
 * @returns {number|null}
 */
function meanAbsolute(values) {
  if (!values.length) return null;
  return mean(values.map((v) => Math.abs(v)));
}

/**
 * Sort {capturedAt, errorDays} pairs chronologically ascending (by
 * capturedAt). Never mutates the input array. Ties in capturedAt keep
 * insertion order (Array.prototype.sort is stable), so out-of-order input
 * arrays cannot change results.
 *
 * Date.parse-normalized three-way comparison: correct chronology even for
 * hand-edited non-Z offsets, and unparseable strings sort last so garbage
 * can never weigh the trend as the most recent behaviour. For all
 * producer-generated uniform Z-suffixed toISOString() values this orders
 * identically to the app module's byte comparison (parity holds on real
 * data; drift exists only on hand-edited inputs, where this is strictly
 * more correct). Ties keep insertion order (stable sort).
 * @param {Array<{capturedAt: string, errorDays: number}>} pairs
 * @returns {Array<{capturedAt: string, errorDays: number}>}
 */
function sortByCapturedAt(pairs) {
  // Date.parse-normalized keys so chronology is correct for hand-edited
  // non-Z offsets, and unparseable strings (garbage) sort LAST — the SAME
  // rule the response listing uses, so a garbage entry can never drive the
  // trend as the newest datapoint while the list shows it last. For all
  // producer-generated Z-suffixed ISO strings this orders identically to
  // plain byte comparison (the app module's rule); drift exists only on
  // hand-edited inputs, where this ordering is strictly more correct.
  const keyOf = (p) => {
    const parsed = Date.parse(p.capturedAt);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return [...pairs].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  });
}

/**
 * Compute one series' metrics from {capturedAt, errorDays} pairs.
 *
 * Precision trend: entries are split chronologically into first and second
 * half; with an odd count the FIRST half gets the extra element (the older
 * half is the larger one, so the delta weighs the more recent behaviour at
 * least as much). trendDelta = secondHalfMeanAbs - firstHalfMeanAbs:
 * negative = precision improving over time. The trend is only reported when
 * both halves hold at least one value; trendIsNoisy flags tiny series.
 *
 * @param {Array<{capturedAt: string, errorDays: number}>} pairs
 * @returns {object} metrics object with count and (when count > 0) means
 */
function computeSeriesMetrics(pairs) {
  const count = pairs.length;
  if (count === 0) {
    return { count: 0 };
  }

  const values = pairs.map((p) => p.errorDays);
  const metrics = {
    count,
    meanSignedErrorDays: mean(values),
    meanAbsoluteErrorDays: meanAbsolute(values),
  };

  const sorted = sortByCapturedAt(pairs);
  const firstHalfCount = Math.ceil(count / 2);
  const secondHalfCount = count - firstHalfCount;
  if (firstHalfCount >= 1 && secondHalfCount >= 1) {
    const firstHalfMeanAbs = meanAbsolute(
      sorted.slice(0, firstHalfCount).map((p) => p.errorDays),
    );
    const secondHalfMeanAbs = meanAbsolute(
      sorted.slice(firstHalfCount).map((p) => p.errorDays),
    );
    if (
      isFiniteNumber(firstHalfMeanAbs) &&
      isFiniteNumber(secondHalfMeanAbs)
    ) {
      metrics.precisionTrend = {
        trendDelta: secondHalfMeanAbs - firstHalfMeanAbs,
        firstHalfCount,
        secondHalfCount,
        trendIsNoisy: count < TREND_NOISY_MAX_COUNT,
      };
    }
  }

  return metrics;
}

/**
 * Extract one series' pairs from usable resolved entries.
 * @param {object[]} usable resolved entries with usable actualFinishDate
 * @param {string} errorKey 'errorDaysVsDefendable' | 'errorDaysVsPromised'
 * @returns {Array<{capturedAt: string, errorDays: number}>}
 */
function extractSeries(usable, errorKey) {
  const pairs = [];
  for (const entry of usable) {
    const errorDays = entry[errorKey];
    if (!isFiniteNumber(errorDays)) continue;
    // Same non-empty-string rule the span uses, so trend ordering and span
    // agree on what is scoreable; unparseable capturedAt sorts last in the
    // trend (same rule as the listing).
    if (typeof entry.capturedAt !== 'string' || !entry.capturedAt) continue;
    pairs.push({ capturedAt: entry.capturedAt, errorDays });
  }
  return pairs;
}

function emptyCounts() {
  return { resolvedCount: 0, openCount: 0, excludedCount: 0 };
}

function countTrail(trail) {
  const counts = emptyCounts();
  const usable = [];
  for (const entry of Array.isArray(trail) ? trail : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.resolved !== true) {
      counts.openCount += 1;
      continue;
    }
    counts.resolvedCount += 1;
    if (!isScorableDate(entry.actualFinishDate)) {
      counts.excludedCount += 1;
      continue;
    }
    usable.push(entry);
  }
  return { ...counts, usable };
}

/**
 * Compute calibration metrics for one project (port of the app's
 * computeProjectCalibration — semantics identical, field for field).
 *
 * @param {object} project project record with an optional calibrationTrail
 * @returns {object} metrics object:
 *   - {status:'insufficient_data', reason, usableCount, neededMin, counts}
 *     when fewer than MIN_USABLE_ENTRIES usable resolved entries exist
 *     (contains NO means — nothing is fabricated).
 *   - {status:'ready', usableCount, counts, span, series:{defendable,
 *     promised}} otherwise, where each series is computed independently over
 *     exactly the entries that recorded that forecast.
 */
export function computeProjectCalibration(project) {
  const trail = Array.isArray(project?.calibrationTrail)
    ? project.calibrationTrail
    : [];
  const { resolvedCount, openCount, excludedCount, usable } =
    countTrail(trail);
  const counts = { resolvedCount, openCount, excludedCount };
  const usableCount = usable.length;

  const base = { ...counts, usableCount, neededMin: MIN_USABLE_ENTRIES };

  if (usableCount < MIN_USABLE_ENTRIES) {
    return {
      status: 'insufficient_data',
      reason:
        usableCount === 0
          ? 'No resolved trail entries with an actual finish date.'
          : `Only ${usableCount} of ${MIN_USABLE_ENTRIES} required resolved entries have an actual finish date.`,
      ...base,
    };
  }

  // Chronological span of the USED (usable) entries: same parse-normalized
  // chronology as the trend split and the listing (one rule, three uses).
  // Reports the ORIGINAL capturedAt strings at the epoch min/max.
  const dated = usable
    .map((e) => {
      const t = typeof e.capturedAt === 'string' && e.capturedAt
        ? Date.parse(e.capturedAt)
        : NaN;
      return { str: e.capturedAt, key: Number.isFinite(t) ? t : null };
    })
    .filter((d) => d.key !== null)
    .sort((a, b) => a.key - b.key);
  const span = {
    firstCapturedAt: dated[0]?.str ?? null,
    lastCapturedAt: dated[dated.length - 1]?.str ?? null,
  };

  return {
    status: 'ready',
    ...base,
    span,
    series: {
      defendable: computeSeriesMetrics(
        extractSeries(usable, 'errorDaysVsDefendable'),
      ),
      promised: computeSeriesMetrics(
        extractSeries(usable, 'errorDaysVsPromised'),
      ),
    },
  };
}

/**
 * Whether a project has any calibration trail at all (mirrors the app's
 * hasCalibrationTrail).
 * @param {object} project
 * @returns {boolean}
 */
export function hasCalibrationTrail(project) {
  const trail = project?.calibrationTrail;
  return Array.isArray(trail) && trail.length > 0;
}

/**
 * Short honest label for a series' mean signed error. Labels are verbatim
 * app strings — coaches and the UI quote them.
 * @param {number|null|undefined} meanSignedErrorDays
 * @returns {string|null}
 */
export function describeBias(meanSignedErrorDays) {
  if (!isFiniteNumber(meanSignedErrorDays)) return null;
  const abs = Math.abs(meanSignedErrorDays);
  if (abs <= BIAS_WELL_CALIBRATED_THRESHOLD_DAYS) return 'well-calibrated';
  return meanSignedErrorDays > 0
    ? 'runs optimistic (finishes late)'
    : 'runs conservative (finishes early)';
}

/**
 * Trail status for one project, for discovery lists and single-project
 * reads: 'no_trail' | 'insufficient_data' | 'ready'.
 * @param {object} project
 * @returns {object} {status, resolvedCount, openCount, excludedCount}
 */
export function readTrailSummary(project) {
  const trail = Array.isArray(project?.calibrationTrail)
    ? project.calibrationTrail
    : [];
  const { resolvedCount, openCount, excludedCount } = countTrail(trail);
  return {
    status: !hasCalibrationTrail(project)
      ? 'no_trail'
      : resolvedCount - excludedCount >= MIN_USABLE_ENTRIES
        ? // careful: usability also requires a scorable actualFinishDate,
          // which is exactly what excludedCount measures for resolved
          // entries — resolved - excluded == usable count.
          'ready'
        : 'insufficient_data',
    resolvedCount,
    openCount,
    excludedCount,
  };
}

/**
 * Series metrics plus the bias label (describeBias over the series' mean
 * signed error; label absent when no mean exists — nothing fabricated).
 * @param {Array<{capturedAt: string, errorDays: number}>} pairs
 * @returns {object}
 */
function seriesWithBias(pairs) {
  const metrics = computeSeriesMetrics(pairs);
  const bias = describeBias(metrics.meanSignedErrorDays);
  return bias ? { ...metrics, bias } : metrics;
}

/**
 * Render one resolved entry for the response boundary: the forecast dates,
 * the actual finish, and the signed whole-day errors (+late, -early) per
 * recorded series. Non-finite stored errors read as null — honest absence,
 * never a fabricated number.
 * @param {object} entry usable resolved trail entry
 * @returns {object}
 */
function renderResolvedEntry(entry) {
  const pickError = (v) => (isFiniteNumber(v) ? v : null);
  return {
    weekId: typeof entry.weekId === 'string' ? entry.weekId : null,
    capturedAt: typeof entry.capturedAt === 'string' ? entry.capturedAt : null,
    resolvedAt: typeof entry.resolvedAt === 'string' ? entry.resolvedAt : null,
    defendableDate: typeof entry.defendableDate === 'string' ? entry.defendableDate : null,
    promisedDate: typeof entry.promisedDate === 'string' ? entry.promisedDate : null,
    actualFinishDate: typeof entry.actualFinishDate === 'string' ? entry.actualFinishDate : null,
    errorDaysVsDefendable: pickError(entry.errorDaysVsDefendable),
    errorDaysVsPromised: pickError(entry.errorDaysVsPromised),
  };
}

/**
 * Sort usable resolved entries NEWEST-FIRST by capturedAt for the
 * response listing. Never mutates the input.
 *
 * Keys are Date.parse-normalized epoch values: correct chronology even
 * when hand-edited files carry non-Z offsets (+01:00), and any capturedAt
 * that is not a string or does not parse (garbage like 'banana') sorts
 * LAST so it can never present itself as the most recent entry. Parseable
 * keys keep insertion order on ties (stable sort); unparseable keys keep
 * relative order among themselves.
 *
 * Note: this listing key is deliberately MORE forgiving than the app's
 * byte-order span sort (which is scoped to the producer's uniform
 * Z-suffixed toISOString output). The span/trend metrics intentionally
 * mirror the app module byte-for-byte (parity rule); only the display
 * listing normalizes.
 * @param {object[]} usable
 * @returns {object[]}
 */
function newestFirst(usable) {
  const keyOf = (entry) => {
    if (typeof entry.capturedAt !== 'string' || !entry.capturedAt) return null;
    const parsed = Date.parse(entry.capturedAt);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return [...usable].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return kb - ka;
  });
}

/**
 * Full calibration-history record for one project — the MCP
 * calibration_history payload body (project id/name added by the caller).
 *
 * For a trail-less project this is an explicit, honest no_trail record.
 * For insufficient data it reports the counts and the reason with NO
 * means. When ready it adds the bias labels, per-series stats, and the
 * resolved entries newest-first, capped at MAX_LISTED_ENTRIES with the cap
 * reported.
 *
 * @param {object} project project record with an optional calibrationTrail
 * @param {object} [options] { maxEntries?: number } — response cap override
 *   (tests); default MAX_LISTED_ENTRIES. Never mutates the project.
 * @returns {object} {status, trailSummary, [reason], [span], [series],
 *   [entries, entryCount, entriesTruncated], read-only payload shape}
 */
export function computeCalibrationHistory(project, options = {}) {
  const rawMax = options.maxEntries;
  const maxEntries =
    Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : MAX_LISTED_ENTRIES;

  const summary = readTrailSummary(project);
  if (summary.status === 'no_trail') {
    return {
      status: 'no_trail',
      trailSummary: summary,
    };
  }

  const metrics = computeProjectCalibration(project);
  if (metrics.status === 'insufficient_data') {
    return {
      status: 'insufficient_data',
      reason: metrics.reason,
      trailSummary: summary,
      usableCount: metrics.usableCount,
      neededMin: metrics.neededMin,
    };
  }

  // Ready: rebuild the usable set once more (cheap, pure) for the entry
  // listing; countTrail is the single gate for what is scoreable.
  const { usable } = countTrail(project.calibrationTrail);
  const ordered = newestFirst(usable);
  const shown = ordered.slice(0, maxEntries);

  return {
    status: 'ready',
    trailSummary: summary,
    span: metrics.span,
    series: {
      defendable: seriesWithBias(
        extractSeries(usable, 'errorDaysVsDefendable'),
      ),
      promised: seriesWithBias(
        extractSeries(usable, 'errorDaysVsPromised'),
      ),
    },
    entries: shown.map(renderResolvedEntry),
    entryCount: ordered.length,
    entriesTruncated: ordered.length > shown.length,
  };
}
