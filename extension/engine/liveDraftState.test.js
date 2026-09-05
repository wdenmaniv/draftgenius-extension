import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLeagueConfig,
  initDraftPricing,
  computeUndraftedPool,
  computeMyRosterState,
  computeLiveRatesByPosition,
  computeRecommendation,
  recommendBestAvailable,
  recommendTopAvailable,
  recomputeWithScoringRules,
  computeTierInfo,
  computeActiveRunPosition,
  computeTierRemainingCounts,
  computeTeamRanking,
  computeStarterOnlyRanking,
  pickHeadlineRecommendation,
  DEFAULT_ROSTER_SLOTS,
} from './liveDraftState.js';
import { DEFAULT_SCORING_RULES } from './projections/leagueScoring.js';

function player(id, position, adjustedPoints) {
  return { id, position, adjustedPoints, name: id };
}

// Small 4-team league, same shape as scoring.test.js's fixture, reused here
// so this file's expectations can be sanity-checked against known-good math.
const rbs = [player('RB1', 'RB', 300), player('RB2', 'RB', 250), player('RB3', 'RB', 200), player('RB4', 'RB', 150), player('RB5', 'RB', 100)];
const wrs = [player('WR1', 'WR', 280), player('WR2', 'WR', 240), player('WR3', 'WR', 200), player('WR4', 'WR', 160)];
const qbs = [player('QB1', 'QB', 350), player('QB2', 'QB', 300)];
const tes = [player('TE1', 'TE', 200), player('TE2', 'TE', 120)];
const allPlayers = [...qbs, ...rbs, ...wrs, ...tes];

const leagueConfig = buildLeagueConfig({ numTeams: 4, budgetPerTeam: 100 });

test('buildLeagueConfig uses the documented v1 defaults for roster shape', () => {
  assert.deepEqual(leagueConfig.rosterSlots, DEFAULT_ROSTER_SLOTS);
  assert.equal(leagueConfig.numTeams, 4);
  assert.equal(leagueConfig.budgetPerTeam, 100);
});

test('buildLeagueConfig defaults benchBudgetShare to 0 (spend everything on the starting lineup) and passes through a real value', () => {
  assert.equal(leagueConfig.benchBudgetShare, 0);
  const withShare = buildLeagueConfig({ numTeams: 4, budgetPerTeam: 100, benchBudgetShare: 0.1 });
  assert.equal(withShare.benchBudgetShare, 0.1);
});

test('initDraftPricing produces PAR and a positive auction baseline from real engine functions', () => {
  const { playersWithPAR, auctionBaseline } = initDraftPricing(allPlayers, leagueConfig);
  assert.equal(playersWithPAR.length, allPlayers.length);
  assert.ok(playersWithPAR.every((p) => typeof p.par === 'number'));
  assert.ok(auctionBaseline.dollarPerPAR > 0);
});

test('computeUndraftedPool removes sold players by id', () => {
  const { playersWithPAR } = initDraftPricing(allPlayers, leagueConfig);
  const undrafted = computeUndraftedPool(playersWithPAR, new Set(['RB1', 'WR1']));
  assert.equal(undrafted.length, allPlayers.length - 2);
  assert.ok(!undrafted.some((p) => p.id === 'RB1' || p.id === 'WR1'));
});

test('computeMyRosterState: base slots fill before flex is touched', () => {
  // RB needs 2, WR needs 2, drafted exactly 2 RB + 2 WR — no flex used yet.
  const myPicks = [
    { position: 'RB', price: 30 },
    { position: 'RB', price: 20 },
    { position: 'WR', price: 25 },
    { position: 'WR', price: 15 },
  ];
  const state = computeMyRosterState({ myPicks, leagueConfig });
  assert.equal(state.openStarterSlots.RB, 1); // base full (0 open) + 1 flex still available
  assert.equal(state.openStarterSlots.WR, 1);
  assert.equal(state.openStarterSlots.TE, 1 + 1); // base TE open (1) + flex still available (1) = 2
  assert.equal(state.remainingBudget, 100 - 90);
});

test('computeMyRosterState: flex-eligible overflow consumes the shared flex slot', () => {
  // 3 RBs drafted against a base of 2 -> 1 overflow consumes the single FLEX slot.
  const myPicks = [
    { position: 'RB', price: 10 },
    { position: 'RB', price: 10 },
    { position: 'RB', price: 10 },
  ];
  const state = computeMyRosterState({ myPicks, leagueConfig });
  assert.equal(state.openStarterSlots.RB, 0); // base full, no flex credit left after RB itself used it
  assert.equal(state.openStarterSlots.WR, 2); // base 2 open, but flex is exhausted -> no +1
  assert.equal(state.openStarterSlots.TE, 1); // base 1 open, flex exhausted -> no +1
});

test('computeMyRosterState: otherOpenSlotCount excludes the slot currently under consideration', () => {
  const state = computeMyRosterState({ myPicks: [], leagueConfig });
  const totalSlots = Object.values(DEFAULT_ROSTER_SLOTS).reduce((a, b) => a + b, 0);
  assert.equal(state.otherOpenSlotCount, totalSlots - 1);
});

test('computeMyRosterState: tolerates picks with no price at all (snake draft — no dollar dimension)', () => {
  const state = computeMyRosterState({ myPicks: [{ position: 'RB' }, { position: 'WR' }], leagueConfig });
  assert.equal(state.openStarterSlots.RB, 2); // 1 base slot open + flex still available (1 RB drafted against a base of 2)
  assert.equal(state.remainingBudget, 100); // unused/meaningless for snake, but must not be NaN
});

test('computeLiveRatesByPosition delegates per position independently', () => {
  const { playersWithPAR, auctionBaseline } = initDraftPricing(allPlayers, leagueConfig);
  const rb1 = playersWithPAR.find((p) => p.id === 'RB1');
  const overpaidPrice = Math.round(rb1.par * auctionBaseline.dollarPerPAR) * 3;
  const soldWithPAR = [{ position: 'RB', price: overpaidPrice, par: rb1.par }];
  const rates = computeLiveRatesByPosition({ soldWithPAR, auctionBaseline, positions: ['RB', 'WR'] });
  assert.ok(rates.RB > auctionBaseline.dollarPerPAR); // RB market is running hot
  assert.equal(rates.WR, auctionBaseline.dollarPerPAR); // untouched position stays at baseline
});

test('computeRecommendation returns null when there is no active player yet', () => {
  assert.equal(computeRecommendation({ activePlayerWithPAR: null, myRosterState: {}, auctionBaseline: {} }), null);
});

test('computeRecommendation wires straight through to the real recommendMaxBid engine function, priced off the static baseline rate', () => {
  const activePlayerWithPAR = { id: 'RB2', position: 'RB', par: 50 };
  const myRosterState = { openStarterSlots: { RB: 1 }, remainingBudget: 60, otherOpenSlotCount: 3 };
  const auctionBaseline = { dollarPerPAR: 1.0 };
  const result = computeRecommendation({ activePlayerWithPAR, myRosterState, auctionBaseline });
  assert.equal(result.maxBid, 50); // 50 par * 1.0 baseline rate, well under the budget cap of 57
});

test('computeRecommendation ignores live per-position rates entirely — market heat never changes the priced number', () => {
  const activePlayerWithPAR = { id: 'RB2', position: 'RB', par: 50 };
  const myRosterState = { openStarterSlots: { RB: 1 }, remainingBudget: 200, otherOpenSlotCount: 0 };
  const auctionBaseline = { dollarPerPAR: 1.0 };
  // Even if the room were running RB at 3x the baseline rate, computeRecommendation
  // has no way to receive that here — it only ever reads auctionBaseline.dollarPerPAR.
  const result = computeRecommendation({ activePlayerWithPAR, myRosterState, auctionBaseline });
  assert.equal(result.maxBid, 50); // still 50 par * 1.0 baseline, not 150
});

// recommendBestAvailable is snake draft's analog to computeRecommendation —
// no dollar dimension exists in snake, so it ranks by PAR among open-slot
// positions instead of sizing a bid. Groundwork built ahead of having real
// snake wire-protocol data (unlike auction's espn.js/yahoo.js parsers, which
// were built from real captured messages) — this part is pure engine logic
// with no wire-format dependency at all, so it doesn't need to wait on that.
test('recommendBestAvailable ranks by PAR among positions with an open startable slot only', () => {
  const { playersWithPAR } = initDraftPricing(allPlayers, leagueConfig);
  // My team already has both starting QB slots filled — QB should never appear, even though QB1 has the highest raw PAR overall.
  const myRosterState = computeMyRosterState({ myPicks: [{ position: 'QB' }, { position: 'QB' }], leagueConfig });
  const undrafted = computeUndraftedPool(
    playersWithPAR,
    new Set(playersWithPAR.filter((p) => p.position === 'QB').map((p) => p.id)),
  );
  const best = recommendBestAvailable({ undraftedPlayers: undrafted, myRosterState, count: 3 });
  assert.ok(best.every((p) => p.position !== 'QB'));
  for (let i = 1; i < best.length; i++) assert.ok(best[i - 1].par >= best[i].par); // descending by PAR
});

test('recommendBestAvailable respects the count limit and returns nothing when no open slots remain anywhere', () => {
  const { playersWithPAR } = initDraftPricing(allPlayers, leagueConfig);
  const fullRosterPicks = [
    ...Object.entries(DEFAULT_ROSTER_SLOTS)
      .filter(([pos]) => pos !== 'FLEX' && pos !== 'BENCH')
      .flatMap(([pos, count]) => Array(count).fill({ position: pos })),
    { position: 'RB' }, // one extra flex-eligible pick to consume the shared FLEX slot too
  ];
  const myRosterState = computeMyRosterState({ myPicks: fullRosterPicks, leagueConfig });
  assert.deepEqual(recommendBestAvailable({ undraftedPlayers: playersWithPAR, myRosterState, count: 5 }), []);

  const openState = computeMyRosterState({ myPicks: [], leagueConfig });
  const top2 = recommendBestAvailable({ undraftedPlayers: playersWithPAR, myRosterState: openState, count: 2 });
  assert.equal(top2.length, 2);
});

// recommendTopAvailable is the "Best Available" side of the side panel's
// two-tab view — pure value, no roster-need filter at all (unlike
// recommendBestAvailable's "Best Fit" side, tested above).
test('recommendTopAvailable ranks purely by PAR, ignoring roster need entirely', () => {
  const { playersWithPAR } = initDraftPricing(allPlayers, leagueConfig);
  // Same setup as the QB-slots-filled test above, but recommendTopAvailable
  // takes no myRosterState at all — QB1 (highest raw PAR) should still be
  // allowed to appear here, unlike in the "Best Fit" ranking.
  const top = recommendTopAvailable({ undraftedPlayers: playersWithPAR, count: 3 });
  assert.equal(top.length, 3);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].par >= top[i].par); // descending by PAR
  assert.deepEqual(
    top.map((p) => p.id),
    playersWithPAR
      .slice()
      .sort((a, b) => b.par - a.par)
      .slice(0, 3)
      .map((p) => p.id),
  );
});

test('recommendTopAvailable respects the count limit', () => {
  const { playersWithPAR } = initDraftPricing(allPlayers, leagueConfig);
  const top2 = recommendTopAvailable({ undraftedPlayers: playersWithPAR, count: 2 });
  assert.equal(top2.length, 2);
});

// pickHeadlineRecommendation — the side panel's "who do I pick" headline,
// per direct request. Reads straight out of a Best Fit-shaped list
// (recommendBestAvailable's own output), so these tests build that list
// shape directly rather than re-deriving it from initDraftPricing each
// time — the function itself doesn't care where the list came from.
function rankedPlayer(id, position, par) {
  return { id, name: id, position, par };
}

test('pickHeadlineRecommendation: top is rank #1, alternates are the next-best at the same position and the best at a different one', () => {
  const list = [
    rankedPlayer('rb1', 'RB', 20),
    rankedPlayer('wr1', 'WR', 18),
    rankedPlayer('rb2', 'RB', 15),
    rankedPlayer('qb1', 'QB', 12),
  ];
  const { top, altSamePosition, altNextPosition } = pickHeadlineRecommendation(list);
  assert.equal(top.id, 'rb1');
  assert.equal(altSamePosition.id, 'rb2'); // next-best RB, skipping wr1 which outranks it
  assert.equal(altNextPosition.id, 'wr1'); // best player at the first different position encountered
});

test('pickHeadlineRecommendation: altSamePosition is null when the top pick is the only player left at their position', () => {
  const list = [rankedPlayer('rb1', 'RB', 20), rankedPlayer('wr1', 'WR', 18)];
  const { altSamePosition, altNextPosition } = pickHeadlineRecommendation(list);
  assert.equal(altSamePosition, null);
  assert.equal(altNextPosition.id, 'wr1');
});

test('pickHeadlineRecommendation: altNextPosition is null when every remaining player is the same position as the top pick', () => {
  const list = [rankedPlayer('rb1', 'RB', 20), rankedPlayer('rb2', 'RB', 15), rankedPlayer('rb3', 'RB', 10)];
  const { altSamePosition, altNextPosition } = pickHeadlineRecommendation(list);
  assert.equal(altSamePosition.id, 'rb2');
  assert.equal(altNextPosition, null);
});

test('pickHeadlineRecommendation: a single-player list has a top but no alternates at all', () => {
  const { top, altSamePosition, altNextPosition } = pickHeadlineRecommendation([rankedPlayer('rb1', 'RB', 20)]);
  assert.equal(top.id, 'rb1');
  assert.equal(altSamePosition, null);
  assert.equal(altNextPosition, null);
});

test('pickHeadlineRecommendation: an empty list (no open starter slots anywhere) returns everything null, not a throw', () => {
  assert.deepEqual(pickHeadlineRecommendation([]), { top: null, altSamePosition: null, altNextPosition: null });
});

// recomputeWithScoringRules is what makes scoring a live, user-configurable
// setting instead of a build-time-only value — see the side panel's
// "Scoring settings" form and background.js's chrome.storage wiring. It
// needs real raw stat fields on each player (the same shape
// build-projections.js now includes in players-2026.json), not just
// adjustedPoints, since it recomputes basePoints from scratch under a new
// rules object.
test('recomputeWithScoringRules recomputes basePoints from raw stats under a different rule set', () => {
  const rawPlayers = [
    { id: 'RB1', position: 'RB', name: 'RB1', rushYds: 1000, rushTds: 10, rec: 50, recYds: 400, recTds: 2, fumblesLost: 1, errorAdjustment: 0, injuryDiscount: 0 },
  ];
  const standard = recomputeWithScoringRules(rawPlayers, DEFAULT_SCORING_RULES);
  const fullPPR = recomputeWithScoringRules(rawPlayers, { ...DEFAULT_SCORING_RULES, receptionPoints: 1 });
  assert.equal(fullPPR[0].basePoints - standard[0].basePoints, 25); // 50 receptions * 0.5 extra point each
});

test('recomputeWithScoringRules reapplies each player\'s existing errorAdjustment/injuryDiscount ratios on top of the newly-computed basePoints', () => {
  const rawPlayers = [
    { id: 'RB1', position: 'RB', name: 'RB1', rushYds: 1000, rushTds: 0, rec: 0, recYds: 0, recTds: 0, fumblesLost: 0, errorAdjustment: -0.1, injuryDiscount: 0.2 },
  ];
  const result = recomputeWithScoringRules(rawPlayers, DEFAULT_SCORING_RULES);
  // basePoints = 1000/20 = 50; adjustedPoints = 50 * 0.9 * 0.8 = 36
  assert.equal(result[0].basePoints, 50);
  assert.equal(result[0].adjustedPoints, 36);
});

// computeTierInfo is new wiring for the nominee card's "why this number"
// factors panel — computeTiers/computeTierDropoff already existed and were
// tested in scoring.test.js, but had no consumer anywhere in the live
// recommendation path before this. Tests here focus on the NEW behavior
// (tier lookup + remaining-in-tier/last-in-tier against the undrafted pool),
// not re-deriving computeTiers'/computeTierDropoff's own math.
test('computeTierInfo: tier membership and remainingInTier reflect who is still undrafted', () => {
  // Two clear tiers (small gaps within, one big gap between: 290->100 vs
  // 300<->290's small gap of 10 and 100<->90's small gap of 10), plus a third
  // player far enough below to form its own tier.
  const rbPool = [
    { id: 'RB1', position: 'RB', par: 300 },
    { id: 'RB2', position: 'RB', par: 290 },
    { id: 'RB3', position: 'RB', par: 100 },
    { id: 'RB4', position: 'RB', par: 90 },
    { id: 'RB5', position: 'RB', par: -50 },
  ];
  const undrafted = rbPool.filter((p) => p.id !== 'RB1'); // RB1 already sold
  const info = computeTierInfo({ activePlayerWithPAR: rbPool[2], playersWithPAR: rbPool, undraftedPlayers: undrafted });
  assert.equal(info.tier, 2);
  // RB5 (par: -50) is excluded from tier computation entirely (par > 0
  // restriction — see computeTierInfo's own comment), so only 2 real tiers
  // exist here, not 3.
  assert.equal(info.tierCount, 2);
  assert.equal(info.remainingInTier, 2); // RB3 and RB4 both still undrafted
  assert.equal(info.isLastInTier, false);
});

// Regression test for a real bug found live: the default 0.75-std-dev
// threshold, run over a position's full pool (including a long tail of
// below-replacement bench/waiver players), inflates std dev enough that
// EVERY player at a position — from the #1 overall pick to a deep waiver
// player — showed "tier 1 of 1". A small, curated synthetic pool (like the
// tests above) can't expose this failure mode; it only shows up with a
// realistic shape (a few real tiers, then a long flat tail), which is why
// this test builds one explicitly rather than trusting the tiny pools above
// to catch it.
test('computeTierInfo does not collapse an entire position into "tier 1 of 1" over a realistic pool', () => {
  const rbPool = [
    { id: 'RB1', position: 'RB', par: 300 },
    { id: 'RB2', position: 'RB', par: 290 },
    { id: 'RB3', position: 'RB', par: 100 },
    { id: 'RB4', position: 'RB', par: 90 },
    // A long tail of below-replacement bench/waiver players — the shape
    // that inflated std dev enough to hide real tier gaps under the old
    // unrestricted, default-threshold computation.
    ...Array.from({ length: 60 }, (_, i) => ({ id: `RBBench${i}`, position: 'RB', par: -10 - i })),
  ];
  const undrafted = rbPool; // nobody drafted yet
  const topInfo = computeTierInfo({ activePlayerWithPAR: rbPool[0], playersWithPAR: rbPool, undraftedPlayers: undrafted }); // RB1, par 300
  const secondTierInfo = computeTierInfo({ activePlayerWithPAR: rbPool[3], playersWithPAR: rbPool, undraftedPlayers: undrafted }); // RB4, par 90
  // Both are above-replacement (par > 0), so both get a real tier, not null
  // — and, per the old bug, both used to collapse to the SAME "tier 1 of 1"
  // despite a real 200-point gap between them.
  assert.notEqual(topInfo.tierCount, 1);
  assert.notEqual(topInfo.tier, secondTierInfo.tier);
  // A below-replacement bench player (par <= 0) is excluded from tier
  // computation entirely, same as background.js's own state.tierById —
  // there's no tier to report, so it comes back null rather than a
  // misleading "tier 1".
  const benchInfo = computeTierInfo({ activePlayerWithPAR: rbPool[rbPool.length - 1], playersWithPAR: rbPool, undraftedPlayers: undrafted });
  assert.equal(benchInfo.tier, null);
  // A player with no real tier can't be "last IN" a tier that doesn't
  // exist for them — without the guard, remainingInTier comes back 0 (no
  // one else shares a `null` tier) and 0 <= 1 would otherwise mislabel this
  // as a cliff, rendering nonsense like "last in tier null of 6".
  assert.equal(benchInfo.isLastInTier, false);
});

test('computeTierInfo: isLastInTier is true once every other player in the tier is drafted', () => {
  const rbPool = [
    { id: 'RB1', position: 'RB', par: 300 },
    { id: 'RB2', position: 'RB', par: 290 },
    { id: 'RB3', position: 'RB', par: 100 },
    { id: 'RB4', position: 'RB', par: 90 },
  ];
  const undrafted = rbPool.filter((p) => p.id !== 'RB3'); // the other tier-2 player is already sold
  const info = computeTierInfo({ activePlayerWithPAR: rbPool[3], playersWithPAR: rbPool, undraftedPlayers: undrafted });
  assert.equal(info.remainingInTier, 1);
  assert.equal(info.isLastInTier, true);
});

test('computeTierInfo returns null when there is no active player', () => {
  assert.equal(computeTierInfo({ activePlayerWithPAR: null, playersWithPAR: [], undraftedPlayers: [] }), null);
});

// computeActiveRunPosition — the snake list's fire-emoji "run" signal.
// Threshold (3 of the last 5) confirmed directly with the user; see this
// function's own comment in liveDraftState.js for the research behind it.
test('computeActiveRunPosition flags a position once 3 of the last 5 picks land there', () => {
  assert.equal(computeActiveRunPosition(['QB', 'WR', 'WR', 'RB', 'WR']), 'WR');
});

test('computeActiveRunPosition tolerates one off-position pick interrupting the stretch', () => {
  // WR, QB, WR, WR — 3 of the last 4 (and of the last 5) are WR; the QB in
  // the middle doesn't reset the count the way strict "3 in a row" would.
  assert.equal(computeActiveRunPosition(['RB', 'WR', 'QB', 'WR', 'WR']), 'WR');
});

test('computeActiveRunPosition returns null when no position hits the threshold', () => {
  assert.equal(computeActiveRunPosition(['QB', 'WR', 'RB', 'WR', 'TE']), null);
});

test('computeActiveRunPosition only looks at the last windowSize picks, not the full history', () => {
  // Three WRs happened, but they're outside the default 5-pick window.
  assert.equal(computeActiveRunPosition(['WR', 'WR', 'WR', 'QB', 'RB', 'TE', 'K']), null);
});

test('computeActiveRunPosition ignores unresolved (null/undefined) positions rather than crashing', () => {
  assert.equal(computeActiveRunPosition(['WR', null, 'WR', undefined, 'WR']), 'WR');
});

// computeTierRemainingCounts — the snake list's tier-cliff underline signal.
test('computeTierRemainingCounts counts undrafted players sharing a (position, tier) bucket', () => {
  const tierById = new Map([
    ['RB1', 1],
    ['RB2', 1],
    ['RB3', 2],
    ['WR1', 1],
  ]);
  const undrafted = [
    { id: 'RB1', position: 'RB' },
    { id: 'RB2', position: 'RB' },
    { id: 'RB3', position: 'RB' },
    { id: 'WR1', position: 'WR' },
  ];
  const counts = computeTierRemainingCounts(undrafted, tierById);
  assert.equal(counts.get('RB|1'), 2);
  assert.equal(counts.get('RB|2'), 1);
  assert.equal(counts.get('WR|1'), 1);
});

test('computeTierRemainingCounts drops to 1 once every tier-mate but one is drafted', () => {
  const tierById = new Map([
    ['RB1', 1],
    ['RB2', 1],
  ]);
  // RB1 already sold — only RB2 is left undrafted in tier 1.
  const undrafted = [{ id: 'RB2', position: 'RB' }];
  const counts = computeTierRemainingCounts(undrafted, tierById);
  assert.equal(counts.get('RB|1'), 1);
});

test('computeTierRemainingCounts skips players tierById has no entry for', () => {
  const tierById = new Map(); // e.g. below-replacement, or tiers not computed yet
  const undrafted = [{ id: 'RB1', position: 'RB' }];
  const counts = computeTierRemainingCounts(undrafted, tierById);
  assert.equal(counts.size, 0);
});

// computeTeamRanking — the "Draft Rank" tab's underlying math.
test('computeTeamRanking sums PAR per team and sorts best to worst', () => {
  const sales = [
    { teamId: 1, par: 50 },
    { teamId: 2, par: 30 },
    { teamId: 1, par: 20 },
    { teamId: 3, par: 90 },
  ];
  const ranking = computeTeamRanking(sales);
  assert.deepEqual(ranking, [
    { teamId: 3, totalPAR: 90 },
    { teamId: 1, totalPAR: 70 },
    { teamId: 2, totalPAR: 30 },
  ]);
});

test('computeTeamRanking skips entries with no resolved teamId or non-finite par', () => {
  const sales = [
    { teamId: 1, par: 50 },
    { teamId: null, par: 30 }, // unresolved sale (identity never matched)
    { teamId: 2, par: NaN },
    null,
  ];
  const ranking = computeTeamRanking(sales);
  assert.deepEqual(ranking, [{ teamId: 1, totalPAR: 50 }]);
});

test('computeTeamRanking returns an empty ranking when nobody has picked yet', () => {
  assert.deepEqual(computeTeamRanking([]), []);
});

// computeStarterOnlyRanking — Draft Rank's "Starters Only" toggle.
test('computeStarterOnlyRanking counts only enough top players per position (plus FLEX) to fill real starter slots', () => {
  const rosterSlots = { QB: 1, RB: 1, WR: 1, FLEX: 1, BENCH: 3 };
  // Team 1: 1 QB, 3 RBs, 1 WR. RB slot takes the best RB (30); the other
  // two RBs (20, 10) compete for the single shared FLEX slot along with
  // the WR (15) — FLEX should take the better of those (20), leaving the
  // rest on the bench, uncounted.
  const sales = [
    { teamId: 1, position: 'QB', par: 50 },
    { teamId: 1, position: 'RB', par: 30 },
    { teamId: 1, position: 'RB', par: 20 },
    { teamId: 1, position: 'RB', par: 10 },
    { teamId: 1, position: 'WR', par: 15 },
  ];
  const ranking = computeStarterOnlyRanking(sales, { rosterSlots, flexEligible: ['RB', 'WR', 'TE'] });
  // QB(50) + RB(30) + WR(15) + FLEX(best remaining RB, 20) = 115 — the
  // bench RB at 10 PAR is correctly excluded.
  assert.deepEqual(ranking, [{ teamId: 1, totalPAR: 115 }]);
});

test('computeStarterOnlyRanking ranks a bench-heavy team below a leaner team with a stronger real starting lineup', () => {
  const rosterSlots = { RB: 1, BENCH: 5 };
  // Team A: one elite RB, nothing else.
  const teamA = [{ teamId: 'A', position: 'RB', par: 100 }];
  // Team B: a weaker starter, but a stacked bench — Full Team totals
  // would put B ahead of A, but B's real STARTER total should lose.
  const teamB = [
    { teamId: 'B', position: 'RB', par: 40 },
    { teamId: 'B', position: 'RB', par: 39 },
    { teamId: 'B', position: 'RB', par: 38 },
  ];
  const ranking = computeStarterOnlyRanking([...teamA, ...teamB], { rosterSlots, flexEligible: [] });
  assert.deepEqual(ranking, [
    { teamId: 'A', totalPAR: 100 },
    { teamId: 'B', totalPAR: 40 },
  ]);
});

test('computeStarterOnlyRanking skips entries with no resolved teamId, non-finite par, or no position', () => {
  const sales = [
    { teamId: 1, position: 'RB', par: 50 },
    { teamId: null, position: 'RB', par: 30 },
    { teamId: 2, position: 'RB', par: NaN },
    { teamId: 3, position: null, par: 20 },
  ];
  const ranking = computeStarterOnlyRanking(sales, { rosterSlots: { RB: 1 }, flexEligible: [] });
  assert.deepEqual(ranking, [{ teamId: 1, totalPAR: 50 }]);
});
