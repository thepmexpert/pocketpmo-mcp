import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pertStats,
  pertRollup,
  pertCompletionProbability,
  round2
} from '../lib/calculators.js';

test('pertStats: golden case o=3 m=5 p=9', () => {
  const s = pertStats(3, 5, 9);
  // Full precision: expected = 16/3 = 5.333..., variance = 1, stdDev = 1.
  // Rounding happens at the API boundary (pertRollup, tool layer), not here.
  assert.ok(Math.abs(s.expected - 16 / 3) < 1e-12);
  assert.equal(s.variance, 1);
  assert.equal(s.stdDev, 1);
});

test('pertStats: degenerate o=m=p has zero variance', () => {
  const s = pertStats(5, 5, 5);
  assert.equal(s.expected, 5);
  assert.equal(s.variance, 0);
  assert.equal(s.stdDev, 0);
});

test('pertStats: non-finite input returns NaN, never throws', () => {
  const s = pertStats(Number.NaN, 5, 9);
  assert.ok(Number.isNaN(s.expected));
  assert.ok(Number.isNaN(s.variance));
  assert.ok(Number.isNaN(s.stdDev));
});

test('pertStats: reversed ordering o > m > p returns NaN', () => {
  // (10, 5, 2) previously produced a plausible-looking but wrong estimate.
  const s = pertStats(10, 5, 2);
  assert.ok(Number.isNaN(s.expected));
  assert.ok(Number.isNaN(s.variance));
  assert.ok(Number.isNaN(s.stdDev));
});

test('pertStats: partial ordering violation o > m returns NaN', () => {
  const s = pertStats(6, 5, 9);
  assert.ok(Number.isNaN(s.expected));
});

test('pertStats: partial ordering violation m > p returns NaN', () => {
  const s = pertStats(3, 10, 9);
  assert.ok(Number.isNaN(s.expected));
});

test('pertStats: negative estimates return NaN', () => {
  assert.ok(Number.isNaN(pertStats(-2, 5, 9).expected));
  assert.ok(Number.isNaN(pertStats(3, -1, 9).expected));
  assert.ok(Number.isNaN(pertStats(3, 5, -4).expected));
});

test('pertStats: boundary o=m=p=0 is valid (zero variance, zero expected)', () => {
  const s = pertStats(0, 0, 0);
  assert.equal(s.expected, 0);
  assert.equal(s.variance, 0);
});

test('pertStats: numeric strings are coerced', () => {
  const s = pertStats('3', '5', '9');
  assert.ok(Math.abs(s.expected - 16 / 3) < 1e-12);
});

test('pertStats: full precision — no per-activity rounding', () => {
  // o=1, m=2, p=4 -> expected = 13/6 = 2.1666..., variance = 0.25.
  // Under the old 2dp rounding this came back as 2.17, and summing many of
  // those drifted from the true sum.
  const s = pertStats(1, 2, 4);
  assert.ok(Math.abs(s.expected - 13 / 6) < 1e-12);
  assert.equal(s.variance, 0.25);
});

test('pertRollup: sums variances, sqrt of summed variance for stdDev', () => {
  const acts = [
    { id: 'a', ...pertStats(3, 5, 9) },
    { id: 'b', ...pertStats(1, 2, 3) } // expected 2, var ((3-1)/6)^2=0.111...
  ];
  const roll = pertRollup(acts);
  // Raw sum 16/3 + 2 = 7.333... -> rounds to 7.33 at the boundary; the
  // old rounded-sum path also gave 7.33 here, but from rounded inputs.
  assert.equal(roll.expected, 7.33);
  assert.equal(roll.variance, 1.11);
  assert.equal(roll.stdDev, Math.sqrt(1.11).toFixed(2) * 1);
});

test('pertRollup: precision — rounded sum of raw values, not sum of rounded values', () => {
  // 100 identical activities with repeating-decimal expected (13/6).
  // Old behavior: 100 * round(13/6, 2) = 100 * 2.17 = 217.
  // Correct: round(100 * 13/6, 2) = round(216.66..., 2) = 216.67.
  const acts = Array.from({ length: 100 }, () => pertStats(1, 2, 4));
  const roll = pertRollup(acts);
  assert.equal(roll.expected, 216.67);
});

test('pertRollup: empty list yields zeros', () => {
  const roll = pertRollup([]);
  assert.equal(roll.expected, 0);
  assert.equal(roll.variance, 0);  assert.equal(roll.stdDev, 0);
  assert.deepEqual(roll.skipped, []);
});

test('pertRollup: non-finite statistics are skipped and reported, not zero-coerced', () => {
  const good = pertStats(3, 5, 9);
  const acts = [
    { id: 'a', ...good },
    { id: 'bad-nan', expected: NaN, variance: NaN, stdDev: NaN },
    { id: 'bad-null', expected: null, variance: undefined },
    { id: 'bad-falsy', expected: '', variance: false }, // || 0 would swallow these silently
    { id: 'half-valid', expected: good.expected, variance: NaN }
  ];
  const roll = pertRollup(acts);
  assert.equal(roll.expected, round2(good.expected)); // only 'a' counted
  assert.equal(roll.variance, round2(good.variance));
  assert.deepEqual(roll.skipped.sort(), ['bad-falsy', 'bad-nan', 'bad-null', 'half-valid']);
});

test('pertCompletionProbability: z=0 gives 50%', () => {
  // target == expected -> 0.5
  const p = pertCompletionProbability(10, 2, 10);
  assert.equal(p, 0.5);
});

test('pertCompletionProbability: far-above target approaches 100%', () => {
  const p = pertCompletionProbability(10, 1, 13); // z = 3 (clamp)
  assert.ok(p >= 0.99, `expected >= 0.99, got ${p}`);
});

test('pertCompletionProbability: far-below target approaches 0%', () => {
  const p = pertCompletionProbability(10, 1, 7); // z = -3 (clamp)
  assert.ok(p <= 0.01, `expected <= 0.01, got ${p}`);
});

test('pertCompletionProbability: zero stdDev -> deterministic outcome', () => {
  // Zero variance: project finishes exactly at expected.
  assert.equal(pertCompletionProbability(10, 0, 10), 1);
  assert.equal(pertCompletionProbability(10, 0, 11), 1); // finishes day 10, before 11
  assert.equal(pertCompletionProbability(10, 0, 9), 0);  // cannot finish before 10
});

test('pertCompletionProbability: invalid stdDev returns 0.5', () => {
  assert.equal(pertCompletionProbability(10, Number.NaN, 10), 0.5);
});
