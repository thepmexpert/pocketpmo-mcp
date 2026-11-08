import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_USABLE_ENTRIES,
  BIAS_WELL_CALIBRATED_THRESHOLD_DAYS,
  TREND_NOISY_MAX_COUNT,
  MAX_LISTED_ENTRIES,
  computeProjectCalibration,
  computeCalibrationHistory,
  readTrailSummary,
  hasCalibrationTrail,
  describeBias
} from '../lib/calibration.js';

// Hand-computed fixtures. Error values below are typed in BY HAND from the
// fixture design (never re-derived by calling the code under test) — each
// expected number in an assertion traces to these literals.

let seq = 0;
// Build a resolved entry. capturedAt is the chronological key (the app
// writes Date.toISOString() there); errors are signed whole days
// (+late = optimistic, -early = conservative).
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

function project(trail) {
  return { id: 'p1', name: 'Fixture Project', calibrationTrail: trail };
}

describe('constants mirror the app module', () => {
  test('thresholds', () => {
    assert.equal(MIN_USABLE_ENTRIES, 3);
    assert.equal(BIAS_WELL_CALIBRATED_THRESHOLD_DAYS, 2);
    assert.equal(TREND_NOISY_MAX_COUNT, 6);
    assert.equal(MAX_LISTED_ENTRIES, 20);
  });
});

describe('describeBias (verbatim app labels)', () => {
  test('well-calibrated within +/-2 days inclusive', () => {
    assert.equal(describeBias(0), 'well-calibrated');
    assert.equal(describeBias(2), 'well-calibrated');
    assert.equal(describeBias(-2), 'well-calibrated');
    assert.equal(describeBias(1 / 3), 'well-calibrated');
  });
  test('optimistic (late) above +2, conservative (early) below -2', () => {
    assert.equal(describeBias(4), 'runs optimistic (finishes late)');
    assert.equal(describeBias(-4), 'runs conservative (finishes early)');
    assert.equal(describeBias(2.01), 'runs optimistic (finishes late)');
    assert.equal(describeBias(-2.01), 'runs conservative (finishes early)');
  });
  test('non-finite mean -> null (no label fabricated)', () => {
    assert.equal(describeBias(null), null);
    assert.equal(describeBias(undefined), null);
    assert.equal(describeBias(NaN), null);
    assert.equal(describeBias('3'), null);
  });
});

describe('computeProjectCalibration — bias fixtures', () => {
  // LATE fixture: defendable errors +5,+3,+7,+1 (mean 4, meanAbs 4);
  // promised errors +8,+2,+10,+4 (mean 6, meanAbs 6).
  const late = project([
    resolved('2026-01-05T09:00:00.000Z', 5, 8),
    resolved('2026-01-12T09:00:00.000Z', 3, 2),
    resolved('2026-01-19T09:00:00.000Z', 7, 10),
    resolved('2026-01-26T09:00:00.000Z', 1, 4)
  ]);

  test('ready with means computed over each series independently', () => {
    const m = computeProjectCalibration(late);
    assert.equal(m.status, 'ready');
    assert.equal(m.usableCount, 4);
    assert.equal(m.counts, undefined); // flat counts, app shape
    assert.equal(m.resolvedCount, 4);
    assert.equal(m.openCount, 0);
    assert.equal(m.excludedCount, 0);
    assert.deepEqual(m.span, {
      firstCapturedAt: '2026-01-05T09:00:00.000Z',
      lastCapturedAt: '2026-01-26T09:00:00.000Z'
    });
    // defendable: (5+3+7+1)/4 = 4 signed, abs mean 4
    assert.equal(m.series.defendable.count, 4);
    assert.equal(m.series.defendable.meanSignedErrorDays, 4);
    assert.equal(m.series.defendable.meanAbsoluteErrorDays, 4);
    // promised: (8+2+10+4)/4 = 6 signed, abs mean 6
    assert.equal(m.series.promised.count, 4);
    assert.equal(m.series.promised.meanSignedErrorDays, 6);
    assert.equal(m.series.promised.meanAbsoluteErrorDays, 6);
  });

  test('late project labels optimistic on both series', () => {
    const m = computeProjectCalibration(late);
    assert.equal(describeBias(m.series.defendable.meanSignedErrorDays), 'runs optimistic (finishes late)');
    assert.equal(describeBias(m.series.promised.meanSignedErrorDays), 'runs optimistic (finishes late)');
  });

  // EARLY fixture: errors -2,-4,-6 chronological (mean -4, meanAbs 4).
  const early = project([
    resolved('2026-02-02T09:00:00.000Z', -2, -5),
    resolved('2026-02-09T09:00:00.000Z', -4, -7),
    resolved('2026-02-16T09:00:00.000Z', -6, -9)
  ]);

  test('early project labels conservative, means by hand', () => {
    const m = computeProjectCalibration(early);
    assert.equal(m.status, 'ready');
    assert.equal(m.usableCount, 3);
    // defendable: (-2-4-6)/3 = -4
    assert.equal(m.series.defendable.meanSignedErrorDays, -4);
    assert.equal(m.series.defendable.meanAbsoluteErrorDays, 4);
    // promised: (-5-7-9)/3 = -7
    assert.equal(m.series.promised.meanSignedErrorDays, -7);
    assert.equal(m.series.promised.meanAbsoluteErrorDays, 7);
    assert.equal(describeBias(m.series.defendable.meanSignedErrorDays), 'runs conservative (finishes early)');
  });

  // WELL fixture: +1,-2,+2 -> mean 1/3, inside the +/-2 band.
  test('well-calibrated band', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', 1, 0),
        resolved('2026-02-09T09:00:00.000Z', -2, 1),
        resolved('2026-02-16T09:00:00.000Z', 2, -1)
      ])
    );
    assert.equal(m.series.defendable.meanSignedErrorDays, 1 / 3);
    assert.equal(describeBias(m.series.defendable.meanSignedErrorDays), 'well-calibrated');
    assert.equal(m.series.promised.meanSignedErrorDays, 0);
    assert.equal(describeBias(m.series.promised.meanSignedErrorDays), 'well-calibrated');
  });

  test('series are computed independently: an entry with only one recorded forecast contributes to that series only', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', 5, null),
        resolved('2026-02-09T09:00:00.000Z', 7, null),
        resolved('2026-02-16T09:00:00.000Z', 6, null)
      ])
    );
    assert.equal(m.status, 'ready');
    // (5+7+6)/3 = 6
    assert.equal(m.series.defendable.meanSignedErrorDays, 6);
    assert.equal(m.series.promised.count, 0);
    assert.equal(m.series.promised.meanSignedErrorDays, undefined);
    assert.equal(describeBias(m.series.promised.meanSignedErrorDays), null);
  });
});

describe('computeProjectCalibration — precision trend fixtures', () => {
  test('clear trend over 6 entries: firstHalf [1,3] abs 2, secondHalf [9,8,10] abs 9, delta +7, not noisy', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-01-05T09:00:00.000Z', 1, 1),
        resolved('2026-01-12T09:00:00.000Z', 3, 3),
        resolved('2026-01-19T09:00:00.000Z', 2, 2),
        resolved('2026-01-26T09:00:00.000Z', 9, 9),
        resolved('2026-02-02T09:00:00.000Z', 8, 8),
        resolved('2026-02-09T09:00:00.000Z', 10, 10)
      ])
    );
    const t = m.series.defendable.precisionTrend;
    assert.deepEqual(
      { firstHalfCount: t.firstHalfCount, secondHalfCount: t.secondHalfCount },
      { firstHalfCount: 3, secondHalfCount: 3 }
    );
    assert.equal(t.trendDelta, 7);
    assert.equal(t.trendIsNoisy, false);
  });

  test('improving trend has negative delta', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-01-05T09:00:00.000Z', 9, 9),
        resolved('2026-01-12T09:00:00.000Z', 8, 8),
        resolved('2026-01-19T09:00:00.000Z', 10, 10),
        resolved('2026-01-26T09:00:00.000Z', 1, 1),
        resolved('2026-02-02T09:00:00.000Z', 3, 3),
        resolved('2026-02-09T09:00:00.000Z', 2, 2)
      ])
    );
    const t = m.series.defendable.precisionTrend;
    // firstHalf [9,8,10] abs 9; secondHalf [1,3,2] abs 2; delta -7
    assert.equal(t.trendDelta, -7);
    assert.equal(t.trendIsNoisy, false);
  });

  test('odd count: FIRST half gets the extra element (3 entries -> 2/1)', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', -2, -5),
        resolved('2026-02-09T09:00:00.000Z', -4, -7),
        resolved('2026-02-16T09:00:00.000Z', -6, -9)
      ])
    );
    const t = m.series.defendable.precisionTrend;
    assert.equal(t.firstHalfCount, 2);
    assert.equal(t.secondHalfCount, 1);
    // firstHalf [-2,-4] abs mean 3; secondHalf [-6] abs 6; delta +3
    assert.equal(t.trendDelta, 3);
    assert.equal(t.trendIsNoisy, true); // count 3 < 6
  });

  test('out-of-order input arrays cannot change the trend (chronological sort)', () => {
    const ordered = project([
      resolved('2026-01-05T09:00:00.000Z', 1, 1),
      resolved('2026-01-12T09:00:00.000Z', 3, 3),
      resolved('2026-01-19T09:00:00.000Z', 2, 2),
      resolved('2026-01-26T09:00:00.000Z', 9, 9),
      resolved('2026-02-02T09:00:00.000Z', 8, 8),
      resolved('2026-02-09T09:00:00.000Z', 10, 10)
    ]);
    const shuffled = project([
      resolved('2026-02-09T09:00:00.000Z', 10, 10),
      resolved('2026-01-19T09:00:00.000Z', 2, 2),
      resolved('2026-01-05T09:00:00.000Z', 1, 1),
      resolved('2026-02-02T09:00:00.000Z', 8, 8),
      resolved('2026-01-26T09:00:00.000Z', 9, 9),
      resolved('2026-01-12T09:00:00.000Z', 3, 3)
    ]);
    const a = computeProjectCalibration(ordered);
    const b = computeProjectCalibration(shuffled);
    assert.deepEqual(b.series.defendable, a.series.defendable);
    assert.equal(b.series.defendable.precisionTrend.trendDelta, 7);
  });

  test('a series with zero recorded entries reports no trend and no means', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', 5, null),
        resolved('2026-02-09T09:00:00.000Z', 5, null),
        resolved('2026-02-16T09:00:00.000Z', 5, null)
      ])
    );
    assert.equal(m.status, 'ready');
    // 3 usable entries => defendable gets a 2/1 split trend, noisy at count 3
    assert.equal(m.series.defendable.precisionTrend.trendIsNoisy, true);
    // promised recorded nothing -> count 0, no trend, no means
    assert.equal(m.series.promised.count, 0);
    assert.equal(m.series.promised.precisionTrend, undefined);
    assert.equal(m.series.promised.meanSignedErrorDays, undefined);
  });
});

describe('computeProjectCalibration — insufficient data honesty', () => {
  test('no trail key -> insufficient_data with no numeric claims', () => {
    const m = computeProjectCalibration({ id: 'p', name: 'P' });
    assert.equal(m.status, 'insufficient_data');
    assert.equal(m.usableCount, 0);
    assert.equal(m.reason, 'No resolved trail entries with an actual finish date.');
    assert.equal(m.meanSignedErrorDays, undefined);
    assert.equal(m.series, undefined);
    assert.equal(m.span, undefined);
  });

  test('empty trail array -> insufficient_data', () => {
    const m = computeProjectCalibration(project([]));
    assert.equal(m.status, 'insufficient_data');
    assert.equal(m.usableCount, 0);
  });

  test('two usable entries -> explicit only-2-of-3 reason', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', 5, 5),
        resolved('2026-02-09T09:00:00.000Z', 7, 7)
      ])
    );
    assert.equal(m.status, 'insufficient_data');
    assert.equal(m.usableCount, 2);
    assert.equal(m.neededMin, 3);
    assert.equal(m.reason, 'Only 2 of 3 required resolved entries have an actual finish date.');
    assert.equal(m.series, undefined);
  });

  test('three resolved entries but one impossible date -> only 2 usable -> insufficient_data, exclusion reported', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', 5, 5),
        resolved('2026-02-09T09:00:00.000Z', 7, 7),
        resolved('2026-02-16T09:00:00.000Z', 6, 6, { actualFinishDate: '2026-02-30' })
      ])
    );
    assert.equal(m.status, 'insufficient_data');
    assert.equal(m.resolvedCount, 3);
    assert.equal(m.excludedCount, 1);
    assert.equal(m.usableCount, 2);
  });
});

describe('garbage-entry exclusion (app isScorableDate / finite-guard parity)', () => {
  test('impossible calendar dates are excluded, never scored', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'not-a-date', '', '20260201']) {
      const m = computeProjectCalibration(
        project([
          resolved('2026-02-02T09:00:00.000Z', 5, 5),
          resolved('2026-02-09T09:00:00.000Z', 7, 7),
          resolved('2026-02-16T09:00:00.000Z', 6, 6, { actualFinishDate: bad })
        ])
      );
      assert.equal(m.excludedCount, 1, `actualFinishDate ${JSON.stringify(bad)} must exclude`);
    }
  });

  test('YYYY-MM-DD prefix with time suffix still scores (app prefix rule)', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', 5, 5),
        resolved('2026-02-09T09:00:00.000Z', 7, 7),
        resolved('2026-02-16T09:00:00.000Z', 6, 6, { actualFinishDate: '2026-03-01T17:00:00.000Z' })
      ])
    );
    assert.equal(m.status, 'ready');
    assert.equal(m.excludedCount, 0);
  });

  test('non-finite error in one series excludes it from THAT series only', () => {
    const m = computeProjectCalibration(
      project([
        resolved('2026-02-02T09:00:00.000Z', NaN, 4),
        resolved('2026-02-09T09:00:00.000Z', 'x', 6),
        resolved('2026-02-16T09:00:00.000Z', 6, 8)
      ])
    );
    assert.equal(m.status, 'ready'); // 3 usable entries; garbage is per-series
    assert.equal(m.excludedCount, 0); // exclusion is per-series, not per-entry
    assert.equal(m.series.defendable.count, 1);
    assert.equal(m.series.defendable.meanSignedErrorDays, 6);
    assert.equal(m.series.promised.count, 3);
    assert.equal(m.series.promised.meanSignedErrorDays, 6); // (4+6+8)/3
  });

  test('non-string capturedAt never sorts into a series or the span', () => {
    const m = computeProjectCalibration(
      project([
        resolved(42, 5, 5),
        resolved('2026-02-09T09:00:00.000Z', 7, 7),
        resolved('2026-02-16T09:00:00.000Z', 6, 6)
      ])
    );
    assert.equal(m.status, 'ready');
    assert.equal(m.usableCount, 3); // entry is usable: actualFinishDate scores
    assert.equal(m.series.defendable.count, 2); // garbage capturedAt drops from series
    assert.deepEqual(m.span, {
      firstCapturedAt: '2026-02-09T09:00:00.000Z',
      lastCapturedAt: '2026-02-16T09:00:00.000Z'
    });
  });

  test('non-object trail entries are skipped entirely', () => {
    const m = computeProjectCalibration(
      project([null, 42, 'oops', resolved('2026-02-02T09:00:00.000Z', 5, 5), resolved('2026-02-09T09:00:00.000Z', 7, 7), resolved('2026-02-16T09:00:00.000Z', 6, 6)])
    );
    assert.equal(m.status, 'ready');
    assert.equal(m.resolvedCount, 3);
    assert.equal(m.openCount, 0);
  });

  test('resolved !== true counts as open even when it carries errors and dates', () => {
    const m = computeProjectCalibration(
      project([
        open({ errorDaysVsDefendable: 99, errorDaysVsPromised: 99, actualFinishDate: '2026-04-01' }),
        resolved('2026-02-02T09:00:00.000Z', 5, 5),
        resolved('2026-02-09T09:00:00.000Z', 7, 7),
        resolved('2026-02-16T09:00:00.000Z', 6, 6)
      ])
    );
    assert.equal(m.openCount, 1);
    assert.equal(m.resolvedCount, 3);
    // 99 must not leak into any mean
    assert.equal(m.series.defendable.meanSignedErrorDays, 6);
  });
});

describe('open vs resolved separation and counts', () => {
  test('readTrailSummary reports no_trail for missing/empty trail', () => {
    assert.equal(readTrailSummary({ id: 'p' }).status, 'no_trail');
    assert.equal(readTrailSummary(project([])).status, 'no_trail');
    assert.equal(hasCalibrationTrail({ id: 'p' }), false);
    assert.equal(hasCalibrationTrail(project([])), false);
    assert.equal(hasCalibrationTrail(project([open()])), true);
  });

  test('readTrailSummary statuses and counts', () => {
    const ready = readTrailSummary(project([
      open(),
      resolved('2026-02-02T09:00:00.000Z', 5, 5),
      resolved('2026-02-09T09:00:00.000Z', 7, 7),
      resolved('2026-02-16T09:00:00.000Z', 6, 6),
      resolved('2026-02-16T09:00:00.000Z', 6, 6, { actualFinishDate: '2026-02-31' })
    ]));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.resolvedCount, 4);
    assert.equal(ready.openCount, 1);
    assert.equal(ready.excludedCount, 1);

    const insufficient = readTrailSummary(project([open(), open()]));
    assert.equal(insufficient.status, 'insufficient_data');
    assert.equal(insufficient.openCount, 2);
  });
});

describe('computeCalibrationHistory — response record', () => {
  test('no_trail record is honest and minimal', () => {
    const h = computeCalibrationHistory({ id: 'p', name: 'P' });
    assert.equal(h.status, 'no_trail');
    assert.equal(h.trailSummary.status, 'no_trail');
    assert.equal(h.series, undefined);
    assert.equal(h.entries, undefined);
  });

  test('insufficient_data record carries reason, no series', () => {
    const h = computeCalibrationHistory(project([open()]));
    assert.equal(h.status, 'insufficient_data');
    assert.ok(h.reason.includes('No resolved trail entries'));
    assert.equal(h.series, undefined);
  });

  const late = project([
    resolved('2026-01-05T09:00:00.000Z', 5, 8, { weekId: '2026-W1' }),
    resolved('2026-01-12T09:00:00.000Z', 3, 2, { weekId: '2026-W2' }),
    resolved('2026-01-19T09:00:00.000Z', 7, 10, { weekId: '2026-W3' }),
    resolved('2026-01-26T09:00:00.000Z', 1, 4, { weekId: '2026-W4' })
  ]);

  test('ready record: bias labels, series stats, newest-first entries', () => {
    const h = computeCalibrationHistory(late);
    assert.equal(h.status, 'ready');
    assert.equal(h.trailSummary.status, 'ready');
    assert.equal(h.series.defendable.bias, 'runs optimistic (finishes late)');
    assert.equal(h.series.promised.bias, 'runs optimistic (finishes late)');
    assert.equal(h.series.defendable.meanSignedErrorDays, 4);
    assert.equal(h.entries.length, 4);
    // newest first
    assert.deepEqual(
      h.entries.map((e) => e.capturedAt),
      [
        '2026-01-26T09:00:00.000Z',
        '2026-01-19T09:00:00.000Z',
        '2026-01-12T09:00:00.000Z',
        '2026-01-05T09:00:00.000Z'
      ]
    );
    assert.deepEqual(h.entries[0], {
      weekId: '2026-W4',
      capturedAt: '2026-01-26T09:00:00.000Z',
      resolvedAt: '2026-01-26T09:00:00.000Z',
      defendableDate: '2026-03-01',
      promisedDate: '2026-03-15',
      actualFinishDate: '2026-04-01',
      errorDaysVsDefendable: 1,
      errorDaysVsPromised: 4
    });
    assert.equal(h.entryCount, 4);
    assert.equal(h.entriesTruncated, false);
  });

  test('entry cap: 25 usable entries -> 20 shown, truncation reported', () => {
    const trail = [];
    for (let i = 0; i < 25; i++) {
      trail.push(resolved(`2026-03-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`, i % 5, i % 3));
    }
    const h = computeCalibrationHistory(project(trail));
    assert.equal(h.entries.length, 20);
    assert.equal(h.entryCount, 25);
    assert.equal(h.entriesTruncated, true);
    assert.equal(h.entries[0].capturedAt, '2026-03-25T09:00:00.000Z');
    // series still computed over ALL 25 usable entries, not the shown 20
    assert.equal(h.series.defendable.count, 25);
  });

  test('maxEntries override for callers/tests', () => {
    const h = computeCalibrationHistory(late, { maxEntries: 2 });
    assert.equal(h.entries.length, 2);
    assert.equal(h.entriesTruncated, true);
    // invalid overrides fall back to the default cap
    const h2 = computeCalibrationHistory(late, { maxEntries: 0 });
    assert.equal(h2.entries.length, 4);
  });

  test('garbage capturedAt entries sort last in the newest-first list', () => {
    const h = computeCalibrationHistory(
      project([
        resolved(42, 5, 5),
        resolved('2026-01-12T09:00:00.000Z', 3, 2),
        resolved('2026-01-19T09:00:00.000Z', 7, 10)
      ])
    );
    assert.equal(h.entryCount, 3);
    assert.equal(h.entries[0].capturedAt, '2026-01-19T09:00:00.000Z');
    assert.equal(h.entries[1].capturedAt, '2026-01-12T09:00:00.000Z');
    assert.equal(h.entries[2].capturedAt, null); // garbage rendered honestly
  });

  test('non-finite stored errors render as null, never fabricated', () => {
    const h = computeCalibrationHistory(
      project([
        resolved('2026-02-02T09:00:00.000Z', NaN, 4),
        resolved('2026-02-09T09:00:00.000Z', 7, 'gone'),
        resolved('2026-02-16T09:00:00.000Z', 6, 8)
      ])
    );
    assert.equal(h.entries[2].errorDaysVsDefendable, null);
    assert.equal(h.entries[1].errorDaysVsPromised, null);
    assert.equal(h.entries[0].errorDaysVsPromised, 8);
  });
});

describe('no-mutation guarantee', () => {
  test('deeply frozen project: every function reads without writing', () => {
    const trail = [
      open(),
      resolved('2026-01-12T09:00:00.000Z', 3, 2),
      resolved('2026-01-05T09:00:00.000Z', 5, 8),
      resolved('2026-01-19T09:00:00.000Z', 7, 10)
    ];
    const p = project(trail);
    const freeze = (x) => {
      if (x && typeof x === 'object') {
        for (const k of Object.keys(x)) freeze(x[k]);
        Object.freeze(x);
      }
      return x;
    };
    freeze(p);
    const before = JSON.stringify(p);
    // All of these throw a TypeError in strict mode (ESM) on ANY mutation.
    assert.equal(computeProjectCalibration(p).status, 'ready');
    assert.equal(computeCalibrationHistory(p).status, 'ready');
    assert.equal(readTrailSummary(p).status, 'ready');
    assert.equal(hasCalibrationTrail(p), true);
    assert.equal(describeBias(4), 'runs optimistic (finishes late)');
    assert.equal(JSON.stringify(p), before);
  });

  test('non-frozen input is left untouched (structural deep-equal)', () => {
    const trail = [
      resolved('2026-01-12T09:00:00.000Z', 3, 2),
      resolved('2026-01-05T09:00:00.000Z', 5, 8),
      resolved('2026-01-19T09:00:00.000Z', 7, 10)
    ];
    const p = project(trail);
    const before = JSON.parse(JSON.stringify(p));
    computeCalibrationHistory(p);
    computeProjectCalibration(p);
    assert.deepEqual(JSON.parse(JSON.stringify(p)), before);
    assert.deepEqual(
      trail.map((e) => e.capturedAt),
      ['2026-01-12T09:00:00.000Z', '2026-01-05T09:00:00.000Z', '2026-01-19T09:00:00.000Z']
    ); // original array order untouched
  });
});
