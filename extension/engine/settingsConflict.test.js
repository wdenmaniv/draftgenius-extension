import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosterSlotsEqual, scoringRulesEqual, detectSettingsConflict } from './settingsConflict.js';
import { DEFAULT_ROSTER_SLOTS } from './liveDraftState.js';
import { DEFAULT_SCORING_RULES } from './projections/leagueScoring.js';

test('detectSettingsConflict: identical saved and live settings report no conflict', () => {
  const result = detectSettingsConflict({
    savedRosterSlots: { ...DEFAULT_ROSTER_SLOTS },
    liveRosterSlots: { ...DEFAULT_ROSTER_SLOTS },
    savedScoringRules: { ...DEFAULT_SCORING_RULES },
    liveScoringRules: { ...DEFAULT_SCORING_RULES },
  });
  assert.deepEqual(result, { rosterDiffers: false, scoringDiffers: false });
});

test('detectSettingsConflict: a roster-slot difference is reported, scoring stays clean', () => {
  const result = detectSettingsConflict({
    savedRosterSlots: { ...DEFAULT_ROSTER_SLOTS, WR: 2 },
    liveRosterSlots: { ...DEFAULT_ROSTER_SLOTS, WR: 3 }, // commissioner added a WR slot
    savedScoringRules: { ...DEFAULT_SCORING_RULES },
    liveScoringRules: { ...DEFAULT_SCORING_RULES },
  });
  assert.deepEqual(result, { rosterDiffers: true, scoringDiffers: false });
});

test('detectSettingsConflict: a scoring difference is reported, roster stays clean', () => {
  const result = detectSettingsConflict({
    savedRosterSlots: { ...DEFAULT_ROSTER_SLOTS },
    liveRosterSlots: { ...DEFAULT_ROSTER_SLOTS },
    savedScoringRules: { ...DEFAULT_SCORING_RULES, receptionPoints: 0.5 },
    liveScoringRules: { ...DEFAULT_SCORING_RULES, receptionPoints: 1 }, // league switched to full PPR
  });
  assert.deepEqual(result, { rosterDiffers: false, scoringDiffers: true });
});

test('detectSettingsConflict: both roster and scoring can differ at once', () => {
  const result = detectSettingsConflict({
    savedRosterSlots: { ...DEFAULT_ROSTER_SLOTS, BENCH: 6 },
    liveRosterSlots: { ...DEFAULT_ROSTER_SLOTS, BENCH: 10 },
    savedScoringRules: { ...DEFAULT_SCORING_RULES, passTd: 4 },
    liveScoringRules: { ...DEFAULT_SCORING_RULES, passTd: 6 },
  });
  assert.deepEqual(result, { rosterDiffers: true, scoringDiffers: true });
});

test('detectSettingsConflict: a partially-populated saved mapped_scoring_rules is merged against defaults before comparing — no false positive', () => {
  // Saved row only ever had receptionPoints set (e.g. an old preset-only
  // save, before this session's "always show the full grid" change) —
  // every other field is implicitly DEFAULT_SCORING_RULES, same as the
  // live side, so this must NOT report a conflict.
  const result = detectSettingsConflict({
    savedRosterSlots: null,
    liveRosterSlots: null,
    savedScoringRules: { receptionPoints: 1 },
    liveScoringRules: { ...DEFAULT_SCORING_RULES, receptionPoints: 1 },
  });
  assert.equal(result.scoringDiffers, false);
});

test('detectSettingsConflict: missing data on either side is not a conflict, just nothing to compare', () => {
  assert.deepEqual(
    detectSettingsConflict({ savedRosterSlots: null, liveRosterSlots: DEFAULT_ROSTER_SLOTS, savedScoringRules: null, liveScoringRules: null }),
    { rosterDiffers: false, scoringDiffers: false },
  );
});

test('rosterSlotsEqual / scoringRulesEqual: null/undefined on either side is treated as equal (nothing to compare)', () => {
  assert.equal(rosterSlotsEqual(null, DEFAULT_ROSTER_SLOTS), true);
  assert.equal(rosterSlotsEqual(DEFAULT_ROSTER_SLOTS, undefined), true);
  assert.equal(scoringRulesEqual(null, DEFAULT_SCORING_RULES), true);
});

test('scoringRulesEqual ignores pointsAllowedTiers/gamesPerSeason — not user-editable scalars', () => {
  const a = { ...DEFAULT_SCORING_RULES, pointsAllowedTiers: [{ max: 0, points: 99 }] };
  const b = { ...DEFAULT_SCORING_RULES, gamesPerSeason: 18 };
  assert.equal(scoringRulesEqual(a, b), true);
});
