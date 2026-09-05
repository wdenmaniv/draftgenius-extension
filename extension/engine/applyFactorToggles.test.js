import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFactorToggles } from './applyFactorToggles.js';

const players = [
  { id: 'RB1', errorAdjustment: 0.042, injuryDiscount: 0.25 },
  { id: 'WR1', errorAdjustment: -0.034, injuryDiscount: 0 },
];

describe('applyFactorToggles', () => {
  test('passes both factors through unchanged when both toggles are on', () => {
    const result = applyFactorToggles(players, { historicalBiasEnabled: true, injuryDiscountEnabled: true });
    assert.deepEqual(result, players);
  });

  test('zeroes errorAdjustment only, leaving injuryDiscount untouched, when historical bias is off', () => {
    const result = applyFactorToggles(players, { historicalBiasEnabled: false, injuryDiscountEnabled: true });
    assert.deepEqual(result[0], { id: 'RB1', errorAdjustment: 0, injuryDiscount: 0.25 });
    assert.deepEqual(result[1], { id: 'WR1', errorAdjustment: 0, injuryDiscount: 0 });
  });

  test('zeroes injuryDiscount only, leaving errorAdjustment untouched, when injury discount is off', () => {
    const result = applyFactorToggles(players, { historicalBiasEnabled: true, injuryDiscountEnabled: false });
    assert.deepEqual(result[0], { id: 'RB1', errorAdjustment: 0.042, injuryDiscount: 0 });
  });

  test('zeroes both when both toggles are off', () => {
    const result = applyFactorToggles(players, { historicalBiasEnabled: false, injuryDiscountEnabled: false });
    assert.deepEqual(result[0], { id: 'RB1', errorAdjustment: 0, injuryDiscount: 0 });
  });

  test('does not mutate the original input array', () => {
    const original = [{ id: 'RB1', errorAdjustment: 0.05, injuryDiscount: 0.1 }];
    applyFactorToggles(original, { historicalBiasEnabled: false, injuryDiscountEnabled: false });
    assert.equal(original[0].errorAdjustment, 0.05);
  });
});
