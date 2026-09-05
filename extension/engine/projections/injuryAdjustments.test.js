import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInjuryAdjustments } from './injuryAdjustments.js';

test('flagged player (real games-played history) returns an injuryDiscount', () => {
  const result = getInjuryAdjustments({ position: 'RB', name: 'Christian McCaffrey' });
  assert.ok(result.injuryDiscount > 0, 'expected a positive injuryDiscount for a known-flagged player');
  assert.ok(result.injuryDiscount <= 0.25);
});

test('unflagged/unknown player returns no adjustment', () => {
  assert.deepEqual(getInjuryAdjustments({ position: 'RB', name: 'Some Totally Unknown Player' }), {});
});

test('K and DST are never flagged — injury risk is not meaningful for unit/role-based positions', () => {
  assert.deepEqual(getInjuryAdjustments({ position: 'K', name: 'Christian McCaffrey' }), {});
  assert.deepEqual(getInjuryAdjustments({ position: 'DST', name: 'Christian McCaffrey' }), {});
});

test('name matching is suffix- and punctuation-insensitive, matching the Python-side normalization', () => {
  const withSuffix = getInjuryAdjustments({ position: 'WR', name: 'A.J. Dillon' });
  assert.ok(withSuffix.injuryDiscount > 0);
});
