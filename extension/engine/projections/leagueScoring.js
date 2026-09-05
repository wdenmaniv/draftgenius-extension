// Converts raw per-category stat projections into league-specific fantasy
// points — this is the actual "apply to specific league settings" step from
// SPEC.md's Layer 1. FantasyPros' own FPTS column reflects THEIR scoring
// assumptions (their default is half-PPR for RB/WR/TE), not necessarily the
// real league's — so this recomputes from raw stats rather than trusting
// that column, which is the whole point of pulling raw stats instead of
// just the final number.
//
// Defaults below now come from the user's own real league's actual
// settings — its LeagueInfo tab (see data/league-config.json, which
// build-projections.js reads instead of importing DEFAULT_SCORING_RULES
// directly, matching the roster-settings side panel's "user's real values,
// not a guess" philosophy). Confirmed by extracting elboberto's LeagueInfo
// tab from three years of his own draft-prep spreadsheets: passYardsPerPoint
// (25 = 0.04 pts/yd), interception (-2), receptionPoints (0.5, half-PPR),
// and fumbleLost (-2) all already matched what was here; rushYardsPerPoint
// and recYardsPerPoint did NOT — this file previously had both at 10 (0.1
// pts/yd), but the real league scores yardage at 20 (0.05 pts/yd), stable
// and identical across 2024 and 2025 (his two most recent seasons — 2022 was
// close but not identical, e.g. interception was -1 that year, so the more
// recent two years were treated as the current, stable convention). Fixed
// here 2026-08-17; ESPN/DST/K rules had no corresponding real-settings data
// in LeagueInfo to check against, so those remain the original baseline
// assumptions, not yet confirmed against a real source.
export const DEFAULT_SCORING_RULES = {
  passYardsPerPoint: 25,
  passTd: 4,
  interception: -2,
  rushYardsPerPoint: 20,
  rushTd: 6,
  receptionPoints: 0.5, // half-PPR; set to 0 for standard, 1 for full PPR
  recYardsPerPoint: 20,
  recTd: 6,
  fumbleLost: -2,
  fieldGoal: 3, // flat per make — FantasyPros doesn't break FG out by distance
  extraPoint: 1,
  defSack: 1,
  defInt: 2,
  defFumbleRecovery: 2,
  defForcedFumble: 0, // many formats don't score this separately from the recovery itself; set >0 if yours does
  defTd: 6,
  defSafety: 2,
  // Standard ESPN-style tiers: first one whose `max` the points-allowed
  // value is <= wins. These are PER-GAME tiers — FantasyPros' PA column is a
  // SEASON total, so computeLeaguePoints averages it per game before this
  // lookup, then scales back up by games played. Caught by hand-checking a
  // real row (Texans, 322.0 season PA) against this before writing tests:
  // comparing the season total directly against these tiers would have
  // landed in the `Infinity` bucket every time, flattening every DST
  // projection to the same -4×17 regardless of actual defense quality.
  pointsAllowedTiers: [
    { max: 0, points: 10 },
    { max: 6, points: 7 },
    { max: 13, points: 4 },
    { max: 20, points: 1 },
    { max: 27, points: 0 },
    { max: 34, points: -1 },
    { max: Infinity, points: -4 },
  ],
  gamesPerSeason: 17,
};

function pointsAllowedScore(pointsAllowed, tiers) {
  for (const tier of tiers) {
    if (pointsAllowed <= tier.max) return tier.points;
  }
  return 0;
}

export function computeLeaguePoints(stat, rules = DEFAULT_SCORING_RULES) {
  switch (stat.position) {
    case 'QB':
      return (
        stat.passYds / rules.passYardsPerPoint +
        stat.passTds * rules.passTd +
        stat.passInts * rules.interception +
        stat.rushYds / rules.rushYardsPerPoint +
        stat.rushTds * rules.rushTd +
        stat.fumblesLost * rules.fumbleLost
      );
    case 'RB':
      return (
        stat.rushYds / rules.rushYardsPerPoint +
        stat.rushTds * rules.rushTd +
        stat.rec * rules.receptionPoints +
        stat.recYds / rules.recYardsPerPoint +
        stat.recTds * rules.recTd +
        stat.fumblesLost * rules.fumbleLost
      );
    case 'WR':
      return (
        stat.rec * rules.receptionPoints +
        stat.recYds / rules.recYardsPerPoint +
        stat.recTds * rules.recTd +
        stat.rushYds / rules.rushYardsPerPoint +
        stat.rushTds * rules.rushTd +
        stat.fumblesLost * rules.fumbleLost
      );
    case 'TE':
      return stat.rec * rules.receptionPoints + stat.recYds / rules.recYardsPerPoint + stat.recTds * rules.recTd + stat.fumblesLost * rules.fumbleLost;
    case 'K':
      return stat.fg * rules.fieldGoal + stat.xpt * rules.extraPoint;
    case 'DST': {
      const avgPointsAllowedPerGame = stat.pointsAllowed / rules.gamesPerSeason;
      const paPointsPerGame = pointsAllowedScore(avgPointsAllowedPerGame, rules.pointsAllowedTiers);
      return (
        stat.sacks * rules.defSack +
        stat.ints * rules.defInt +
        stat.fumRec * rules.defFumbleRecovery +
        stat.fumForced * rules.defForcedFumble +
        stat.defTds * rules.defTd +
        stat.safeties * rules.defSafety +
        paPointsPerGame * rules.gamesPerSeason
      );
    }
    default:
      throw new Error(`Unknown position: ${stat.position}`);
  }
}
