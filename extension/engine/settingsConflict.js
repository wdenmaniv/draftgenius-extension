// Detects when a matched DraftGenius team's SAVED roster/scoring settings
// have drifted from what a live Sleeper draft actually reports — per
// direct request: the extension should notice (a commissioner changed
// roster spots, league scoring changed since the team was last synced to
// the website, etc.) and offer to update the saved team, rather than
// silently drafting off stale numbers with no record anything changed.
// Deliberately Sleeper-only for now — ESPN/Yahoo have no live
// settings-detection to compare a saved team against yet (see README).
import { DEFAULT_ROSTER_SLOTS } from './liveDraftState.js';
import { DEFAULT_SCORING_RULES } from './projections/leagueScoring.js';

// pointsAllowedTiers/gamesPerSeason aren't user-editable scalars (see the
// website's own SCORING_FIELDS and the extension's own
// SCORING_RULE_FIELDS, both of which already exclude them) — comparing
// them would either always match (never edited) or never usefully
// mismatch, so they're left out of this too.
const SCORING_RULE_KEYS = Object.keys(DEFAULT_SCORING_RULES).filter(
  (key) => key !== 'pointsAllowedTiers' && key !== 'gamesPerSeason',
);
const ROSTER_SLOT_KEYS = Object.keys(DEFAULT_ROSTER_SLOTS);

export function rosterSlotsEqual(a, b) {
  if (!a || !b) return true; // nothing to compare — not a conflict, just missing data
  return ROSTER_SLOT_KEYS.every((key) => (a[key] ?? 0) === (b[key] ?? 0));
}

// Both sides merged against DEFAULT_SCORING_RULES first — a partially-
// populated saved `mapped_scoring_rules` (e.g. only receptionPoints ever
// got set) must not false-positive against a fully-populated live object;
// this compares what's ACTUALLY driving pricing on each side (the exact
// same merge computeEffectiveScoringRules/ensurePricing already do), not
// the raw stored rows.
export function scoringRulesEqual(a, b) {
  if (!a || !b) return true;
  const mergedA = { ...DEFAULT_SCORING_RULES, ...a };
  const mergedB = { ...DEFAULT_SCORING_RULES, ...b };
  return SCORING_RULE_KEYS.every((key) => mergedA[key] === mergedB[key]);
}

// Returns {rosterDiffers, scoringDiffers} — both false when either side of
// a comparison is missing (nothing to conflict about yet, e.g. no matched
// team, or Sleeper's own settings haven't loaded).
export function detectSettingsConflict({ savedRosterSlots, liveRosterSlots, savedScoringRules, liveScoringRules }) {
  return {
    rosterDiffers: Boolean(savedRosterSlots && liveRosterSlots) && !rosterSlotsEqual(savedRosterSlots, liveRosterSlots),
    scoringDiffers:
      Boolean(savedScoringRules && liveScoringRules) && !scoringRulesEqual(savedScoringRules, liveScoringRules),
  };
}
