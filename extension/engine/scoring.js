// Deterministic scoring engine. See ../SPEC.md for the formulas and the
// reasoning behind them — this file is a direct implementation of that spec,
// no logic lives here that isn't explained there.
//
// Pure functions only: no chrome.* APIs, no network, no DOM. This is what
// lets it run inside the extension's side panel AND be unit tested with
// plain Node, and it's what the offline data-analysis step (calibrating the
// Layer 1 adjustment factors) will eventually feed adjustedPoints into.

export function effectiveStarterSlots(position, leagueConfig) {
  const { rosterSlots, flexEligible = [], flexShare = {} } = leagueConfig;
  const base = rosterSlots[position] || 0;
  const flexSlots = rosterSlots.FLEX || 0;
  if (flexEligible.includes(position)) {
    return base + flexSlots * (flexShare[position] || 0);
  }
  return base;
}

function nonRosterPositions(rosterSlots) {
  return Object.keys(rosterSlots).filter((pos) => pos !== 'FLEX' && pos !== 'BENCH');
}

// Static — computed once from the full pre-draft player pool.
export function computeReplacementLevels(players, leagueConfig) {
  const levels = {};
  for (const pos of nonRosterPositions(leagueConfig.rosterSlots)) {
    const atPos = players
      .filter((p) => p.position === pos)
      .sort((a, b) => b.adjustedPoints - a.adjustedPoints);
    const rank = Math.round(leagueConfig.numTeams * effectiveStarterSlots(pos, leagueConfig)) + 1;
    const idx = Math.max(0, Math.min(rank, atPos.length) - 1);
    levels[pos] = atPos.length ? atPos[idx].adjustedPoints : 0;
  }
  return levels;
}

// Static — PAR does not change as the draft progresses, only Value does.
export function computePAR(players, replacementLevels) {
  return players.map((p) => ({
    ...p,
    par: p.adjustedPoints - (replacementLevels[p.position] ?? 0),
  }));
}

// Dynamic — recompute on every pick using only the still-undrafted subset.
// Negative-PAR players (below replacement) are clamped to 0 for the share
// calculation so they don't distort the denominator or produce negative
// shares for players worse than replacement level.
export function computeValue(undraftedPlayers) {
  const parSumByPosition = {};
  for (const p of undraftedPlayers) {
    parSumByPosition[p.position] = (parSumByPosition[p.position] || 0) + Math.max(p.par, 0);
  }
  const value = {};
  for (const p of undraftedPlayers) {
    const denom = parSumByPosition[p.position];
    value[p.id] = denom > 0 ? Math.max(p.par, 0) / denom : 0;
  }
  return value;
}

export function positionStdDev(playersAtPosition) {
  const pars = playersAtPosition.map((p) => p.par);
  if (pars.length === 0) return 0;
  const mean = pars.reduce((s, v) => s + v, 0) / pars.length;
  const variance = pars.reduce((s, v) => s + (v - mean) ** 2, 0) / pars.length;
  return Math.sqrt(variance);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Static tiers over the full position pool. A tier break fires when the gap
// between two consecutive players exceeds tierGapMultiplier times the
// MEDIAN gap size within this pool.
//
// Real bug found live, independently on both RB and WR, and cross-checked
// against boberto.app's own tiers (which run a sane 2-8 players wide):
// the earlier version compared each gap against a multiple of
// positionStdDev — the STANDARD DEVIATION OF RAW VALUES across the whole
// pool. That statistic is dominated by the handful of huge gaps that
// happen right at the top of a position (RB1 vs. RB2, WR1 vs. WR2/3 tend
// to be real blowouts some years) — those few outliers inflate the value
// spread enough that the derived threshold ends up BIGGER than nearly
// every other real, meaningful gap further down the list, collapsing
// 15-20 genuinely different players into one tier. Confirmed live: 2026's
// real RB pool put McCaffrey ($42) through Bucky Irving ($15) all in one
// "RB4" tier; WR was worse, dumping literally everyone outside the top 4
// into a single "WR2".
//
// Comparing each gap to the MEDIAN gap size instead of the value std dev
// fixes this by construction: a couple of huge outlier gaps barely move a
// median, so the threshold stays sized to what a "typical" step between
// neighboring players in this pool actually looks like, rather than being
// dragged up by the very outliers it's supposed to be detecting.
// tierGapMultiplier: 2 chosen by testing against the real 2026 pool across
// RB/WR/TE/QB and comparing resulting tier sizes to boberto.app's own
// (visibly 2-8 players wide) — see README for the exact real numbers this
// was calibrated against.
export function computeTiers(playersAtPosition, { tierGapMultiplier = 2 } = {}) {
  const sorted = [...playersAtPosition].sort((a, b) => b.par - a.par);
  if (sorted.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i - 1].par - sorted[i].par);
  const medianGap = median(gaps) || 1; // avoid divide-by-zero when every gap is 0 (all players tied)
  const threshold = tierGapMultiplier * medianGap;
  let tier = 1;
  const result = [{ id: sorted[0].id, tier }];
  for (let i = 1; i < sorted.length; i++) {
    if (gaps[i - 1] > threshold) tier++;
    result.push({ id: sorted[i].id, tier });
  }
  return result;
}

// Dynamic — how big is the cliff right at the top of what's left at this
// position, right now. Normalized against the FULL position's std dev (not
// the shrinking undrafted pool's), so the signal doesn't get noisy as a
// position thins out.
export function computeTierDropoff(undraftedAtPosition, fullPositionStdDev) {
  const sorted = [...undraftedAtPosition].sort((a, b) => b.par - a.par);
  if (sorted.length < 2) return { dropoff: 0, stdDevs: 0 };
  const dropoff = sorted[0].par - sorted[1].par;
  const stdDevs = fullPositionStdDev > 0 ? dropoff / fullPositionStdDev : 0;
  return { dropoff, stdDevs };
}

// Static auction baseline — the "fair value in a vacuum" price, before this
// specific room's behavior is factored in.
//
// benchBudgetShare (0-1, default 0): what fraction of the ENTIRE budget pool
// the user wants earmarked for bench, on top of the $1/slot minimum every
// real auction requires (that floor can't be dialed away — it's a platform
// rule, not a preference). 0 means "spend everything on the starting
// lineup," matching SPEC.md's stated objective and this function's original,
// unparameterized behavior exactly (existing callers/tests are unaffected).
// A nonzero value trades dollarPerPAR — and therefore every starter's fair
// price — down, in exchange for a bigger bench budget.
export function computeAuctionBaseline(playersWithPAR, leagueConfig) {
  const { numTeams, budgetPerTeam, rosterSlots, benchBudgetShare = 0 } = leagueConfig;
  const totalBudgetPool = numTeams * budgetPerTeam;
  const totalRosterSlots = Object.values(rosterSlots).reduce((s, v) => s + v, 0);
  const totalStarterSlots = Object.entries(rosterSlots)
    .filter(([pos]) => pos !== 'BENCH')
    .reduce((s, [, v]) => s + v, 0);
  const benchSlots = totalRosterSlots - totalStarterSlots;
  const floorReservedDollars = numTeams * benchSlots * 1;
  const targetReservedDollars = totalBudgetPool * benchBudgetShare;
  const reservedDollars = Math.max(floorReservedDollars, targetReservedDollars);

  let totalStarterPARPool = 0;
  for (const pos of nonRosterPositions(rosterSlots)) {
    const atPos = playersWithPAR.filter((p) => p.position === pos).sort((a, b) => b.par - a.par);
    const starterCount = Math.round(numTeams * effectiveStarterSlots(pos, leagueConfig));
    totalStarterPARPool += atPos.slice(0, starterCount).reduce((s, p) => s + Math.max(p.par, 0), 0);
  }

  const dollarPerPAR = totalStarterPARPool > 0 ? (totalBudgetPool - reservedDollars) / totalStarterPARPool : 0;
  return { totalBudgetPool, reservedDollars, totalStarterPARPool, dollarPerPAR };
}

export function fairPrice(player, baseline) {
  return Math.max(1, Math.round(player.par * baseline.dollarPerPAR));
}

// Dynamic, per position — blends the static baseline rate toward what this
// room has actually paid for PAR at this position so far, ramping up over
// `blendPicks` picks at that position (default 3 — see SPEC.md open decision
// #3) so one early overpay/underpay doesn't overreact the whole market.
export function computeLiveDollarPerPAR(completedPicksAtPosition, baseline, { blendPicks = 3 } = {}) {
  const n = completedPicksAtPosition.length;
  if (n === 0) return baseline.dollarPerPAR;
  const dollarsSpent = completedPicksAtPosition.reduce((s, p) => s + p.price, 0);
  const parConsumed = completedPicksAtPosition.reduce((s, p) => s + Math.max(p.par, 0), 0);
  const observedRate = parConsumed > 0 ? dollarsSpent / parConsumed : baseline.dollarPerPAR;
  const weight = Math.min(1, n / blendPicks);
  return baseline.dollarPerPAR * (1 - weight) + observedRate * weight;
}

// myRosterState: { remainingBudget, otherOpenSlotCount }
// liveDollarPerPARByPosition: { pos: rate }
//
// Deliberately does NOT gate on openStarterSlots (used to return
// {maxBid: 0, reason: 'no-open-slot'} whenever the position's starters
// looked full) — removed per direct request: the user can already see
// their own roster fill status on the draft platform's own screen, and a
// full starter slot doesn't mean a player has no value (bench, a later
// trade, or just a straight-up better player than what's rostered there
// now are all real reasons to still want a real number). This also sidesteps
// openStarterSlots ever being wrong (a mismatched saved roster-slot count,
// unresolved team identity, etc.) silently zeroing out an otherwise-valid
// recommendation — a real bug this exact gate caused, confirmed live.
export function recommendMaxBid(player, myRosterState, liveDollarPerPARByPosition) {
  const { remainingBudget, otherOpenSlotCount = 0 } = myRosterState;
  const rate = liveDollarPerPARByPosition[player.position] || 0;
  const budgetCap = remainingBudget - otherOpenSlotCount; // reserve $1 per other open slot
  const valueCap = Math.max(1, Math.round(Math.max(player.par, 0) * rate));
  const maxBid = Math.max(0, Math.min(budgetCap, valueCap));
  // Which of the two caps actually bound the number — a genuinely different
  // story for the user ("he's not worth more" vs. "you can't afford more")
  // that the two raw numbers alone don't distinguish at a glance.
  const bindingConstraint = valueCap <= budgetCap ? 'value' : 'budget';
  return { maxBid, reason: 'value', valueCap, budgetCap, bindingConstraint };
}

// "Leave value on the table" margin, per direct request: winning a bid at
// exact fair value is a wash, not a win — the whole point of drafting well
// is walking away with value. Applied as a PERCENTAGE of fair value (not a
// flat dollar amount) so it scales sanely across the price range — a flat
// $3 would be enormous on a $5 bench player and negligible on a $60 star.
// Deliberately a separate function from recommendMaxBid rather than a
// parameter on it — recommendMaxBid's own tests and bindingConstraint
// reasoning stay valid as the UNMARGINED number (still useful, e.g. for
// "what's this player actually worth" elsewhere), and this stays a small,
// single-purpose transform on top of it.
const VALUE_MARGIN_PERCENT = 0.08;

export function applyValueMargin(rec, marginPercent = VALUE_MARGIN_PERCENT) {
  if (!rec) return rec;
  const marginedValueCap = Math.max(1, Math.round(rec.valueCap * (1 - marginPercent)));
  const maxBid = Math.max(0, Math.min(rec.budgetCap, marginedValueCap));
  // Re-derive against the MARGINED cap, not the original valueCap — the
  // margin can flip which constraint actually binds (a player who was
  // budget-bound before the margin can become value-bound after it, once
  // the value side has been pulled down).
  const bindingConstraint = marginedValueCap <= rec.budgetCap ? 'value' : 'budget';
  return { ...rec, maxBid, valueCap: marginedValueCap, bindingConstraint, rawValueCap: rec.valueCap };
}

// Bid/Hold/Pass verdict for the currently nominated player, comparing the
// LIVE price against the (already margined) recommended max. A fresh
// nomination with no bid yet reads as 'bid' (still under, nothing to
// hesitate about); 'hold' is a deliberately narrow $1 band right at the
// ceiling — "this is close, your call" — rather than a hard cutover
// straight from bid to pass.
export function computeBidVerdict(currentPrice, maxBid) {
  if (currentPrice === null || currentPrice === undefined) return 'bid';
  if (currentPrice > maxBid) return 'pass';
  if (currentPrice >= maxBid - 1) return 'hold';
  return 'bid';
}
