import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveStarterSlots,
  computeReplacementLevels,
  computePAR,
  computeValue,
  positionStdDev,
  computeTiers,
  computeTierDropoff,
  computeAuctionBaseline,
  fairPrice,
  computeLiveDollarPerPAR,
  recommendMaxBid,
  applyValueMargin,
  computeBidVerdict,
} from './scoring.js';

// A small 4-team league: 1 QB, 2 RB, 2 WR, 1 FLEX(RB/WR/TE), 3 BENCH.
const leagueConfig = {
  numTeams: 4,
  budgetPerTeam: 100,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 3 },
  flexEligible: ['RB', 'WR', 'TE'],
  flexShare: { RB: 0.5, WR: 0.4, TE: 0.1 },
};

function player(id, position, adjustedPoints) {
  return { id, position, adjustedPoints, name: id };
}

const rbs = [
  player('RB1', 'RB', 300),
  player('RB2', 'RB', 250),
  player('RB3', 'RB', 200),
  player('RB4', 'RB', 150),
  player('RB5', 'RB', 100),
  player('RB6', 'RB', 90),
  player('RB7', 'RB', 80),
  player('RB8', 'RB', 70),
  player('RB9', 'RB', 60),
  player('RB10', 'RB', 50),
];
const wrs = [
  player('WR1', 'WR', 280),
  player('WR2', 'WR', 240),
  player('WR3', 'WR', 200),
  player('WR4', 'WR', 160),
  player('WR5', 'WR', 120),
  player('WR6', 'WR', 100),
  player('WR7', 'WR', 90),
  player('WR8', 'WR', 80),
  player('WR9', 'WR', 70),
];
const qbs = [player('QB1', 'QB', 350), player('QB2', 'QB', 300), player('QB3', 'QB', 250), player('QB4', 'QB', 200), player('QB5', 'QB', 150)];
const tes = [player('TE1', 'TE', 200), player('TE2', 'TE', 120), player('TE3', 'TE', 90), player('TE4', 'TE', 60)];

const allPlayers = [...qbs, ...rbs, ...wrs, ...tes];

test('effectiveStarterSlots splits the flex slot per flexShare', () => {
  assert.equal(effectiveStarterSlots('RB', leagueConfig), 2 + 1 * 0.5);
  assert.equal(effectiveStarterSlots('WR', leagueConfig), 2 + 1 * 0.4);
  assert.equal(effectiveStarterSlots('TE', leagueConfig), 1 + 1 * 0.1);
  assert.equal(effectiveStarterSlots('QB', leagueConfig), 1); // not flex-eligible
});

test('replacement level lands on the correct ranked player per position', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  // RB: numTeams(4) * effectiveSlots(2.5) + 1 = round(10)+1 = 11th best RB -> only 10 exist, clamps to last (RB10, 50)
  assert.equal(levels.RB, 50);
  // QB: 4 * 1 + 1 = 5th best QB -> QB5, 150
  assert.equal(levels.QB, 150);
  // TE: 4 * 1.1 + 1 = round(4.4)+1 = 5 -> only 4 TEs exist, clamps to last (TE4, 60)
  assert.equal(levels.TE, 60);
});

test('PAR is adjustedPoints minus that position\'s replacement level, and is static', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const rb1 = withPAR.find((p) => p.id === 'RB1');
  assert.equal(rb1.par, 300 - levels.RB);
  const qb1 = withPAR.find((p) => p.id === 'QB1');
  assert.equal(qb1.par, 350 - levels.QB);
});

test('Value shares sum to 1 within a position and shrink as the pool is drafted', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const rbPool = withPAR.filter((p) => p.position === 'RB');

  const fullValue = computeValue(rbPool);
  const fullSum = rbPool.reduce((s, p) => s + fullValue[p.id], 0);
  assert.ok(Math.abs(fullSum - 1) < 1e-9);

  // RB1 drafted — its share should redistribute among the rest, and RB2's
  // share should go up now that the best player at the position is gone.
  const withoutRB1 = rbPool.filter((p) => p.id !== 'RB1');
  const reducedValue = computeValue(withoutRB1);
  assert.ok(reducedValue.RB2 > fullValue.RB2);
});

test('computeTiers creates a new tier across an obvious gap', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const rbPool = withPAR.filter((p) => p.position === 'RB');
  const tiers = computeTiers(rbPool);
  const tierOf = (id) => tiers.find((t) => t.id === id).tier;

  // RB1 (par 250) vs RB2 (par 200) — a 50pt gap right at the top should be a
  // tier break given the position's spread; assert it's monotonic at least.
  assert.equal(tierOf('RB1'), 1);
  assert.ok(tierOf('RB10') >= tierOf('RB1'));
});

// Regression test for a real bug found live, independently on both RB and
// WR (and cross-checked against boberto.app's own tiers, which run a sane
// 2-8 players wide): the earlier version compared each gap to a multiple
// of the position's value std dev, a statistic dominated by a couple of
// huge outlier gaps right at the top of a position. Confirmed live against
// real 2026 RB data (par values below are the ACTUAL real PAR figures,
// generic ids substituted for the real player names): the huge RB1→RB2
// and RB2→RB3 gaps inflated the value std dev enough that the derived
// threshold became bigger than every other real gap in the rest of the
// position — a 5-player group with real, distinguishable value steps
// (ranks 4-8) got swallowed into the same giant 19-player tier as
// everyone below it. This test uses that real shape and asserts the
// 5-player group forms its own tier, separate from the bigger group below.
test('computeTiers does not let a few huge top-of-position gaps swallow a real, smaller-but-genuine tier further down', () => {
  const realRbPars = [126.4, 99.7, 82.3, 63.2, 62.6, 60.0, 57.8, 53.9, 46.4, 44.2, 43.7, 42.4, 38.2, 35.4, 34.3, 29.5, 29.3, 25.9, 20.3, 17.4, 16.2, 15.5, 5.0, 1.7, 0.4];
  const pool = realRbPars.map((par, i) => ({ id: `RB${i + 1}`, position: 'RB', par }));
  const tiers = computeTiers(pool);
  const tierOf = (id) => tiers.find((t) => t.id === id).tier;

  // The three real blowout-gap players (indices 0-2) are each their own tier.
  assert.equal(tierOf('RB1'), 1);
  assert.equal(tierOf('RB2'), 2);
  assert.equal(tierOf('RB3'), 3);

  // Ranks 4-8 (RB4..RB8) form their own real tier, distinct from the
  // bigger group below them (ranks 9-22) — this is the exact group the old
  // std-dev-based threshold used to swallow into one 19-player tier.
  const midTierTier = tierOf('RB4');
  for (const id of ['RB5', 'RB6', 'RB7', 'RB8']) assert.equal(tierOf(id), midTierTier);
  assert.notEqual(tierOf('RB9'), midTierTier);
});

test('computeTierDropoff reflects the cliff at the top of the remaining pool', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const rbPool = withPAR.filter((p) => p.position === 'RB');
  const stdDev = positionStdDev(rbPool);

  const dropoffFull = computeTierDropoff(rbPool, stdDev);
  assert.ok(dropoffFull.stdDevs > 0);

  // Once only RB9/RB10 remain (a small, flat gap), dropoff should shrink.
  const bottomTwo = rbPool.filter((p) => p.id === 'RB9' || p.id === 'RB10');
  const dropoffBottom = computeTierDropoff(bottomTwo, stdDev);
  assert.ok(dropoffBottom.stdDevs < dropoffFull.stdDevs);
});

test('auction baseline: budget pool minus reserved dollars spreads across starter PAR', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const baseline = computeAuctionBaseline(withPAR, leagueConfig);

  assert.equal(baseline.totalBudgetPool, 4 * 100); // 400
  // 8 roster slots total, 6 are starters (QB+RB2+WR2+TE1... plus FLEX not counted as its own slot here
  // since FLEX is excluded from totalStarterSlots the same way BENCH is from totalRosterSlots calc) —
  // just assert reservedDollars is positive and less than the full pool, and dollarPerPAR is positive.
  assert.ok(baseline.reservedDollars > 0);
  assert.ok(baseline.reservedDollars < baseline.totalBudgetPool);
  assert.ok(baseline.dollarPerPAR > 0);

  const rb1 = withPAR.find((p) => p.id === 'RB1');
  assert.equal(fairPrice(rb1, baseline), Math.max(1, Math.round(rb1.par * baseline.dollarPerPAR)));
});

test('auction baseline: default benchBudgetShare (0) matches the original unparameterized $1/slot-floor behavior exactly', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const withoutShare = computeAuctionBaseline(withPAR, leagueConfig);
  const withExplicitZero = computeAuctionBaseline(withPAR, { ...leagueConfig, benchBudgetShare: 0 });
  assert.deepEqual(withoutShare, withExplicitZero);
});

test('auction baseline: a nonzero benchBudgetShare reserves more than the $1/slot floor, lowering dollarPerPAR', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const floorOnly = computeAuctionBaseline(withPAR, leagueConfig);
  // 3 BENCH slots * 4 teams * $1 floor = $12; 50% of the $400 pool ($200) is far above that floor.
  const withShare = computeAuctionBaseline(withPAR, { ...leagueConfig, benchBudgetShare: 0.5 });
  assert.equal(withShare.reservedDollars, withShare.totalBudgetPool * 0.5);
  assert.ok(withShare.reservedDollars > floorOnly.reservedDollars);
  assert.ok(withShare.dollarPerPAR < floorOnly.dollarPerPAR);
});

test('auction baseline: benchBudgetShare never reserves LESS than the real $1/slot minimum-bid floor', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const floorOnly = computeAuctionBaseline(withPAR, leagueConfig);
  const withTinyShare = computeAuctionBaseline(withPAR, { ...leagueConfig, benchBudgetShare: 0.001 }); // far below the floor in dollar terms
  assert.equal(withTinyShare.reservedDollars, floorOnly.reservedDollars);
});

// This is the actual math behind historicalErrorAdjustments.js's decision to
// mean-center errorAdjustment instead of applying the raw (all-negative)
// measurement: dollarPerPAR is total budget ÷ total starter PAR pool, so a
// bias applied EQUALLY to every position shrinks the PAR pool and inflates
// dollarPerPAR by exactly the same factor — the two cancel, and every fair
// price comes out identical to the unbiased case. Only bias that DIFFERS
// between positions ever moves money, which centering preserves exactly
// while a uniform shift contributes nothing.
test('a uniform per-position bias applied to adjustedPoints leaves every fairPrice unchanged (self-normalization via dollarPerPAR)', () => {
  const uniformFactor = 0.85; // stand-in for "every position projects 15% high"
  const biasedPlayers = allPlayers.map((p) => ({ ...p, adjustedPoints: p.adjustedPoints * uniformFactor }));

  const baseLevels = computeReplacementLevels(allPlayers, leagueConfig);
  const baseWithPAR = computePAR(allPlayers, baseLevels);
  const baseBaseline = computeAuctionBaseline(baseWithPAR, leagueConfig);

  const biasedLevels = computeReplacementLevels(biasedPlayers, leagueConfig);
  const biasedWithPAR = computePAR(biasedPlayers, biasedLevels);
  const biasedBaseline = computeAuctionBaseline(biasedWithPAR, leagueConfig);

  for (const id of ['RB1', 'WR3', 'QB2', 'TE1']) {
    const base = fairPrice(baseWithPAR.find((p) => p.id === id), baseBaseline);
    const biased = fairPrice(biasedWithPAR.find((p) => p.id === id), biasedBaseline);
    assert.equal(biased, base);
  }
});

test('live $/PAR blends toward observed spending as picks accumulate at a position', () => {
  const levels = computeReplacementLevels(allPlayers, leagueConfig);
  const withPAR = computePAR(allPlayers, levels);
  const baseline = computeAuctionBaseline(withPAR, leagueConfig);
  const rb1 = withPAR.find((p) => p.id === 'RB1');
  const rb2 = withPAR.find((p) => p.id === 'RB2');

  // Room is overpaying for RBs relative to fair value.
  const overpaidPrice = fairPrice(rb1, baseline) * 2;
  const picks = [{ position: 'RB', price: overpaidPrice, par: rb1.par }];

  const rateAfterOnePick = computeLiveDollarPerPAR(picks, baseline);
  assert.ok(rateAfterOnePick > baseline.dollarPerPAR);
  assert.ok(rateAfterOnePick < overpaidPrice / rb1.par); // blended, not fully overreacted after 1 pick

  const picksTwo = [...picks, { position: 'RB', price: fairPrice(rb2, baseline) * 2, par: rb2.par }];
  const picksThree = [...picksTwo, { position: 'RB', price: fairPrice(rb1, baseline) * 2, par: rb1.par }];
  const rateAfterThreePicks = computeLiveDollarPerPAR(picksThree, baseline, { blendPicks: 3 });
  // fully blended in (weight=1) after 3 picks at the position
  const dollarsSpent = picksThree.reduce((s, p) => s + p.price, 0);
  const parConsumed = picksThree.reduce((s, p) => s + p.par, 0);
  assert.ok(Math.abs(rateAfterThreePicks - dollarsSpent / parConsumed) < 1e-9);
});

test('recommendMaxBid caps at remaining budget minus reserved $1 per other open slot', () => {
  const p = { id: 'RB1', position: 'RB', par: 200 };
  const myRosterState = { openStarterSlots: { RB: 1 }, remainingBudget: 20, otherOpenSlotCount: 5 };
  // value cap would be huge (200 * rate), but budget cap (20 - 5 = 15) should bind.
  const result = recommendMaxBid(p, myRosterState, { RB: 10 });
  assert.equal(result.maxBid, 15);
  assert.equal(result.bindingConstraint, 'budget');
});

test('recommendMaxBid caps at value (PAR × live rate) when budget is not the binding constraint', () => {
  const p = { id: 'RB1', position: 'RB', par: 10 };
  const myRosterState = { openStarterSlots: { RB: 1 }, remainingBudget: 200, otherOpenSlotCount: 0 };
  const result = recommendMaxBid(p, myRosterState, { RB: 1.5 });
  assert.equal(result.maxBid, Math.round(10 * 1.5));
  assert.equal(result.bindingConstraint, 'value');
});

test('recommendMaxBid: bindingConstraint distinguishes "not worth more" from "can\'t afford more" — the whole point of adding it', () => {
  const p = { id: 'RB1', position: 'RB', par: 5 }; // low PAR -> low value cap
  const flush = recommendMaxBid(p, { openStarterSlots: { RB: 1 }, remainingBudget: 200, otherOpenSlotCount: 0 }, { RB: 1 });
  assert.equal(flush.bindingConstraint, 'value'); // plenty of budget, he's just not worth much

  const broke = recommendMaxBid(p, { openStarterSlots: { RB: 1 }, remainingBudget: 3, otherOpenSlotCount: 0 }, { RB: 100 });
  assert.equal(broke.bindingConstraint, 'budget'); // he'd be worth a lot, but there's no money left
});

// applyValueMargin — the "leave value on the table" discount, per direct
// request. A percentage of fair value (valueCap), not a flat dollar
// amount or a discount off the already-budget-capped maxBid — see the
// function's own comment for why.
test('applyValueMargin reduces valueCap and maxBid by the given percentage when value is the binding constraint', () => {
  const rec = { maxBid: 100, reason: 'value', valueCap: 100, budgetCap: 200, bindingConstraint: 'value' };
  const margined = applyValueMargin(rec, 0.1);
  assert.equal(margined.valueCap, 90);
  assert.equal(margined.maxBid, 90); // budgetCap (200) isn't the binding constraint, so maxBid follows valueCap down
  assert.equal(margined.bindingConstraint, 'value');
  assert.equal(margined.rawValueCap, 100); // the pre-margin figure is preserved, not discarded
});

test('applyValueMargin can flip which constraint binds: a player budget-bound before the margin can become value-bound after it', () => {
  // Before margining: valueCap (100) > budgetCap (95), so budget already binds.
  // After a 10% margin, valueCap drops to 90, which is now BELOW budgetCap —
  // value becomes the real constraint, not budget, even though budget bound first.
  const rec = { maxBid: 95, reason: 'value', valueCap: 100, budgetCap: 95, bindingConstraint: 'budget' };
  const margined = applyValueMargin(rec, 0.1);
  assert.equal(margined.valueCap, 90);
  assert.equal(margined.maxBid, 90);
  assert.equal(margined.bindingConstraint, 'value');
});

test('applyValueMargin never discounts below the real $1 floor', () => {
  const rec = { maxBid: 1, reason: 'value', valueCap: 1, budgetCap: 5, bindingConstraint: 'value' };
  const margined = applyValueMargin(rec, 0.5);
  assert.equal(margined.valueCap, 1);
  assert.equal(margined.maxBid, 1);
});

test('applyValueMargin tolerates a null recommendation (no active player yet) rather than throwing', () => {
  assert.equal(applyValueMargin(null), null);
});

// computeBidVerdict — Bid/Hold/Pass for the currently nominated player,
// comparing the room's live price against the (already margined) max.
test('computeBidVerdict: bid while comfortably under the max, pass once price exceeds it', () => {
  assert.equal(computeBidVerdict(10, 20), 'bid');
  assert.equal(computeBidVerdict(21, 20), 'pass');
});

test('computeBidVerdict: hold in a narrow $1 band right at the ceiling', () => {
  assert.equal(computeBidVerdict(19, 20), 'hold');
  assert.equal(computeBidVerdict(20, 20), 'hold');
});

test('computeBidVerdict: a fresh nomination with no bid yet reads as bid, not pass', () => {
  assert.equal(computeBidVerdict(null, 20), 'bid');
  assert.equal(computeBidVerdict(undefined, 20), 'bid');
});
