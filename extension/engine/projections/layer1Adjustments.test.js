import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayer1Adjustments } from './layer1Adjustments.js';

test('with no adjustments supplied, adjustedPoints equals basePoints exactly', () => {
  assert.equal(applyLayer1Adjustments(300), 300);
});

test('errorAdjustment scales basePoints up or down by a percentage', () => {
  assert.equal(applyLayer1Adjustments(300, { errorAdjustment: 0.1 }), 330);
  assert.equal(applyLayer1Adjustments(300, { errorAdjustment: -0.1 }), 270);
});

test('injuryDiscount reduces basePoints by a percentage', () => {
  assert.equal(applyLayer1Adjustments(300, { injuryDiscount: 0.2 }), 240);
});

test('matchupAdjustment scales basePoints up or down by a percentage', () => {
  assert.equal(applyLayer1Adjustments(300, { matchupAdjustment: 0.05 }), 315);
});

test('all three adjustments compose multiplicatively, in the order SPEC.md defines', () => {
  // 300 * 1.1 * 0.8 * 1.05 = 277.2
  const result = applyLayer1Adjustments(300, { errorAdjustment: 0.1, injuryDiscount: 0.2, matchupAdjustment: 0.05 });
  assert.ok(Math.abs(result - 277.2) < 1e-9);
});
