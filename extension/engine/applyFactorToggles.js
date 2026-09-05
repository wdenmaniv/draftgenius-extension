// Ported from draftgenius/src/lib/rankings/applyFactorToggles.ts (the
// website's own factor-toggle logic — ported here rather than the other
// direction because it was built there first, for the rankings page). Zero
// out either factor on a COPY of the player pool before handing off to
// recomputeWithScoringRules, so a matched team's factor-toggle preference
// actually changes the extension's live numbers instead of being fetched
// and stored but never applied.
//
// Deliberately a pre-processing step rather than a change to
// recomputeWithScoringRules itself — keeps that function's contract
// untouched, same reasoning as the website's own version.
export function applyFactorToggles(players, { historicalBiasEnabled, injuryDiscountEnabled }) {
  return players.map((p) => ({
    ...p,
    errorAdjustment: historicalBiasEnabled ? p.errorAdjustment : 0,
    injuryDiscount: injuryDiscountEnabled ? p.injuryDiscount : 0,
  }));
}
