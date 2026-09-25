import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateActivities, runMonteCarlo, makeRng } from '../lib/calculators.js';

const act = (id, extra = {}) => ({ id, duration: 5, ...extra });

// The bridge's CPM pass is finish-to-start only (mirrors the app). Project
// files are hand-editable JSON, so a file CAN declare SS/FF types or lag on
// predecessor objects — the parser drops those fields silently today. The
// contract: any declared-but-unsupported dependency semantic surfaces as a
// structured issue (warn-and-continue), on every path that consumes the
// dependency network (validateActivities feeds both critical_path and
// monte_carlo).

describe('unsupported dependency declarations (SS/FF/lag) — warn-and-continue', () => {
  test('SS-declared predecessor emits an issue saying it is treated as FS', () => {
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [{ id: 'a', type: 'SS' }] })
    ]);
    const hit = issues.find(
      (i) => i.activityId === 'b' && i.field === 'predecessors' && /SS/.test(i.message)
    );
    assert.ok(hit, `expected an SS dependency issue, got: ${JSON.stringify(issues)}`);
    assert.match(hit.message, /finish-to-start/);
    assert.deepEqual(hit.received, { type: 'SS', lag: null });
  });

  test('FF-declared predecessor is flagged too', () => {
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [{ id: 'a', type: 'FF' }] })
    ]);
    assert.ok(issues.some((i) => /FF/.test(i.message)));
  });

  test('nonzero lag on an FS predecessor is flagged', () => {
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [{ id: 'a', type: 'FS', lag: 2 }] })
    ]);
    const hit = issues.find((i) => i.activityId === 'b' && /lag/.test(i.message));
    assert.ok(hit, 'expected a lag issue on the FS predecessor');
    assert.match(hit.message, /finish-to-start/);
  });

  test('lowercase type declarations are normalized before comparison', () => {
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [{ id: 'a', type: 'ss' }] })
    ]);
    assert.ok(issues.some((i) => /"ss"/.test(i.message)));
  });

  test('non-numeric lag is flagged with its raw value', () => {
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [{ id: 'a', lag: '2d' }] })
    ]);
    const hit = issues.find((i) => i.activityId === 'b');
    assert.ok(hit, 'expected an issue for non-numeric lag');
    assert.deepEqual(hit.received, { type: null, lag: '2d' });
  });

  test('explicit FS with zero lag and plain string lists emit NO issue (clean path pin)', () => {
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [{ id: 'a', type: 'FS', lag: 0 }] }),
      act('c', { predecessors: 'a, b' })
    ]);
    // Exact: the dependency check must not leak anything into the clean path.
    assert.deepEqual(issues, []);
  });

  test('unusable predecessor objects (null entries, non-object, no id) emit no NEW issue class', () => {
    // Those shapes are already reported (or ignored) by existing checks;
    // the dependency-type sweep must not double-report them.
    const issues = validateActivities([
      act('a'),
      act('b', { predecessors: [null, 42, { nope: true }, 'a'] })
    ]);
    assert.ok(issues.every((i) => !/declares/.test(i.message)),
      `dependency-type issues must not fire on id-less objects: ${JSON.stringify(issues)}`);
  });

  test('monte_carlo path reports the warning (sibling call path via shared validator)', () => {
    const result = runMonteCarlo({
      activities: [act('a'), act('b', { predecessors: [{ id: 'a', type: 'SS' }] })],
      iterations: 10,
      rng: makeRng(7),
      targets: []
    });
    assert.ok(
      result.issues.some((i) => /SS/.test(i.message)),
      `expected SS warning in monte carlo issues: ${JSON.stringify(result.issues)}`
    );
  });
});
