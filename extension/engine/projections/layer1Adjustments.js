// Layer 1's error-correction step from SPEC.md:
//   adjustedPoints = basePoints × (1 + errorAdjustment(pos))
//                              × (1 - injuryDiscount(p))
//                              × (1 + matchupAdjustment(p))
//
// This file is the real, tested formula — not a placeholder. What it is NOT
// is calibrated: `errorAdjustment` needs 2 seasons of actual-vs-projected
// analysis per position, and `injuryDiscount` needs real multi-season injury
// history per player (SPEC.md's "hurt in 2 of last 3 seasons" test). Neither
// dataset has been pulled — that's a genuinely separate, large data-pull
// task, comparable in scope to the FantasyPros projections work itself, not
// something to fake with guessed numbers. Every adjustment defaults to
// neutral (0) until real calibration data exists; build-projections.js calls
// this with those defaults today, so `adjustedPoints` currently equals
// `basePoints` — but the pipeline's *shape* is complete and ready to receive
// real per-position/per-player adjustments without changing anything
// downstream (the scoring engine already only ever consumes
// `adjustedPoints`, never `basePoints` directly).
export function applyLayer1Adjustments(basePoints, { errorAdjustment = 0, injuryDiscount = 0, matchupAdjustment = 0 } = {}) {
  return basePoints * (1 + errorAdjustment) * (1 - injuryDiscount) * (1 + matchupAdjustment);
}
