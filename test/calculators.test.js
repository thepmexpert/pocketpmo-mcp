import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pertStats,
  pertRollup,
  pertCompletionProbability
} from '../lib/calculators.js';

test('pertStats: golden case o=3 m=5 p=9', () => {
  const s = pertStats(3, 5, 9);
  assert.equal(s.expected, 5.33); // (3 + 20 + 9) / 6 = 5.333... -> 5.33
  assert.equal(s.variance, 1);    // ((9-3)/6)^2 = 1
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
  assert.equal(s.expected, 5.33);
});

test('pertRollup: sums variances, sqrt of summed variance for stdDev', () => {
  const acts = [
    { id: 'a', ...pertStats(3, 5, 9) },
    { id: 'b', ...pertStats(1, 2, 3) } // expected 2, var ((3-1)/6)^2=0.11
  ];
  const roll = pertRollup(acts);
  assert.equal(roll.expected, 7.33);
  assert.equal(roll.variance, 1.11);
  assert.equal(roll.stdDev, Math.sqrt(1.11).toFixed(2) * 1);
});

test('pertRollup: empty list yields zeros', () => {
  const roll = pertRollup([]);
  assert.equal(roll.expected, 0);
  assert.equal(roll.variance, 0);
  assert.equal(roll.stdDev, 0);
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
