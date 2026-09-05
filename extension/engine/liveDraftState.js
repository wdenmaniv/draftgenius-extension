// Pure orchestration logic tying the scoring engine (PAR/Value/bid
// recommendations) together with what a live draft actually gives us —
// resolved teams, resolved players, running sales. Kept separate from
// background.js on purpose: background.js is tightly coupled to
// chrome.runtime APIs and can't be unit tested the way everything else in
// engine/ has been all along; this file has none of that coupling.
import {
  computeReplacementLevels,
  computePAR,
  computeAuctionBaseline,
  computeLiveDollarPerPAR,
  recommendMaxBid,
  computeTiers,
  computeTierDropoff,
  positionStdDev,
} from './scoring.js';
import { computeLeaguePoints } from './projections/leagueScoring.js';
import { applyLayer1Adjustments } from './projections/layer1Adjustments.js';

// Fallback defaults, used until the real league's roster requirements are
// known. Unlike numTeams/budgetPerTeam (always observed live from the DOM),
// no reliable per-position roster-slot DOM source was found on either
// platform (see README.md) — ESPN's draft-room DOM has nothing roster-shaped
// at all, and Yahoo's team row has only an aggregate "13/15" roster-fill
// count, not a per-position breakdown. Rather than guess brittle selectors
// that can't be verified without a live draft, the side panel now lets the
// user enter their real league's roster settings once (persisted via
// chrome.storage.local, see background.js's storage.onChanged listener) —
// these constants are only the seed/fallback shown in that form, not a
// silent assumption baked into the math anymore. flexEligible/flexShare
// remain the v1 defaults; only rosterSlots is user-configurable so far.
export const DEFAULT_ROSTER_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 6 };
export const DEFAULT_FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];
export const DEFAULT_FLEX_SHARE = { RB: 0.5, WR: 0.4, TE: 0.1 };

export function buildLeagueConfig({
  numTeams,
  budgetPerTeam,
  rosterSlots = DEFAULT_ROSTER_SLOTS,
  flexEligible = DEFAULT_FLEX_ELIGIBLE,
  flexShare = DEFAULT_FLEX_SHARE,
  benchBudgetShare = 0, // see computeAuctionBaseline in scoring.js — 0 = spend everything on the starting lineup
}) {
  return {
    numTeams,
    budgetPerTeam,
    rosterSlots,
    flexEligible,
    flexShare,
    benchBudgetShare,
  };
}

// Recomputes basePoints/adjustedPoints for every player under a
// user-supplied scoring rules object, instead of the build-time defaults
// baked into players-2026.json. Real league scoring settings differ per
// league (SPEC.md's whole premise, and confirmed for real via elboberto's
// LeagueInfo tab — see leagueScoring.js) — requiring every user to hand-edit
// data/league-config.json and rerun a Node build script isn't usable by
// anyone but a developer editing their OWN league's numbers. This makes
// scoring a live, in-extension setting instead, same as roster slots and
// bench budget % already are (side panel form, chrome.storage.local).
//
// Reapplies each player's precomputed errorAdjustment/injuryDiscount ratios
// on top of the newly-computed basePoints, rather than recalibrating those —
// both are per-position/per-player facts about historical projection bias
// and games-played history, independent of which scoring rule set converts
// raw stats to points. See historicalErrorAdjustments.js for why
// errorAdjustment is real and applied (a genuine FantasyPros-wide bias, not
// specific to any one league) rather than excluded.
export function recomputeWithScoringRules(players, scoringRules) {
  return players.map((p) => {
    const basePoints = computeLeaguePoints(p, scoringRules);
    const adjustedPoints = applyLayer1Adjustments(basePoints, {
      errorAdjustment: p.errorAdjustment || 0,
      injuryDiscount: p.injuryDiscount || 0,
    });
    return {
      ...p,
      basePoints: Math.round(basePoints * 10) / 10,
      adjustedPoints: Math.round(adjustedPoints * 10) / 10,
    };
  });
}

// One-time (per draft) PAR computation — PAR is a static baseline over the
// full player pool per SPEC.md, not recomputed as picks happen. Returns
// { playersWithPAR, auctionBaseline }.
export function initDraftPricing(players, leagueConfig) {
  const levels = computeReplacementLevels(players, leagueConfig);
  const playersWithPAR = computePAR(players, levels);
  const auctionBaseline = computeAuctionBaseline(playersWithPAR, leagueConfig);
  return { playersWithPAR, auctionBaseline };
}

export function computeUndraftedPool(playersWithPAR, soldPlayerIds) {
  return playersWithPAR.filter((p) => !soldPlayerIds.has(p.id));
}

// myPicks: [{ position, price }] — only the user's own completed picks.
// Roster-fill accounting, including FLEX: base position slots fill first;
// any flex-eligible picks beyond a position's base slots draw from the
// shared FLEX pool. This is a real simplification, documented here and in
// SPEC.md — correctly assigning WHICH specific picks "use" the flex slot
// when a team has overflow at multiple positions is an assignment-
// optimization problem, explicitly out of scope for v1. What this does
// guarantee: once flex capacity is exhausted, no flex-eligible position
// keeps getting free extra credit from it.
export function computeMyRosterState({ myPicks, leagueConfig }) {
  const { rosterSlots, flexEligible } = leagueConfig;

  const positionCounts = {};
  for (const pick of myPicks) {
    positionCounts[pick.position] = (positionCounts[pick.position] || 0) + 1;
  }

  let flexUsed = 0;
  for (const pos of flexEligible) {
    flexUsed += Math.max(0, (positionCounts[pos] || 0) - (rosterSlots[pos] || 0));
  }
  const flexRemaining = Math.max(0, (rosterSlots.FLEX || 0) - flexUsed);

  const openStarterSlots = {};
  for (const pos of Object.keys(rosterSlots)) {
    if (pos === 'FLEX' || pos === 'BENCH') continue;
    const baseOpen = Math.max(0, (rosterSlots[pos] || 0) - (positionCounts[pos] || 0));
    openStarterSlots[pos] = baseOpen + (flexEligible.includes(pos) && flexRemaining > 0 ? 1 : 0);
  }

  const totalRosterSlots = Object.values(rosterSlots).reduce((a, b) => a + b, 0);
  // `price` is optional — snake-draft picks have no dollar figure at all
  // (see recommendBestAvailable below), so this tolerates its absence rather
  // than producing NaN. remainingBudget/otherOpenSlotCount are meaningless
  // for snake and simply go unused there; openStarterSlots (the part snake
  // actually needs) doesn't depend on price at all.
  const spent = myPicks.reduce((s, p) => s + (p.price || 0), 0);

  return {
    openStarterSlots,
    remainingBudget: leagueConfig.budgetPerTeam - spent,
    // "other" open slots excludes the one slot the current pick under
    // consideration would fill.
    otherOpenSlotCount: Math.max(0, totalRosterSlots - myPicks.length - 1),
  };
}

// soldWithPAR: [{ position, price, par }] for every completed sale
// league-wide (not just the user's own picks) — this is what lets the live
// rate reflect the whole room's behavior, per SPEC.md's "personality of the
// draft" mechanism.
export function computeLiveRatesByPosition({ soldWithPAR, auctionBaseline, positions }) {
  const rates = {};
  for (const pos of positions) {
    const picksAtPos = soldWithPAR.filter((s) => s.position === pos).map((s) => ({ price: s.price, par: s.par }));
    rates[pos] = computeLiveDollarPerPAR(picksAtPos, auctionBaseline);
  }
  return rates;
}

// Deliberately prices off the STATIC baseline rate, not the room's live
// per-position spending — see computeLiveRatesByPosition/
// computeLiveDollarPerPAR below, which still get computed but only feed the
// nominee card's "market heat" factor, not the dollar figure itself. A
// recommendation that moves with how hot the room is running stops being an
// independent check against FOMO bidding and starts joining the herd; a
// "WR is running 10% hot" signal is more useful surfaced to the user's own
// judgment (do I think this is a real repricing or a temporary run?) than
// silently baked into the number.
export function computeRecommendation({ activePlayerWithPAR, myRosterState, auctionBaseline }) {
  if (!activePlayerWithPAR) return null;
  const baselineRate = auctionBaseline?.dollarPerPAR || 0;
  return recommendMaxBid(activePlayerWithPAR, myRosterState, { [activePlayerWithPAR.position]: baselineRate });
}

// New "why this number" signal for the nominee card's factors panel — is the
// active player the last real option before a cliff, or deep in a flat
// tier? Tiers are computed once over the FULL position pool (static, same
// as replacement level/PAR — matches computeTiers' own doc comment), then
// checked against which of that tier's players are still undrafted right
// now. `computeTierDropoff` already existed (built for SPEC.md's
// tier-dropoff signal) but was never actually wired into the live
// recommendation path before this — it was a real, tested capability with
// no consumer.
//
// Restricted to par > 0 — the SAME fix already applied twice elsewhere this
// session (draftgenius's rankings page, then the snake side panel's own
// tierById in background.js's ensurePricing): running tier computation over
// a position's full pool, including a long tail of below-replacement bench/
// waiver players, used to inflate the value spread enough that literally
// every player at a position landed in "tier 1 of 1" — confirmed live
// against real data before this fix. This was the one consumer of tiering
// that had never gotten that fix — auction's own "Scarcity" factor row,
// arguably the most important place for it to actually work. Uses the
// identical computeTiers call (default tierGapMultiplier) as
// background.js's state.tierById so auction and snake never disagree about
// what a "tier" is — see computeTiers' own comment for the separate,
// later fix to how the threshold itself is calculated (median gap, not
// value std dev).
//
// playersWithPAR: the full static pool (post-initDraftPricing). undraftedPlayers: computeUndraftedPool's output.
export function computeTierInfo({ activePlayerWithPAR, playersWithPAR, undraftedPlayers }) {
  if (!activePlayerWithPAR) return null;
  const position = activePlayerWithPAR.position;
  const positionPool = playersWithPAR.filter((p) => p.position === position && p.par > 0);
  const tierById = new Map(computeTiers(positionPool).map((t) => [t.id, t.tier]));
  const activeTier = tierById.get(activePlayerWithPAR.id) ?? null;

  const undraftedAtPosition = undraftedPlayers.filter((p) => p.position === position);
  const { stdDevs: dropoffStdDevs } = computeTierDropoff(undraftedAtPosition, positionStdDev(positionPool));

  // Static tier-cliff marker, per direct request — same "lowest-ranked
  // player before the tier changes" boundary the snake ranked list uses
  // (see background.js's lastInTierIds), computed from the same
  // value-sorted positionPool computeTiers already builds internally.
  // Previously this compared against how many of the tier were still
  // undrafted RIGHT NOW, which meant a tier with several genuine members
  // still on the board never showed the cliff at all, even sitting right
  // at its own visible boundary — not the "a drop is coming" signal this
  // is meant to be. Guarded on activeTier !== null: a below-replacement
  // player (par <= 0, excluded from positionPool entirely) has no real
  // tier to be "last in."
  const sortedPool = [...positionPool].sort((a, b) => b.par - a.par);
  const activeIdx = sortedPool.findIndex((p) => p.id === activePlayerWithPAR.id);
  const nextTier = activeIdx >= 0 && activeIdx + 1 < sortedPool.length ? tierById.get(sortedPool[activeIdx + 1].id) : undefined;
  const isLastInTier = activeTier !== null && activeIdx >= 0 && activeTier !== nextTier;

  return {
    tier: activeTier,
    tierCount: new Set(tierById.values()).size,
    remainingInTier: undraftedAtPosition.filter((p) => tierById.get(p.id) === activeTier).length,
    isLastInTier,
    dropoffStdDevs,
  };
}

// Snake draft's analog to computeRecommendation/recommendMaxBid. Snake has
// no dollar dimension at all — there's no bid to size, just a single pick to
// make on your turn — so instead of a max-bid number this returns a RANKED
// list: the best-PAR undrafted players among positions where you still have
// an open startable slot (same slot-gating myRosterState already provides
// for auction; format-agnostic, no change needed there — see the `price`
// tolerance added to computeMyRosterState above). Deliberately just a
// ranking by PAR, not a full optimal-roster-construction solve (same
// "explicitly out of scope for v1" reasoning as the FLEX shared-pool
// simplification above) — picking WHICH of several open-slot positions to
// prioritize when several are viable is a judgment call left to the user,
// same spirit as SPEC.md's tier-dropoff signal informing rather than
// deciding auction bids.
//
// undraftedPlayers: PAR-augmented players still on the board (computeUndraftedPool's output).
export function recommendBestAvailable({ undraftedPlayers, myRosterState, count = 10 }) {
  return undraftedPlayers
    .filter((p) => (myRosterState.openStarterSlots[p.position] || 0) > 0)
    .slice()
    .sort((a, b) => b.par - a.par)
    .slice(0, count);
}

// Pure best-by-value ranking — the same undrafted pool as
// recommendBestAvailable above, but WITHOUT the open-slot filter. This is
// the "Best Available" side of the side panel's two-tab view (top players
// regardless of position, e.g. useful for best-player-available drafting or
// just seeing who's left); recommendBestAvailable itself is the "Best Fit"
// side (need-filtered). Deliberately a separate function rather than an
// option flag on recommendBestAvailable — different enough purpose (no
// roster awareness at all) that keeping them as two small, single-purpose
// functions reads clearer than one function branching on a boolean.
export function recommendTopAvailable({ undraftedPlayers, count = 10 }) {
  return undraftedPlayers
    .slice()
    .sort((a, b) => b.par - a.par)
    .slice(0, count);
}

// Headline "who do I pick" answer for the snake side panel — per direct
// request, most drafters just want the single decisive answer up front,
// not to synthesize it themselves from a 15-row list. Reads straight out
// of recommendBestAvailable's own output (real, PAR-sorted, need-filtered
// Best Fit list) rather than a new data source — top is rank #1;
// altSamePosition is the next-best player at the SAME position (a real
// alternate if you want to bank the same need at a slightly different
// price/tier); altNextPosition is the best player at the next DIFFERENT
// position in the list (a genuine second direction, not just runner-up).
// Both alternates degrade to null rather than guessing when the list is
// too short or too position-concentrated to have one — an honest "no
// alternate" beats a misleading one.
export function pickHeadlineRecommendation(recommendationList) {
  const top = recommendationList[0] || null;
  if (!top) return { top: null, altSamePosition: null, altNextPosition: null };
  const altSamePosition = recommendationList.slice(1).find((p) => p.position === top.position) || null;
  const altNextPosition = recommendationList.find((p) => p.position !== top.position) || null;
  return { top, altSamePosition, altNextPosition };
}

// Snake-draft "positional run" signal — a little fire icon next to a
// position in the ranked list when the room is visibly hunting that
// position right now. Grounded in real research, not invented from
// scratch (see README's Draft runs section): there's no single
// industry-standard numeric threshold — the most rigorous public analysis
// found (the Fantasy Footballers' own pick-by-pick study across real
// drafts) defines a run as simply "same position picked consecutively,"
// with no stated minimum length, studying real runs from 2 up to 14 picks
// — but community strategy consensus treats 3+ concentrated same-position
// picks as the point a run becomes something a drafter actually reacts to.
// Implemented as a sliding window (3 of the last 5 picks LEAGUE-WIDE, not
// just the user's own), not strict "3 in a row": a single off-position
// pick shouldn't erase an otherwise-hot stretch, while requiring 3-of-5
// (not, say, 3-of-10) keeps this from false-flagging ordinary position
// mixing. Confirmed with the user directly.
//
// recentPositions: position strings in real pick order (oldest first),
// e.g. the last few state.soldEvents resolved to a position each — this
// function itself is DOM/state-agnostic, just position-counting, so it's
// unit-testable without any of background.js's identity-resolution
// plumbing.
export function computeActiveRunPosition(recentPositions, { windowSize = 5, threshold = 3 } = {}) {
  const recent = recentPositions.slice(-windowSize);
  const counts = new Map();
  for (const position of recent) {
    if (!position) continue;
    counts.set(position, (counts.get(position) || 0) + 1);
  }
  for (const [position, count] of counts) {
    if (count >= threshold) return position;
  }
  return null;
}

// How many CURRENTLY UNDRAFTED players remain in each (position, tier)
// bucket — live, and shrinking as the draft happens, unlike tierById
// itself (computed once over the full static pool — see background.js's
// ensurePricing). Feeds the snake ranked list's tier-cliff underline: a
// player is the last real option left in their tier when this count is 1
// for their own (position, tier) bucket — the moment the NEXT pick at that
// position empties the tier out. Keyed on the same tierById the ranked
// list already displays a tier number from, so the two signals can never
// disagree with each other.
export function computeTierRemainingCounts(undraftedPlayers, tierById) {
  const counts = new Map();
  for (const p of undraftedPlayers) {
    const tier = tierById.get(p.id);
    if (tier === undefined) continue;
    const key = `${p.position}|${tier}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Tier-cliff underline: the lowest-ranked (by PAR, within its own position)
// player in each tier bucket — a plain, static boundary check, not a
// countdown. Per direct request: tiers are a fixed value-based grouping, so
// which player sits at the bottom of one is a fixed fact too, independent
// of who's actually been drafted — background.js's ensurePricing calls this
// ONCE, over the full static pool (playersWithPAR, NOT undraftedPlayers),
// right alongside the tier numbers themselves, never recomputed as the
// draft happens (same discipline PAR and tierById already follow).
export function computeLastInTierIds(allPlayers, tierById) {
  const byPosition = new Map();
  for (const p of allPlayers) {
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  const lastInTierIds = new Set();
  for (const pool of byPosition.values()) {
    const sorted = [...pool].sort((a, b) => b.par - a.par);
    for (let i = 0; i < sorted.length; i++) {
      const tier = tierById.get(sorted[i].id);
      if (tier === undefined) continue;
      const nextTier = i + 1 < sorted.length ? tierById.get(sorted[i + 1].id) : undefined;
      if (tier !== nextTier) lastInTierIds.add(sorted[i].id);
    }
  }
  return lastInTierIds;
}

// "Draft Rank" tab: every team's cumulative PAR so far, real-time, ranked
// best to worst — the same underlying value (PAR) already driving every
// other recommendation in this file, just summed per team instead of
// evaluated per player. Pure position-agnostic summation, no DOM/state
// coupling — same split as computeActiveRunPosition above: background.js
// resolves each soldEvent to a {teamId, par} pair (via its own
// playerIdentity -> parById chain) and passes that in here.
//
// salesWithPAR: [{ teamId, par }] — one entry per completed pick,
// league-wide (not just the user's own).
export function computeTeamRanking(salesWithPAR) {
  const totals = new Map();
  for (const sale of salesWithPAR) {
    if (sale == null || sale.teamId === null || sale.teamId === undefined || !Number.isFinite(sale.par)) continue;
    totals.set(sale.teamId, (totals.get(sale.teamId) || 0) + sale.par);
  }
  return Array.from(totals.entries())
    .map(([teamId, totalPAR]) => ({ teamId, totalPAR }))
    .sort((a, b) => b.totalPAR - a.totalPAR);
}

// "Starters Only" variant of the Draft Rank tab, per the user's own
// request: sums only the subset of each team's picks that would fill
// their actual starting lineup (by position, plus a shared FLEX pool),
// not every pick they've made — a bench-heavy team's "Full Team" total
// can look inflated purely from roster depth, not real starting strength.
// Same "best pick per slot; FLEX takes the best of what's left over"
// assignment computeMyRosterState's own flex handling already uses for
// the CURRENT user's own open-slot count — applied here per OTHER team
// too. A real, acknowledged v1 simplification (see computeMyRosterState's
// own comment): which specific picks fill FLEX vs. bench isn't a true
// assignment-optimization solve here, just "best PAR first."
//
// salesWithPAR: [{ teamId, position, par }] — one entry per completed
// pick, league-wide. Same rosterSlots for every team (a single league's
// real roster construction is shared across all its teams).
export function computeStarterOnlyRanking(salesWithPAR, { rosterSlots, flexEligible = DEFAULT_FLEX_ELIGIBLE }) {
  const byTeam = new Map();
  for (const sale of salesWithPAR) {
    if (sale == null || sale.teamId === null || sale.teamId === undefined || !Number.isFinite(sale.par) || !sale.position) continue;
    if (!byTeam.has(sale.teamId)) byTeam.set(sale.teamId, []);
    byTeam.get(sale.teamId).push(sale);
  }

  const result = [];
  for (const [teamId, picks] of byTeam) {
    const byPosition = new Map();
    for (const p of picks) {
      if (!byPosition.has(p.position)) byPosition.set(p.position, []);
      byPosition.get(p.position).push(p);
    }
    let totalPAR = 0;
    const leftover = [];
    for (const [position, list] of byPosition) {
      const sorted = [...list].sort((a, b) => b.par - a.par);
      const slots = rosterSlots[position] || 0;
      totalPAR += sorted.slice(0, slots).reduce((s, p) => s + p.par, 0);
      if (flexEligible.includes(position)) leftover.push(...sorted.slice(slots));
    }
    const flexSlots = rosterSlots.FLEX || 0;
    totalPAR += leftover
      .sort((a, b) => b.par - a.par)
      .slice(0, flexSlots)
      .reduce((s, p) => s + p.par, 0);
    result.push({ teamId, totalPAR });
  }
  return result.sort((a, b) => b.totalPAR - a.totalPAR);
}
