import test from 'node:test';
import assert from 'node:assert/strict';
import { centerBiasSummary } from './historicalErrorAdjustments.js';

// centerBiasSummary is the actual policy decision behind this file (see its
// module comment): raw per-position bias is all-negative (preseason
// optimism at every position), which would make every player's
// adjustedPoints look uniformly lower than any other source. Centering
// removes that common component — the engine's dollarPerPAR self-normalizes
// against it anyway (see scoring.test.js) — while preserving the relative
// story between positions exactly.
test('centerBiasSummary subtracts the mean of position means, preserving relative spread', () => {
  const summary = {
    QB: { n: 100, meanErrorRatio: -0.088 },
    RB: { n: 200, meanErrorRatio: -0.06 },
    WR: { n: 300, meanErrorRatio: -0.141 },
  };
  const centered = centerBiasSummary(summary);
  const meanOfMeans = (-0.088 + -0.06 + -0.141) / 3;
  assert.ok(Math.abs(centered.QB - (-0.088 - meanOfMeans)) < 1e-9);
  assert.ok(Math.abs(centered.RB - (-0.06 - meanOfMeans)) < 1e-9);
  assert.ok(Math.abs(centered.WR - (-0.141 - meanOfMeans)) < 1e-9);
  // The spread between any two positions is unchanged by centering.
  assert.ok(Math.abs((centered.WR - centered.RB) - (-0.141 - -0.06)) < 1e-9);
});

test('centerBiasSummary on a uniform bias (all positions equally over/under) yields exactly zero for every position', () => {
  const summary = {
    QB: { n: 10, meanErrorRatio: -0.1 },
    RB: { n: 10, meanErrorRatio: -0.1 },
  };
  const centered = centerBiasSummary(summary);
  assert.equal(centered.QB, 0);
  assert.equal(centered.RB, 0);
});

test('centerBiasSummary returns {} for an empty summary rather than dividing by zero', () => {
  assert.deepEqual(centerBiasSummary({}), {});
});
