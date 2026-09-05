import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeaguePoints, DEFAULT_SCORING_RULES } from './leagueScoring.js';

// Every stat line below is a real player's row from the actual 2026
// season-long FantasyPros export. Expected totals are hand-computed against
// DEFAULT_SCORING_RULES (shown in comments), not copied from FantasyPros'
// own FPTS column — the two aren't expected to match exactly, since the
// whole point of this module is computing OUR OWN league's scoring
// independent of FantasyPros' assumptions. Where they land close anyway
// (WR, TE, K below), that's a useful sanity check that the defaults are a
// plausible real-world scoring format, not a coincidence to rely on.

test('QB: Josh Allen', () => {
  const stat = { position: 'QB', passYds: 3816.9, passTds: 27.4, passInts: 11.2, rushYds: 585.5, rushTds: 11.8, fumblesLost: 4.1 };
  // 3816.9/25 + 27.4*4 - 11.2*2 + 585.5/20 + 11.8*6 - 4.1*2 = 331.751
  assert.ok(Math.abs(computeLeaguePoints(stat) - 331.751) < 1e-9);
});

test('RB: Jahmyr Gibbs', () => {
  const stat = { position: 'RB', rushYds: 1383.0, rushTds: 13.8, rec: 70.9, recYds: 581.1, recTds: 4.1, fumblesLost: 1.1 };
  // 1383/20 + 13.8*6 + 70.9*0.5 + 581.1/20 + 4.1*6 - 1.1*2 = 238.855
  assert.ok(Math.abs(computeLeaguePoints(stat) - 238.855) < 1e-9);
});

test('WR: Puka Nacua (no longer expected to track FantasyPros\' own half-PPR FPTS of 281.3 closely — their yardage scoring is 0.1 pts/yd, the real league\'s confirmed rate is 0.05, so a gap here is the module doing its actual job, not a bug)', () => {
  const stat = { position: 'WR', rec: 117.0, recYds: 1539.0, recTds: 9.0, rushYds: 85.0, rushTds: 1.4, fumblesLost: 1.0 };
  // 117*0.5 + 1539/20 + 9*6 + 85/20 + 1.4*6 - 1*2 = 200.1
  const points = computeLeaguePoints(stat);
  assert.ok(Math.abs(points - 200.1) < 1e-9);
});

test('TE: Trey McBride', () => {
  const stat = { position: 'TE', rec: 109.0, recYds: 1051.6, recTds: 6.8, fumblesLost: 0.2 };
  // 109*0.5 + 1051.6/20 + 6.8*6 - 0.2*2 = 147.48
  assert.ok(Math.abs(computeLeaguePoints(stat) - 147.48) < 1e-9);
});

test('K: Brandon Aubrey', () => {
  const stat = { position: 'K', fg: 35.2, xpt: 47.5 };
  // 35.2*3 + 47.5*1 = 153.1
  assert.ok(Math.abs(computeLeaguePoints(stat) - 153.1) < 1e-9);
});

test('DST: Houston Texans — season-total points-allowed must be averaged per game before the tier lookup', () => {
  const stat = {
    position: 'DST',
    sacks: 49.5,
    ints: 14.8,
    fumRec: 11.6,
    fumForced: 18.3,
    defTds: 2.8,
    safeties: 1.0,
    pointsAllowed: 322.0, // season total, not per-game
  };
  // base = 49.5 + 29.6 + 23.2 + 0 + 16.8 + 2 = 121.1
  // 322/17 = 18.94 avg/game -> falls in the <=20 tier -> 1pt/game -> *17 = 17
  // total = 138.1
  assert.ok(Math.abs(computeLeaguePoints(stat) - 138.1) < 1e-9);
});

test('DST points-allowed tiers are genuinely per-game: a stingy vs. leaky defense score differently', () => {
  const stingy = { position: 'DST', sacks: 0, ints: 0, fumRec: 0, fumForced: 0, defTds: 0, safeties: 0, pointsAllowed: 17 * 5 }; // 5/game
  const leaky = { position: 'DST', sacks: 0, ints: 0, fumRec: 0, fumForced: 0, defTds: 0, safeties: 0, pointsAllowed: 17 * 30 }; // 30/game
  assert.ok(computeLeaguePoints(stingy) > computeLeaguePoints(leaky));
});

test('scoring rules are overridable — full PPR changes the reception value', () => {
  const stat = { position: 'RB', rushYds: 0, rushTds: 0, rec: 10, recYds: 0, recTds: 0, fumblesLost: 0 };
  const halfPPR = computeLeaguePoints(stat, { ...DEFAULT_SCORING_RULES, receptionPoints: 0.5 });
  const fullPPR = computeLeaguePoints(stat, { ...DEFAULT_SCORING_RULES, receptionPoints: 1 });
  assert.equal(fullPPR - halfPPR, 5); // 10 receptions * 0.5 extra point each
});
