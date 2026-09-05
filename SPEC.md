# Scoring engine spec

## Objective

Maximize the projected points of your best possible **starting** lineup — not
total points of everyone drafted. PAR beyond your startable slots at a
position is bench insurance, worth much less, and out of scope for v1. This
makes the problem a constrained allocation: fill N roster slots within a pick
budget (snake) or a dollar budget (auction), competing against other teams for
the same scarce supply.

## Layer 1 — Adjusted projection (external input, not this engine's job)

```
adjustedPoints(p) = basePoints(p)
                   × (1 + errorAdjustment(pos))
                   × (1 - injuryDiscount(p))
                   × (1 + matchupAdjustment(p))
```

- `basePoints`: FantasyPros consensus, converted to this league's scoring
  settings.
- `errorAdjustment(pos)`: historical bias correction per position, from 2
  seasons of actual-vs-projected.
- `injuryDiscount(p)`: applied only if flagged injury-risk (hurt in 2 of last
  3 seasons, or one injury with 3+ month recovery).
- `matchupAdjustment(p)`: schedule-strength delta, playoff weeks weighted
  higher.

This is where the "probability distribution per player" idea from the Reddit
thread lives — an expected value under a mixture of outcomes is still a
single number by the time it reaches the engine, so it doesn't change
anything below. Calibrating the three adjustment factors is a separate
offline data-analysis task (scrape FantasyPros + 2 seasons of actuals); the
engine just consumes `adjustedPoints` as input.

## Layer 2 — Scarcity value (derived, deterministic, this engine)

```
effectiveStarterSlots(pos) = rosterSlots[pos] + flexSlots × flexShare[pos]   (flex-eligible positions only)

replacementRank(pos)    = numTeams × effectiveStarterSlots(pos) + 1
replacementPoints(pos)  = adjustedPoints of the player at replacementRank(pos)
                           — computed ONCE from the full pre-draft pool (static)

PAR(p)      = adjustedPoints(p) − replacementPoints(pos(p))                 — static
Value(p, t) = PAR(p) / Σ PAR(p′) for undrafted p′ at pos(p)                 — dynamic, recomputed every pick

Tiers(pos): sequential clustering — start a new tier when the gap to the
next-best player exceeds `tierGapStdDevs` standard deviations of that
position's PAR spread.

TierDropoff(pos, t) = PAR(best remaining) − PAR(2nd best remaining), in std
devs of the position's PAR spread                                          — dynamic
```

PAR is a static baseline — it does not get recomputed as players are drafted.
Only Value and TierDropoff are live; they're what capture "should I take this
now or can it wait."

## Layer 3 — Auction pricing (auction mode)

Static baseline, once pre-draft:

```
totalBudgetPool      = numTeams × budgetPerTeam
reservedDollars       = numTeams × (totalRosterSlots − totalStarterSlots) × $1
totalStarterPARPool   = Σ PAR(p) across only the players who will actually
                          start league-wide (top numTeams×effectiveStarterSlots(pos)
                          at each position)
dollarPerPAR          = (totalBudgetPool − reservedDollars) / totalStarterPARPool
fairPrice(p)          = max($1, PAR(p) × dollarPerPAR)
```

Live, recomputed after every pick, **per position** (not one global rate —
this is what lets a run on RBs actually show up as RBs getting more
expensive, independent of other positions):

```
liveDollarPerPAR(pos, t) = blend(dollarPerPAR, observedRate(pos, t), weight)
observedRate(pos, t)     = Σ prices paid at pos so far / Σ PAR consumed at pos so far
weight                   = min(1, picksAtPos / blendPicks)
```

This is the "personality of the draft" signal: if this room is overpaying for
RBs, `liveDollarPerPAR(RB)` rises above the static baseline for everyone still
watching that position — a static pre-draft spreadsheet can't do this because
it doesn't see the other 9 teams' live spending. This is the actual payoff of
the capture layer: it sees every team's picks and prices, not just yours.

Bid recommendation at any nomination/bid moment:

```
recommendMaxBid(p) = 0                                    if no open startable slot at pos(p)
                    = min(myRemainingBudget − $1×otherOpenSlots,
                          PAR(p) × liveDollarPerPAR(pos(p), t))   otherwise
```

## Explicitly deferred

- Predicting other teams' *next* moves ("Draft Dynamics") — deferred per
  earlier discussion. `observedRate` above is descriptive (what has this room
  already paid), not predictive.
- Nomination strategy (baiting runs, draining a rival's budget on a position
  they don't need).
- Bench-player valuation — v1 only scores startable-slot value.

## Open calibration decisions, defaulted here

1. **Flex share split**: RB 0.5 / WR 0.4 / TE 0.1 of each flex slot, when
   computing `effectiveStarterSlots`.
2. **Tier gap threshold**: 0.75 standard deviations.
3. **Live-pricing blend-in speed**: `blendPicks = 3` — i.e., a position's live
   rate is fully "trusted" (not the static baseline) after 3 picks at that
   position.

Change any of these in `engine/scoring.js` if they don't match how you'd
actually calibrate them.
