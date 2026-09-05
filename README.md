# Fantasy Draft Assistant

Live drafting adviser for ESPN and Yahoo fantasy football. Chrome extension, not a
standalone app — the whole architecture exists because the only way to see a live
draft room is to be logged in as the user, and running a second automated session
just logs the real one out. An extension sidesteps that entirely: it runs inside
the browser tab the user is already authenticated in, reading data the site already
sent to that tab rather than making independent authenticated calls of its own.

## What we confirmed before writing any code

Watched real mock drafts on both platforms (salary-cap/auction, since that's the
target mode) with network + WebSocket instrumentation running:

- **Neither platform's public API exposes live draft events.** ESPN's unofficial
  API and Yahoo's official OAuth API both cover league settings and *completed*
  draft results — nothing for in-progress picks.
- **Neither live draft room uses plain HTTP polling.** Watched picks happen on
  both ESPN's `fantasy.espn.com/football/draft` and Yahoo's
  `football.fantasysports.yahoo.com/draftclient/*` and captured zero XHR/fetch
  calls carrying the pick data — just image loads and analytics beacons. (Yahoo's
  *pre-draft waiting room* does poll a `mock_waiting_ajax` endpoint every ~3s, but
  that's only for the lobby countdown/roster list, not the live pick feed.)
- Conclusion: both platforms push live draft state over some persistent
  connection (WebSocket being the most likely candidate for a real-time
  multi-drafter app), which only a script running in the page's own JS context,
  installed *before* the page's scripts run, can observe.

## Capture architecture

- `extension/src/capture-main.js` — runs in the page's own JS context
  (`"world": "MAIN"`) at `document_start`, before ESPN/Yahoo's own app code runs.
  Patches `WebSocket`, `fetch`, `XMLHttpRequest`, and `EventSource` and reports
  every open/message it sees via `window.postMessage`. We don't yet know which of
  these transports either platform actually uses for the live feed, so this
  instruments all of them rather than guessing.
- `extension/src/relay-isolated.js` — ordinary (isolated-world) content script.
  Can't see the page's real WebSocket, but can reach `chrome.runtime` — its only
  job is forwarding what `capture-main.js` posts into the extension.
- `extension/src/background.js` — service worker. Parses every `ws-message`
  via the real engine parsers, feeds `sold` events into the identity
  resolver, keeps a rolling in-memory buffer of enriched events, and fans
  them out to the side panel. See "Identity resolution" below for how this
  connects to the DOM readers.
- `extension/src/dom/espn.js` / `dom/yahoo.js` — DOM readers for team
  names/budgets, invoked by `relay-isolated.js`. See "Identity resolution"
  below.
- `extension/src/sidepanel.html` / `sidepanel.js` — live feed of parsed
  draft events with resolved team names where available. Still a debug view,
  not the end-user recommendation UI.

## Scoring engine

`extension/engine/scoring.js` — the deterministic recommendation math, worked out in
[SPEC.md](./SPEC.md). Pure functions, no `chrome.*`/network/DOM dependencies,
so it's usable both inside the extension later and testable standalone:

```
npm test
```

Not wired into the extension yet — it takes `adjustedPoints` per player as
input (FantasyPros projections + error/injury/matchup adjustments), which
requires an offline data pipeline that doesn't exist yet, and it needs the
real ESPN/Yahoo live-draft message shapes (see below) before it can consume
actual picks rather than test fixtures.

## ESPN wire format (confirmed live)

Loaded the extension unpacked and watched a real ESPN mock auction. It's not
JSON — a compact space-delimited text protocol over the WebSocket, six
message types, all decoded and parsed in `extension/engine/parsers/espn.js`:

```
BID <teamId> <playerId> <amount> <?> <?>
CLOCK <phase> <msRemaining> [<teamId> [<playerId> <currentBid>]]   — phase 1 = nomination countdown, 2 = bid countdown, 3 = unconfirmed
NOMINATION <teamId> <msRemaining>
SOLD <winningTeamId> <playerId> <nominatingTeamId> <price> <?>
AUTOSUGGEST <playerId>
PONG PING%20<timestamp>                                            — heartbeat
```

Validated against all 795 messages from that draft (not just the samples in
the test file): 0 parse errors, 0 unrecognized types, 0 NaN fields.

Team/player identity resolution doesn't need its own wire message — see
"Identity resolution" below for how team names get resolved from the DOM
instead, now wired all the way into the extension.

## Yahoo wire format (confirmed live)

Same live-capture pass, but for Yahoo's `draftclient` app — confirms it really
is WebSocket-based (we'd only ruled out polling before). Pipe-delimited, not
space-delimited like ESPN, and notably not JSON either except one message
type. Decoded and parsed in `extension/engine/parsers/yahoo.js`:

```
D|<pickNumber>|<teamId>|<clockSeconds>              — announces whose turn to nominate
n|<teamId>|<playerId>|<startingBid>|<clockSeconds>  — nomination made, starts the bid clock
b|<teamId>|<playerId>|<amount>|<clockSeconds>       — a competing bid
C|<secondsRemaining>                                 — generic countdown tick
0|<pickNumber>|<playerId>|<teamId>|<position>|<price> — sale confirmed
G|<json>                                              — Yahoo's own pick-quality grade (see below)
```

Validated against all 100 messages captured: 0 parse errors, 0 NaN fields.
`L`, `J`, `5`, `6` showed up rarely with single numeric payloads and aren't
obviously draft mechanics — parsed as `unknown` rather than guessed at (6 of
the 100 messages). `b` (competing bid) is understood from a single real
example, since this draft's budgets were mostly exhausted by the time capture
ran — worth re-verifying against a draft with more active bidding.

**Notable find**: the `G` message means Yahoo already computes its own
per-pick value grade — a score, a letter grade, and a component breakdown
(`ADP Value`, `VOLS Value` — value-over-something, similar in spirit to our
own PAR, `Availability` — an opportunity-cost penalty for passing over
better-ranked players, `Early Round Bonus`, `Market Mispricing`).

**Decided**: surface it, don't consume it. `sidepanel.js` now renders `G`
events as a distinctly-styled "Yahoo's own grade (reference only)" line,
never blended into `computeRecommendation` — our PAR-based approach stays the
one actual source of the bid recommendation, per the "maximize
starting-lineup PAR" discussion. The real field shape is now confirmed live
(previously only described conceptually) — see `yahoo.js`'s file-header
comment for a real captured sample. The render shows the letter grade, score,
and component breakdown nicely when the payload matches that confirmed
shape, with a raw-JSON fallback for anything that doesn't (a parse failure,
or Yahoo changing the shape later) — verified against both the real captured
payload and the fallback case via a mocked script.

## Identity resolution (confirmed live, on both platforms, and now wired in)

`extension/src/dom/espn.js` / `dom/yahoo.js` — DOM readers, selectors found
and validated against real draft rooms: ESPN's `li.picklist--pick` /
`.team-name` / `.cash`, Yahoo's `tr.ys-team` (cell 1 = name, cell 2 =
budget). ESPN's own-team row also carries an `auction-pick-component--own`
class, confirmed live to be unique regardless of who's nominating/autopicking
— paired with the URL's teamId, "which team is me" never needs DOM/ledger
inference on either platform (Yahoo's own team just shows as the literal
string `"You"`).

Running the actual `resolveTeamIds` engine function against a real live
8-team ESPN draft surfaced a real gap: capture had started mid-draft, so the
spend ledger understated some teams' true total spend, and the exact
budget-match pass failed for the one team it should have resolved (a
custom-named team whose displayed budget didn't equal `startingBudget -`
anything in the ledger). Fixed with an elimination pass — once every ID but
one is claimed and every name but one is resolved, the last pairing isn't
ambiguous even if the numbers don't line up exactly.
`extension/engine/parsers/identity.js` now includes that pass, tested
against the exact real numbers from that draft. Confirmed the same engine
functions work unmodified against Yahoo's `sold` events too.

**Now wired end to end.** `extension/engine/` moved inside `extension/` (Chrome
extensions can't reference files outside their own unpacked folder — this
project used to have `engine/` as a sibling of `extension/`, which worked for
`npm test` but couldn't work once the extension needed to import it).
`background.js` is now a `"type": "module"` service worker that imports the
real, `npm test`-covered parser/identity code directly — no duplicated copy.
`relay-isolated.js` reads DOM team snapshots every 4s and forwards them
alongside the WS capture; `background.js` parses every `ws-message`, feeds
`sold` events into the spend ledger, re-resolves identities, and broadcasts
enriched `{parsed, teamName}` events instead of raw wire text. Side panel
updated to render that — team names where resolved, honest
`"Team N (unresolved)"` where not, instead of raw protocol strings. Verified
standalone (mocked `chrome.runtime`, fed it realistic parsed events from both
platforms) but **not yet reloaded against a real live draft** — that's the
next concrete step, since it needs the extension reloaded in Chrome.

**Fixed**: `background.js` infers the auction's starting budget from a
snapshot taken before any sale (every team's displayed budget at that point
IS the starting budget). It used to fall back to a hardcoded `$200` guess if
capture only ever started mid-draft — silently wrong for any league with a
different budget, and it quietly corrupted both team identity resolution and
every dollar figure downstream. Now it stays genuinely unknown in that case
(pricing/identity that depend on it simply don't start) and the side panel
shows a one-time prompt asking the user for the real value; `set-starting-budget`
over the existing sidepanel port unblocks it immediately. Verified via a
mocked integration script covering both the mid-draft-start case (confirms
exactly one prompt, no wrong guess) and the manual-entry path (confirms
pricing resolves correctly afterward).

## Layer 1 projections (real data, real pipeline, verified end to end)

`data/fantasypros/2026/{qb,rb,wr,te,k,dst}.csv` — real 2026 season-long
("week=draft") consensus projections, downloaded directly from FantasyPros
via its "Download data" export while logged into a free account. The
anonymous/logged-out view caps every position at 10 players regardless of
subscription tier — nowhere near enough depth for replacement-level math on
RB/WR (need 30-40+ ranked players per position); a free login unlocked full
depth (131 RBs, 190 WRs, etc.) with no paid tier required.

`extension/engine/projections/`:
- `parseCsv.js` — small RFC-4180-ish CSV parser (quoted fields, escaped
  quotes, commas inside quotes).
- `fantasyProsLoader.js` — per-position column maps. Several positions reuse
  column names for two different stat groups (RB's rushing YDS vs receiving
  YDS both literally called "YDS") — parsed positionally, not by header name,
  specifically to avoid that collision silently overwriting data.
- `leagueScoring.js` — converts raw stats into league-specific fantasy
  points, independent of FantasyPros' own FPTS column (which reflects their
  scoring assumptions, not the real league's — recomputing from raw stats is
  the actual point of pulling them instead of just the final number).
  Caught and fixed a real bug here before it ever ran against real data:
  DST's "points allowed" column is a **season total**, but points-allowed
  scoring tiers are inherently per-game — comparing the season sum directly
  against single-game tiers would have flattened every DST projection to the
  worst tier. Fixed by averaging per game (÷17) before the tier lookup, then
  scaling back up.

`scripts/build-projections.js` — build-time script (Node `fs`, not extension
runtime code) that reads the CSVs, converts every player, and writes
`extension/engine/data/players-2026.json` (592 players across all six
positions). Re-run whenever the source CSVs are refreshed or scoring rules
change.

**Ran the full pipeline against this real data** (`computeReplacementLevels`
→ `computePAR` → `computeAuctionBaseline` → `fairPrice`, 10-team/$200
league config) and the output is genuinely sensible: Jahmyr Gibbs and Bijan
Robinson top the board at ~$96-99 fair value, matching what they actually
sold for in tonight's live ESPN draft, and RBs dominate the top of the list —
exactly what real VBD theory predicts from positional scarcity. This isn't
just wiring proven against test fixtures anymore; it's real projections
producing real, usable auction values.

Two honest gaps remained before this connected to the live draft pipeline —
player identity (below) is now closed; the error-correction half isn't:
- **Layer 1's error-correction half isn't built.** `adjustedPoints` is
  currently just the raw consensus-derived value — no historical
  actual-vs-projected bias correction, no injury-risk discount, no matchup
  adjustment, per SPEC.md's Layer 1. The engine and pipeline are ready for
  it; the calibration data (2 seasons of actuals) isn't pulled yet.
- ~~League config (10-team/$200/standard flex) and scoring rules
  (`DEFAULT_SCORING_RULES`, half-PPR) used above are representative
  defaults, not necessarily this project's actual home league's real
  settings — both are parameters, easy to override once known.~~ **Resolved
  below** — scoring rules are now the real league's, roster/budget config is
  now user-set live (see "Roster settings" section further down).

## League settings — scoring rules, roster slots, and starter/bench % (the "LeagueInfo" ask)

The user asked for something mirroring elboberto's spreadsheets' `LeagueInfo`
tab — roster info, scoring info, starter-vs-bench %. Roster slots and the
starter/bench budget split were already covered (side panel, live,
`chrome.storage.local`). Scoring rules were the missing piece.

**First pass got the mechanism wrong.** Scoring rules determine every
player's precomputed `adjustedPoints` in `players-2026.json`, built OFFLINE
by `scripts/build-projections.js` — so the first version of this made
`data/league-config.json` an editable file the user would hand-edit and
rerun a Node build script against. The user immediately caught the real
problem with that: **league settings are different for every user** —
elboberto's numbers work for the user's own league, but anyone else using
this needs their own real settings, entered somewhere, not hardcoded from
someone else's spreadsheet and not requiring them to edit JSON and run a
build script (not usable by a non-developer).

**Fixed properly**: scoring is now a live, in-extension setting too, same
mechanism as roster slots. `players-2026.json` now carries each player's raw
per-category stat fields (`passYds`, `rushYds`, `rec`, etc. — not just the
precomputed points) plus their `errorAdjustment`/`injuryDiscount` ratios
separately from `adjustedPoints`. `recomputeWithScoringRules`
(`liveDraftState.js`) recomputes `basePoints` from those raw fields under any
rules object, then reapplies the existing bias/injury ratios on top (those
are facts about historical projection error, independent of which scoring
rules convert stats to points — no need to redo that calibration). The side
panel has a "Scoring settings" form (17 fields — pass/rush/rec yards-per-point,
TD values, INT/fumble penalties, kicking, defense — matching elboberto's
yellow-highlighted, i.e. genuinely-user-input, `LeagueInfo` cells, confirmed
by checking real cell fill colors) seeded from `DEFAULT_SCORING_RULES`,
saved to `chrome.storage.local`, picked up live by `background.js` via the
same `chrome.storage.onChanged` mechanism, which recomputes `players` and
forces PAR to recompute. `data/league-config.json` still exists as the
build-time seed for `DEFAULT_SCORING_RULES` itself (what ships before any
user customization) — not the mechanism a general user interacts with.
`pointsAllowedTiers`/`gamesPerSeason` remain fixed defaults, not in the form
(a nested tier array doesn't fit a simple settings grid, and games-per-season
is essentially always 17) — documented, not silently unavailable.

**A real bug surfaced while wiring this, caught by the integration test, not
by inspection**: the event feed's displayed "proj Npts" was reading straight
off `state.playerIdentity[playerId]`'s own cached `.adjustedPoints` —
correct at first-match time, but that cache is deliberately never
re-matched afterward, so it went stale after any later live scoring-rules or
roster-slot change. The $ recommendation itself was already safe (it reads
through `state.parById`, rebuilt fresh on every `ensurePricing()` call) —
only the displayed points figure was wrong. Fixed by always looking up the
current player fresh by id (`playersById`, kept in sync with `players`)
instead of trusting the cached identity object's own mutable fields.
Live-verified: same player (Jahmyr Gibbs), `projectedPoints` correctly moved
`224.6 → 258` after a live full-PPR edit, where it previously stayed frozen
at `224.6`.

**Also, a real bug found along the way while first building the (superseded)
build-time version**: extracted the actual `LeagueInfo` tab from all three of
the user's elboberto spreadsheets (2022, 2024, 2025) and compared its real
scoring rules against `DEFAULT_SCORING_RULES`. `passYardsPerPoint` (25),
`interception` (-2), `receptionPoints` (0.5, half-PPR), and `fumbleLost` (-2)
all already matched. `rushYardsPerPoint` and `recYardsPerPoint` did NOT —
this file had both at 10 (0.1 pts/yd), but the real league scores yardage at
20 (0.05 pts/yd), stable and identical across 2024 and 2025 (his two most
recent seasons; 2022 was close but not identical — e.g. interception was -1
that year — so the more recent two years were treated as the current, stable
convention rather than splitting the difference). Fixed in
`leagueScoring.js`'s defaults; regenerated `players-2026.json` — e.g. Jahmyr
Gibbs' `basePoints` dropped from `337.1` to `238.9`, a real, material
correction that was silently overvaluing high-yardage players in every
recommendation up to this point. `leagueScoring.test.js`'s hand-computed
expected values updated to match; one test's framing changed too — Puka
Nacua used to land suspiciously close to FantasyPros' own half-PPR FPTS (a
coincidence from both happening to use 0.1 pts/yd), and now correctly
doesn't, since the whole point of this module is computing OUR real league's
scoring independent of FantasyPros' assumptions. K/DST scoring rules had no
corresponding data in `LeagueInfo` to check against, so those remain the
original baseline assumptions — not yet confirmed against a real source,
unlike QB/RB/WR/TE's yardage/TD/turnover rules now, but still fully
user-editable via the same live form.

## Player identity join (confirmed live, now wired in)

The gap above: `players-2026.json` keys players by name+team; the live
capture layer only ever sees ESPN/Yahoo's own numeric IDs (`4429795`,
`40075`) — neither wire protocol states a player's name anywhere. Closed
without needing any new capture message, same philosophy as team identity:
the DOM already shows whichever player is currently up for bid, so reading
that at the moment a WS event fires pairs a numeric ID with a name for free.

Confirmed on two real, independent signals, live: (1) correlating the WS
event's playerId against the name shown in the bidding panel at that same
moment, and (2) independently cross-checking that the same numeric ID
appears in that panel's own headshot image URL. Both agreed, on real
players, on both platforms (`5083076` → Harold Fannin Jr. on ESPN; `40881` →
"D. Maye" → Drake Maye on Yahoo).

- `extension/src/dom/espn.js` `readEspnActivePlayer()` — `.player-selected
  .playerinfo__playername/__playerteam/__playerpos`, ESPN's semantic class
  names made this straightforward.
- `extension/src/dom/yahoo.js` `readYahooActivePlayer()` — Yahoo has no
  semantic classes (build-hashed atomic CSS, e.g. `_ys_1o5vjbq`), so this
  finds the bidding panel structurally via its "Offer $N" button (stable
  text) and reads leaf text nodes positionally: name, position, team, in
  that confirmed order.
- `relay-isolated.js` reads the active player fresh on every `ws-message`
  forward — same synchronous tick as the message dispatch, so there's no
  round-trip race the way there was in ad-hoc manual testing (that instability
  was purely an artifact of separate tool calls having real latency between
  them; production code doesn't have that gap).
- `extension/engine/projections/matchPlayer.js` — matches the DOM read
  against `players-2026.json`. Needed because Yahoo abbreviates first names
  to an initial ("D. Maye" vs FantasyPros' "Drake Maye"), confirmed live —
  matches on last name + position first, using team as confirmation/tie-break
  rather than a hard filter (team abbreviations aren't guaranteed to agree
  across sources — JAX/JAC, WAS/WSH). Returns `null` rather than guessing
  when a match is genuinely ambiguous, same honesty as the team resolver.
- `background.js` builds a per-tab `playerIdentity` map from `bid` and
  `nomination` events (and ESPN's `clock` phase-2, which also carries the
  live bid) — deliberately **not** from `sold`, since the DOM panel may have
  already advanced to the next nominee by the time a sale is processed.
  Enriched events now carry `playerName` and `playerProjectedPoints`,
  rendered in the side panel the same way team names are — resolved name
  when available, an honest `"Player N (unresolved)"` when not.

Verified standalone at first (mocked messaging), then **confirmed live**:
reloaded the extension, watched real picks on both platforms, and saw actual
resolved names + real projected points in the side panel
(`Team 8 · Rico Dowdle · proj 163.8pts · $3`) — including the honest
partial-resolution case working exactly as designed (a team with no sales
yet correctly shows `Team ID 9 (unresolved)` while its player resolves fine).

## Recommendation engine (wired in, verified via integration test)

The last disconnected piece: `engine/liveDraftState.js` is new pure
orchestration logic — background.js can't be unit tested (tightly coupled to
`chrome.runtime`), so this stays separate and testable like everything else
in `engine/`. It ties the scoring engine to what a live draft actually gives
us: builds the live undrafted pool from resolved sales, tracks the user's own
roster fill (including a documented FLEX-overflow approximation — correctly
assigning which specific picks "use" the shared flex slot is a real
assignment-optimization problem, out of scope for v1), computes live
per-position $/PAR from the room's actual spending, and calls the engine's
`recommendMaxBid`. `background.js` now calls this on every `bid`/`nomination`
(and ESPN's `clock` phase-2) event and attaches the result; the side panel
shows it as a highlighted `→ recommended max $N` line, or an honest
`→ no open roster slot for this position` when the engine says pass.

Verified two ways: unit tests against synthetic leagues (`liveDraftState.test.js`),
and — since `background.js` itself can't be unit tested — a one-off Node
script that mocks just enough of `chrome.*` to run `background.js`'s actual
message handler against real `players-2026.json` data end to end. That
integration check caught a real bug before it ever reached a live draft:
**Bijan Robinson and Brian Robinson Jr. are both real ATL RBs** in the
dataset — same last name, same team, same first initial — so
`matchPlayer.js`'s Yahoo-oriented last-name fallback genuinely couldn't tell
them apart and correctly returned `null`. Fixed by trying an exact full-name
match first (ESPN always gives the full name, unlike Yahoo's abbreviated
form), falling back to the last-name heuristic only when no exact match
exists — which is exactly the situation that heuristic was built for.

## Nominee card (the primary view, replacing the scrolling log)

After the first successful live draft test, the user's own framing of what
was actually needed at the table: "the current player, and the key
information... not a constant scroll" — plus a way to see *why* the number
differs from what the platform itself shows, not just the number. Two real
features, built together since the second is the natural thing the card
expands into:

**The card itself** (`sidepanel.html`/`sidepanel.js`): one persistent card
per platform with an active nomination — player/team/position, our
projected points, current bid, and the recommended max — updated in place as
bid/clock events arrive, rather than a new line appended per event. Up to
two cards can show at once (matches the "watch an ESPN and a Yahoo draft
simultaneously" pattern already established for dev/testing); the old
scrolling feed still exists underneath, demoted to a collapsed "Activity
log" section for debugging, not removed. `background.js`'s
`buildNomineeSnapshot` rebuilds the whole card fresh from current state on
every relevant event (same anti-staleness discipline as `playersById`
elsewhere — never trust a cached snapshot), tracking a per-tab
`activePlayerId`/`activeTeamId`/`activePrice` bundle that's set on
nomination/bid and cleared together on sale, since none of ESPN's or
Yahoo's message types reliably carries all three on every tick.

**FantasyPros' own raw projection now shown alongside ours (2026-08-22)**,
after the user asked why our number differs from FFP's and whether that's
worth surfacing. It is real and worth showing: "our projection" isn't FFP's
number — it's their raw per-category stats reconverted through THIS league's
scoring rules (not FFP's own default assumptions), then run through the
errorAdjustment/injuryDiscount bias layers described below. Both differences
are legitimate, not bugs, so showing the two numbers side by side is
accurate and useful, kept visually separate from the $ recommendation.
Turned out to be a quick win, not new capture work: `fptsSource` (FFP's raw
FPTS column) was already captured per player in `players-2026.json` via
`fantasyProsLoader.js` — just never wired into the card. `buildNomineeSnapshot`
now also returns `theirProjectedPoints`, rendered as "(FantasyPros: N pts)"
next to "Our projection" when present.

**Still not included**: the platform's OWN displayed live projection
(ESPN/Yahoo may show a third, different number in the draft room, not
necessarily FFP's) — that's a genuinely separate thing from the FFP number
above, and still needs a new DOM read on both platforms before it can be
added, same discipline as everything else DOM-related in this project;
flagged as a fast-follow, not silently skipped.

**The "why this number" factors panel** — expandable inside each card,
addressing the real gap the user identified: a max-bid number alone doesn't
say *why* it differs from the platform's own valuation. Surfaces four real,
already-computed signals rather than icons standing in for numbers no one
can verify:
- **Position bias (historical, relative)** — the position's mean-centered
  `errorAdjustment` (e.g. RB running a bit more reliable than the field
  average, DST a bit less). See the "Layer 1 adjustments" section below for
  why this is real, applied to the actual number, and mean-centered rather
  than raw.
- **Injury risk** — flagged or not, and the real discount if so.
- **Market heat** — how the live blended $/PAR for this position compares to
  the static preseason baseline rate right now. **Flag only, not priced
  in** — see the decoupling decision below.
- **Scarcity** — is this the last real option before a cliff, or deep in a
  flat tier. This one needed new wiring: `computeTiers`/`computeTierDropoff`
  (`scoring.js`) already existed, fully tested, built for SPEC.md's
  tier-dropoff signal — but had no live consumer anywhere before this. New
  `computeTierInfo` (`liveDraftState.js`) wires them into the live path.
- **What's actually binding the number** — `recommendMaxBid` was already
  taking `Math.min(valueCap, budgetCap)` silently; added a `bindingConstraint`
  field so the UI can say "he's not worth more" vs. "you can't afford more" —
  a genuinely different conversation the two raw numbers didn't distinguish.

**Market heat decoupled from the priced recommendation (2026-08-22)**, after
the user asked a pointed design question post-live-test: *"if a position is
running hot, should the recommendation push higher?"* Decided: no — market
heat is shown as a flag, not blended into the number.
`computeLiveDollarPerPAR`'s blend still runs and still feeds
`liveRateVsBaselineRatio`, but `computeRecommendation` (`liveDraftState.js`)
now prices strictly off the static `auctionBaseline.dollarPerPAR`, never the
live per-position rate. Reasoning: a recommendation that moves with the
room's own behavior stops being an independent check against FOMO bidding
and starts joining the herd — and a flat blend of all sales-so-far can't
distinguish a genuine sustained repricing from an early run that cools off
once open slots fill up. Better to surface the number and let the user's own
judgment decide.

(A separate, short-lived decision to also exclude the historical
errorAdjustment bias from pricing — on the theory that it was Will-specific —
was reversed the same session once he pushed back that it's actually a real,
mostly-global FantasyPros bias, not a league-specific artifact. See "Layer 1
adjustments" below for where that landed.)

`matchupAdjustment` is left out of the panel entirely rather than shown as an
empty/zero row — it's still unimplemented (always neutral), and showing a
factor that isn't real would be worse than omitting it.

Verified with the same rigor as the rest of the project: `computeTierInfo`
and `recommendMaxBid`'s `bindingConstraint` are unit tested
(`liveDraftState.test.js`, `scoring.test.js`); the full nomination →
bid → clock-tick → sold lifecycle, on both ESPN's and Yahoo's real wire
shapes, and the card/factors rendering itself, are verified against the
real, unmodified `sidepanel.js`/`background.js` via mocked integration
scripts (same Node DOM/chrome-stub pattern used throughout, since neither
file can run inside the Node test suite directly). One real bug caught by
that verification before it ever shipped: `buildNomineeSnapshot` initially
sourced the active player from the wrong map (`playersById`, which holds
raw pre-PAR objects) instead of `state.parById` (the PAR-augmented one),
silently producing `NaN` → `null` for every `valueCap`/`maxBid` on the card.

## Layer 1 adjustments (errorAdjustment + injuryDiscount, both calibrated and applied)

`engine/projections/layer1Adjustments.js` implements SPEC.md's actual formula
— `adjustedPoints = basePoints × (1 + errorAdjustment) × (1 - injuryDiscount)
× (1 + matchupAdjustment)` — for real, tested.

**`errorAdjustment` is calibrated from real data and applied — but as a
mean-centered relative value, not the raw measurement (decided 2026-08-22,
after two rounds of real pushback).** Methodology:
`engine/projections/historicalErrorAdjustments.js` compares preseason
PROJECTED stats from three of the user's own elboberto draft-prep
spreadsheets against REAL season outcomes pulled from Pro Football
Reference, both converted through `leagueScoring.js`'s exact scoring
formula. elboberto's raw projections are themselves sourced from FantasyPros
(same `PASSING`/`RUSHING`/`RECEIVING` raw-stat shape pulled for 2026), so
this is a real measurement of FantasyPros' own historical projection error,
not an analogous proxy from a different source.

The process is now fully repeatable for future seasons, not a one-off: a
committed script, `scripts/analyze-historical-bias.js`, replaces what used to
be an ad hoc scratchpad script (which had already needed reconstruction once
this session — a real gap, since it's what actually produces the numbers
this whole calibration depends on). It uses the SAME `computeLeaguePoints`
the live pipeline uses (no duplicated formula to drift out of sync), and
auto-discovers which years have both a projections directory and
actual-stats files — adding next year's data is just dropping the files into
`data/historical-projections/<year>/` and `data/actual-stats/<year>*.csv`,
then rerunning `node scripts/analyze-historical-bias.js`, no code edits
required. Full per-player detail lives in
`data/historical-projections/bias-analysis.json`, regenerated by that script.

**2023 backfilled, 2026-08-22 — closes a gap previously documented as
permanently blocked.** `historicalErrorAdjustments.js` used to say 2023
couldn't be added without a new data source, specifically elboberto's own
2023 projections spreadsheet — Will provided it
(`2023_FantasyFootball_1.03_elboberto.xlsm`). Added
`scripts/import-elboberto-projections.py` (Python/openpyxl, since reading
`.xlsm` isn't worth a new Node dependency for a step run once a year) to
convert elboberto's `*_Raw` sheets into the same
`data/historical-projections/<year>/*.json` shape as the existing years —
confirmed the 2023 file's raw-sheet columns match every other year
field-for-field before trusting the conversion. `analyze-historical-bias.js`
picked it up automatically (no code changes) once both the projections
directory and `data/actual-stats/2023.csv` existed. Now 4 years
(2022/2023/2024/2025), not the 5 Will initially guessed — worth being
precise about, since the count only grows one year at a time as more
elboberto spreadsheets surface, not automatically to match however many
actual-stats years exist:

| Position | raw mean error | n | mean-centered (applied) |
|---|---|---|---|
| QB | −9.9% | 136 | −1.4% |
| RB | −4.3% | 275 | +4.2% |
| WR | −10.5% | 445 | −2.0% |
| TE | −1.9% | 218 | +6.6% |
| K | −9.4% | 124 | −0.9% |
| DST | −15.2% | 128 | −6.7% |

(These supersede the 3-year, 2022/2024/2025 numbers quoted earlier this
session — QB −12.7%/RB −10.8%/WR −16.9%/TE −9.3%/K −12.0%/DST −19.2% raw —
which themselves superseded an even earlier, since-discarded ad hoc script's
numbers. Each revision is a real recalibration on more/better data, not
noise — rerunning `analyze-historical-bias.js` after adding 2023 is the
whole point of having a committed, repeatable process instead of a one-off
number.)

Two real design decisions shaped what actually gets applied, both from the
user pushing back rather than accepting the first framing:
1. *"Is this really specific to my league, or a real global bias?"* — raised
   after an earlier pass (below, "Market heat decoupled") had wrongly
   excluded `errorAdjustment` entirely on the theory that it was
   Will-specific. Correct framing: the underlying projected-vs-actual data
   is universal FantasyPros data, not tied to any league; only the *scoring
   conversion* uses this league's rules, and only the *sample* (elboberto's
   saved spreadsheets) is something only Will currently has. The bias
   pattern itself (preseason optimism, worse for WR/DST/K) is real and
   applies broadly — so it's back in the pipeline, applied to every player,
   not just documented in a side report.
2. *"If every position is negative, doesn't that just push everyone not to
   bid?"* — real, but the risk isn't what it looks like.
   `computeAuctionBaseline`'s `dollarPerPAR` is `budget ÷ total starter PAR
   pool`, so a bias applied EQUALLY to every position shrinks the PAR pool
   and inflates `dollarPerPAR` by the same factor — they cancel exactly, and
   every `$` recommendation comes out identical to not applying it at all
   (proven in `scoring.test.js`'s "self-normalization" test, not just
   asserted). Only the *spread* between positions' bias rates ever moves
   money. So the six raw (all-negative) values are mean-centered — each
   position's bias minus the average bias across positions — via
   `centerBiasSummary` (`historicalErrorAdjustments.js`, unit tested). Same
   relative story and identical `$` output as the raw numbers, but
   `adjustedPoints` stays legible instead of looking uniformly marked down
   against every other projection source (Jahmyr Gibbs: `238.9` base →
   `249.0` adjusted, since RB's centered bias is +4.2%).

`injuryDiscount` is calibrated AND applied: `engine/projections/injuryAdjustments.js`
holds real per-player values built from actual games-played history
(`data/injury-history/injury-discounts.json`) across 2023/2024/2025. Matches
SPEC.md's stated test: flagged if the player proved a real full-time role
(≥14 games in some season) and either had 2+ seasons with ≤13 games, or one
season with ≤9 games (the "one injury with 3+ month recovery" case).
Discount = average fraction of games missed across available seasons, scaled
so the single worst flagged player lands at exactly 25% and every other
flagged player is scaled by that same factor — a curve, not a hard clip.
(An earlier version clipped each player's raw average directly at 25%; since
one bad season alone often pushes a raw average that high, 51 of the 78
flagged players collapsed to the identical clipped number. Scaling off the
real observed maximum instead preserves the actual ordering and spacing
between players — Christian McCaffrey, for instance, moved from an
artificial 25% down to his real 13.5%.) 78 of 426 scoped 2026-pool skill
players (QB/RB/WR/TE — K/DST are unit-based, not individually
injury-flagged) are flagged; e.g. Jacoby Brissett (the actual worst case in
the pool) lands at the 25% top of the curve: `211.2` base → `156.3` adjusted
(after both QB's -1.35% error adjustment and the 25% injury discount), while
Christian McCaffrey now lands at a real 13.5%: `206.2` base → `186.0`
adjusted.
`matchupAdjustment` remains the one still-neutral (0) factor —
schedule-strength data hasn't been pulled.

## Roster settings + bench budget % (user-configurable, no longer a silent DOM assumption)

Real per-position roster requirements (how many QB/RB/WR/TE/FLEX/DST/K/BENCH
slots the league actually uses) feed `computeMyRosterState` — this determines
which positions have an open startable slot, which gates whether a
recommendation fires at all. Investigated wiring this up from the DOM the
same way team budgets and player names are, but neither platform has a
reliable source: ESPN's draft-room DOM has nothing roster-shaped anywhere;
Yahoo's team row has only an aggregate roster-fill count ("13/15"), not a
per-position breakdown. Guessing at unverified selectors for a
league-settings page risked the same silent-wrong-data failure mode as the
old `$200` budget guess.

Instead: the side panel now has a "Roster settings" section (collapsed by
default) where the user enters their real league's slot counts once. Saved to
`chrome.storage.local`, so it persists across sessions — no need to re-enter
every draft. `background.js` listens via `chrome.storage.onChanged` (not a
one-off port message, so any future settings surface picks up the same way)
and forces PAR to recompute with the new slots. `DEFAULT_ROSTER_SLOTS` in
`liveDraftState.js` is now only the form's seed/fallback value, not a silent
assumption baked into the math. Verified via mocked integration scripts: the
form pre-fills correctly on a fresh install, Save persists to storage, and a
simulated storage edit (zeroing out RB slots) correctly flips the
recommendation for an RB nomination from a real bid to `no-open-slot` live,
mid-draft.

**Bench budget %, same section.** A real gap the user caught: nothing let you
say "spend 95% of my budget on the starting lineup, save 5% for bench" (vs.
100/0, vs. 90/10). Previously the auction baseline (`computeAuctionBaseline`
in `scoring.js`) only reserved the real $1-per-slot minimum bid for bench —
close to a 100/0 split in spirit, but not an actual dial, and not
configurable. Added `benchBudgetShare` (0-1, default `0` — unchanged behavior
unless the user opts in) to `leagueConfig`: it sets a target reservation as a
fraction of the ENTIRE budget pool, and `reservedDollars` becomes
`Math.max(the $1/slot floor, totalBudgetPool × benchBudgetShare)` — the
platform's real minimum-bid floor can't be dialed away, but the user can
reserve more than that floor for a deeper bench, trading `dollarPerPAR` (and
therefore every starter's fair price) down accordingly. Shown in the side
panel as a 0-100% field (stored as the 0-1 fraction the math expects). Tests
added for the zero-case matching old behavior exactly, a nonzero share
actually lowering `dollarPerPAR`, and the floor never being dialed below the
real minimum-bid requirement; live integration-verified end to end
(`benchBudgetShare: 0.3` on a $200×4 league dropped a real bid recommendation
from `$78` to `$56`).

## Status / next steps

Every piece exists, is independently verified, **and confirmed working live**
on real drafts on both platforms — capture, parsing, team identity, player
identity, real Layer 1 projections, and now live bid recommendations, all
flowing through the extension end to end (`npm test` runs 130 tests). What's
left:

1. **Done — first live end-to-end test of the recommendation engine,
   simultaneously on both platforms.** Real recommendations fired with sane
   values throughout (`$80` on Bijan Robinson, `$78` on Puka Nacua, `$60` on
   Ja'Marr Chase, etc.); player identity and point projections resolved
   correctly; team identity resolved progressively exactly as designed (both
   drafts had all-custom team names, so every team needed the spend-ledger
   match — some resolved within a few picks, others took longer, matching
   the documented behavior, not a bug). Two real bugs surfaced live and were
   fixed on the spot:
   - **Yahoo's recommendation only refreshed on actual bid/nomination
     events, not on Yahoo's own clock ticks** — confirmed live ("a guy on
     the clock but nothing from Yahoo"). Root cause: Yahoo's generic clock
     tick (`C|<secondsRemaining>`) carries zero player/team context, unlike
     ESPN's phase-2 clock tick which carries `teamId`/`playerId`/
     `currentBid`. Fixed by tracking whichever player was last actively
     nominated/bid on (`state.activePlayerId` in `background.js`, cleared on
     `sold`) and falling back to it for player-less clock ticks — makes
     Yahoo's display cadence match ESPN's. Verified against the exact wire
     strings involved (`n|3|999002|1|20`, bare `C|18`, `0|1|999002|3|RB|50`).
   - **Third-party ad/analytics traffic was flooding the raw event feed**,
     confirmed live (a burst of `pbs.yahoo.com`, `casalemedia.com`,
     `seedtag.com`, `criteo.com`, `rubiconproject.com` fetches crowding real
     draft events out of the 500-event ring buffer). The non-WS passthrough
     used to be unconditional ("useful for debugging the capture layer
     itself" — true early on, not anymore now the protocols are understood).
     Fixed with a root-domain filter (`*.yahoo.com` / `*.espn.com` only);
     verified against the exact URLs the user saw, including the one
     genuinely-Yahoo host among the noise (`pbs.yahoo.com`) staying visible.
   - One thing flagged as probably-correct-not-a-bug: a `$1` recommended max
     on a bid for a WR whose projection (94.1 pts) was well below the other
     WRs discussed live — almost certainly a real below-replacement-level
     PAR result (the `$1` floor), not a math error; would need a wrong
     underlying projection to actually be a bug, which the user was asked to
     sanity-check.
2. **Backfilled 2023 actual-stats data** (Pro Football Reference was
   reachable this session) and reran `injuryAdjustments.js`'s calibration
   against the correct 2023-2025 "last 3 seasons" window — 78 of 426 scoped
   players now flagged (was 88 of 426 under the 2022/2024/2025 stand-in).
   **`historicalErrorAdjustments.js`'s errorAdjustment stays on
   2022/2024/2025** — checked, and this genuinely isn't fixable by pulling
   more PFR data: that calibration needs PROJECTED stats from elboberto's
   spreadsheets, and no 2023 elboberto spreadsheet was ever provided (only
   2022, 2024, 2025 exist), so there's nothing to compare 2023's real
   actuals against for that specific piece.
3. **Snake draft support — real progress, real remaining blocker.** Wire
   protocol confirmed live (captured directly from real ESPN and Yahoo snake
   mock drafts, same "never guess, always capture real messages" discipline
   as auction):
   - **ESPN uses genuinely new message types**, not a variant of auction's:
     `SELECTING <teamId> <clockMs>` (turn started — snake's `NOMINATION`) and
     `SELECTED <teamId> <playerId> ...` (pick made — snake's `SOLD`, no
     price). Both added to `espn.js` (`type: 'selecting'` / `type: 'picked'`)
     with tests using the real captured strings as fixtures. A third
     SELECTED field (seen as 1, 11, 12 across samples) and an occasional
     trailing GUID-looking token aren't parsed out — genuinely not
     confidently understood from the samples captured, left as `unknown`
     rather than guessed. Also found and fixed in the same pass: ESPN's
     `CLOCK` message has a 4th shape (`phase: 4`, no further tokens at all)
     seen recurring in snake — the parser used to silently produce `NaN`
     (renders as `null` in JSON) for `msRemaining` there instead of honestly
     omitting a field that isn't in the wire message.
   - **Yahoo needs zero parser changes.** `nominate-turn` and `sold` fire
     correctly for snake already — same underlying wire protocol as auction,
     just with price always `$0`. Confirmed directly from captured events.
   - `recommendBestAvailable` (`liveDraftState.js`) — snake's analog to
     `computeRecommendation`, built before any wire data existed since it's
     pure engine logic with no wire-format dependency. No dollar dimension
     in snake (one pick per turn, not a bid to size), so instead of a max-bid
     number it returns a ranked list — best-PAR undrafted players among
     positions with an open startable slot, reusing `computeMyRosterState`'s
     slot-gating unchanged. Tested.

   **What's still genuinely blocking full snake support, confirmed by
   inspecting the actual DOM structure**: `background.js`'s entire
   budget-inference chain (`reresolveTeams`, `ensurePricing`) and team
   identity's pass-2/3 spend-ledger matching (`identity.js`) both assume a
   dollar signal that structurally doesn't exist in snake — ESPN's snake
   draft room DOM has no `.cash` element at all (`espn.js`'s DOM reader would
   read `NaN` for every team's `remainingBudget`), and even where Yahoo's
   wire technically reports `$0`, that number carries no identifying
   information (it never differs between teams, so it can't disambiguate
   who's who the way real auction spend does). Default-name matching (pass 1
   — "Team {id}" style names) still works fine, unaffected. This needs a
   real design pass, not a bolt-on: a snake-specific team-identity strategy
   (most likely correlating the wire pick sequence against the DOM's visible
   pick-history list, which both platforms do show), a way to detect "this
   is snake, not auction" in the first place (ESPN's message types differ,
   but Yahoo's don't), and `background.js`'s dispatch logic routing to
   `recommendBestAvailable` instead of `computeRecommendation` once detected.

4. **Sleeper support — a third platform, and the first with real live
   snake-draft support end to end.** Sleeper turned out structurally easier
   than ESPN/Yahoo, confirmed by directly querying its own public API
   against a real, live, in-progress draft (with the user's explicit
   permission, using a third-party app called DraftCaddy only to recover the
   real `draft_id`, then talking to Sleeper's own API directly — never
   DraftCaddy's private backend):
   - `GET https://api.sleeper.app/v1/draft/<id>` and `.../league/<id>` need
     **no auth, no developer approval, no OAuth** — they hand over draft
     type (`snake`/`auction`), roster slots, scoring rules, and team count
     directly. `GET .../draft/<id>/picks` gives every pick, including real
     team identity (`roster_id`) — no name/budget-ledger inference needed at
     all, which is *why* Sleeper is the first platform with working snake
     identity: ESPN/Yahoo's blocker above (no non-budget identity signal)
     simply doesn't exist here. See `engine/parsers/sleeper.js` (pure
     mapping functions, unit tested against real captured API responses —
     `sleeper.test.js`) and `src/sleeper-poll.js` (the polling glue, well
     under Sleeper's own documented 1000-calls/minute guidance).
   - The draft-room URL itself is exactly `sleeper.com/draft/nfl/<id>` —
     confirmed live, no redirect, no login wall for a public view.
     `src/dom/sleeper.js` just reads that; no WS/fetch page-context
     patching needed (unlike `capture-main.js`) since there's no wire
     protocol to intercept.
   - `background.js` gained a real `state.isSnake` branch (see
     `computeRecommendationAndFactors`): when true, it calls
     `recommendBestAvailable` instead of the auction path, and
     `ensurePricing`/`reresolveTeams` skip the whole starting-budget
     inference entirely (PAR doesn't need a dollar figure — only
     `computeAuctionBaseline` does, and that's never consulted in snake
     mode). ESPN/Yahoo can also opt into this branch via a manual "Snake
     draft" toggle in the side panel's settings (persisted like
     rosterSlots/scoringRules) — real for Yahoo (whose `nominate-turn`/
     `sold` already fire correctly in snake, confirmed above), **not**
     claimed fixed for ESPN, whose identity blocker is untouched by this
     work.
   - Side panel (`sidepanel.js`/`.html`) gained a ranked-list nominee-card
     rendering path (`renderSnakeNomineeCard`) alongside the existing $-max-
     bid card, used whenever a snapshot carries `recommendationList` instead
     of `recommendation`.
   - **"Which team is me" — solved, confirmed live with a real logged-in
     session** (not guessed, not inferred from docs): unlike an
     unauthenticated public draft-room view, a real logged-in session's
     `localStorage.getItem('user_id')` carries the viewer's own Sleeper
     account id directly. That resolves to a real `roster_id` via two
     fields already present on the draft object itself — `draft_order`
     (user_id -> pick slot) and `slot_to_roster_id` (slot -> roster_id) —
     cross-checked against the user's real draft: their user_id resolved to
     pick slot 2 -> roster_id 8, matching the draft room's own displayed
     "1.2" position for their team. See `resolveSleeperOwnRosterId` in
     `engine/parsers/sleeper.js` (tested against this exact real id) and
     `dom/sleeper.js`'s `readSleeperUserId`. `state.ownTeamId` is set from
     this on every Sleeper draft now, same as ESPN's URL-based resolution.
   - **One remaining known gap, not yet solved and not guessed at:** the
     DST/kicking half of `mapSleeperScoringToEngine`
     (`sack`/`int`/`fum_rec`/`def_td`/`safe`/`st_ff`) follows Sleeper's
     documented field-naming convention but was only checked against a real
     league that scores no defense at all (every field read back `0`) — the
     mapping's field *names* are confirmed to exist, not that they're
     semantically correct. Needs a real league that actually scores defense
     to fully confirm, same "verify against a real signal, don't guess"
     discipline as everything above.

5. **Multi-team account connection + auto-match — the extension's first
   ever network/auth code.** Users can now register more than one team on
   the DraftGenius website (each with its own scoring/roster settings and
   factor toggles — see the sibling `draftgenius` repo's own README-equivalent
   context), and the extension can log into that same account and
   auto-detect which registered team a live Sleeper draft belongs to,
   instead of always using the generic global defaults.
   - `src/auth.js`: plain email/password against Supabase's GoTrue REST API
     (`/auth/v1/token?grant_type=password` / `grant_type=refresh_token`) —
     no `chrome.identity` OAuth dance needed. Tokens live in
     `chrome.storage.local`, same trust boundary the website's own Supabase
     JS SDK already uses (browser `localStorage`). Refresh is lazy
     (`ensureFreshAccessToken`, checked on-demand right before an
     authenticated fetch), deliberately not a periodic background timer —
     MV3 service workers unload after ~30s idle, so a proactive
     `setInterval` refresh isn't reliable by construction.
   - `src/team-match.js`: `matchTeamByExternalLeagueId(platform, externalLeagueId)`
     queries `.../rest/v1/teams?platform=eq...&external_league_id=eq...`
     directly (with `Accept-Profile: draftgenius`, since PostgREST needs
     that header for a non-public schema outside the JS SDK's own schema
     option) — RLS scopes results to the caller via the JWT, no explicit
     user filter needed. Sleeper's own `league_id` (already fetched by
     `sleeper-poll.js`) is the match key — real, free identity, unlike
     ESPN/Yahoo which have no equivalent capture into `background.js`'s
     per-tab state yet (out of scope for this pass, same reasoning as the
     snake-identity gap above).
   - On a match, `background.js`'s `computeTabPlayers`/`ensurePricing`
     apply that team's OWN `mapped_scoring_rules`/`mapped_roster_slots` and
     factor-toggle preferences (`engine/applyFactorToggles.js`, ported
     verbatim from `draftgenius/src/lib/rankings/applyFactorToggles.ts` —
     the website built it first) — computed fresh per-tab from `rawPlayers`,
     never touching the shared module-level `players`/`rosterSlots`/
     `scoringRules`, so a matched team's settings can never leak into a
     simultaneously-open ESPN/Yahoo tab.
   - No match (or not logged in) degrades cleanly: the side panel's account
     summary shows a fallback team picker (or nothing, if logged out) and
     `background.js` falls straight back to the generic global settings —
     the exact behavior that existed before this feature, unchanged. Fully
     additive; logging in is optional.

6. **Two real bugs found live, mid-draft, and fixed.**
   - **Picked players never left "best available."** Root cause: nothing in
     the Sleeper path ever populated `state.playerIdentity` for a pick —
     `captureIdentity` (the function that does this for ESPN/Yahoo) is only
     ever called from the WS `draft-event` handler, never from
     `sleeper-poll.js`'s synthetic pick events. Fixed by having
     `newSleeperPicks` (`engine/parsers/sleeper.js`) carry an `identityHint`
     straight from Sleeper's own pick `metadata` (every real pick object
     embeds the player's name/team/position directly — confirmed live, no
     separate player-lookup endpoint needed), and having `background.js`'s
     `onPicks` handler run it through the exact same `matchPlayer()` ESPN/
     Yahoo already use for DOM-read identity.
   - **Fixed players took up to ~15-20s (several poll ticks) to actually
     clear, and could look stuck well past that.** Not a bug in the matching
     logic above — confirmed via real response headers that Sleeper serves
     the picks endpoint through Cloudflare with
     `cache-control: public, s-maxage=15, stale-while-revalidate=300`. A
     freshly-made pick can sit behind that shared cache for a real, visible
     stretch of time. Fixed with a cache-busting query param
     (`?_=${Date.now()}`) on every poll tick, confirmed via `cf-cache-status`
     flipping from `EXPIRED` to `MISS` — comfortably within Sleeper's own
     1000-calls/minute guidance (this adds up to ~15 calls/minute per open
     draft tab).
   - Also hardened while debugging both: an uncaught throw anywhere in the
     new async team-match lookup (`background.js`'s `onSettings` handler)
     could previously have silently prevented `ensurePricing`/
     `broadcastNominee` from ever running at all for that tab — ANY failure
     there now degrades to "no match" instead of breaking the whole
     recommendation pipeline, and `sleeper-poll.js`'s own retry bookkeeping
     (`settingsSent`) no longer permanently locks out retries after a
     transient failure.

7. **Snake mode's ranked list became two lists, each 10 deep (was one, 5
   deep).** Real user feedback: "Best available" showing only need-filtered
   players hid the actual best players on the board when none of them fit
   an open slot. `recommendTopAvailable` (`liveDraftState.js`) is the new
   pure-value half — same undrafted pool as `recommendBestAvailable`, no
   roster-need filter at all. Side panel now shows both behind a tab toggle
   ("Best Available" = pure value, "Best Fit" = need-filtered, the
   pre-existing behavior) — `sidepanel.js`'s `snakeListTab` tracks the
   active tab per platform outside the DOM, since `nomineeCardsEl`'s
   innerHTML is fully replaced on every update. Each row also shows a
   compact tier badge (e.g. "RB2") — computed once per position in
   `ensurePricing` (`state.tierById`), same restricted `par > 0` /
   `tierGapStdDevs: 0.3` fix as the rankings-page bug above, since this is
   the same "full pool inflates std dev, everyone lands in tier 1" failure
   mode applied to a new caller. (The text tier badge itself was later
   replaced by a tier-cliff underline — see item 9.)

8. **The real, deeper reason picks silently stopped updating — not just the
   Cloudflare cache fixed earlier.** Confirmed live, recurring: even with
   the cache-busting fix, a real draft's picks would eventually just stop
   updating entirely, sometimes for good, only a full extension reload
   recovering it. Root cause: the recurring picks-poll `setInterval` lived
   inside `background.js`'s MV3 service worker, which Chrome can suspend
   after ~30s of inactivity — a plain `setInterval` has no guarantee of
   surviving that suspension, and nothing was left to ever restart it once
   gone. Fixed by moving the actual recurring fetch into the content script
   (`dom/sleeper.js`'s `startSleeperPicksPoll`) — content scripts have no
   such lifecycle, they live exactly as long as the tab does. The content
   script sends the full raw picks array every tick; `background.js`'s new
   `applySleeperPicks` does the dedup (`state.seenPickNos`, per-tab, not a
   closure variable anymore) and identity resolution, reusing the same
   tested `newSleeperPicks` (`engine/parsers/sleeper.js`).
   - `sleeper-poll.js` shrank to just the one-time settings fetch
     (`loadSleeperSettings`) — a one-shot async call isn't vulnerable to the
     same "silently stops forever" failure mode a long-lived interval is.
   - `relay-isolated.js`'s `sendSleeperDraftId` now resends every tick
     (previously only once per unique draft id) — this doubles as a
     heartbeat that lets `background.js` self-heal: if the service worker
     was suspended and restarted (wiping its in-memory `tabStates`), the
     next heartbeat re-triggers the one-time settings/team-match setup from
     scratch. `state.sleeperSettingsLoaded` keeps this a cheap no-op on an
     already-healthy tab.

9. **Snake list run signal (🔥) + tier-cliff underline (replaces the old
   text tier badge).** User asked for a run indicator but explicitly wanted
   the definition researched first, not invented: the most rigorous public
   analysis found (the Fantasy Footballers' own pick-by-pick study across
   real drafts) defines a run as simply "same position picked
   consecutively," with no stated numeric minimum — but community strategy
   consensus treats 3+ concentrated same-position picks as the point a run
   becomes something a drafter actually reacts to. Landed on **3 of the
   last 5 picks** (league-wide, not just the user's own) at the same
   position — a sliding window rather than strict "3 in a row" so one
   off-position pick doesn't erase an otherwise-hot stretch, confirmed
   directly with the user. New `computeActiveRunPosition` (`liveDraftState.js`,
   unit tested) is pure position-counting, no DOM/state coupling — `background.js`
   resolves the last 5 `soldEvents` to positions (same `playerIdentity` ->
   `parById` chain `myPicks` already uses) and passes that in.
   - Tier-cliff underline: the old "· RB2" text badge is gone, replaced by
     an underline under the position itself, shown only when the player is
     the LAST undrafted player left in their tier (a real "next pick empties
     this tier" cliff) — not just "in tier 2 of 3." New
     `computeTierRemainingCounts` (`liveDraftState.js`, unit tested) counts
     currently-undrafted players per `(position, tier)` bucket, keyed off the
     same `state.tierById` the row's tier number already came from (so the
     two signals can never disagree). `remainingInTier <= 1` for a player's
     own bucket is what earns the underline.
   - Both signals attach to every row of both snake ranked lists (`isRun`,
     `isLastInTier`), rendered in `sidepanel.js`/`sidepanel.html`.

10. **`chrome.runtime.sendMessage` throws SYNCHRONOUSLY once a content
    script's extension context is invalidated** — confirmed live: reloading/
    updating the extension from `chrome://extensions` while a matching draft
    tab is already open leaves the OLD content script injected but
    disconnected, and every send from it throws before the existing
    `.catch(() => {})` even attaches, surfacing as an uncaught
    "Extension context invalidated" error. That old script is dead until the
    tab itself reloads — nothing to recover — so `dom/sleeper.js` now
    exports a shared `safeSendMessage` helper (try/catches the synchronous
    throw, same swallow behavior as the async `.catch`) used at all four
    `chrome.runtime.sendMessage` call sites across `dom/sleeper.js` and
    `relay-isolated.js`. Fixes noisy console spam, not the underlying
    Chrome behavior — reload the draft tab after updating the extension, not
    just click Update.

12. **Auction parity check surfaced a real, pre-existing bug — `computeTierInfo`
    (auction's own "Scarcity" factor row) was NEVER given the tier-flattening
    fix applied twice elsewhere this session.** Asked to bring item 9's run/
    tier-cliff aesthetics to auction mode too; while wiring that up, checked
    whether auction's EXISTING tier signal had the same fix as the other two
    (rankings page, snake list) — it didn't. Confirmed live against real
    data: every single RB, from the #1 overall pick down to a -$65 PAR
    waiver player, reported `tier 1 of 1`, completely useless. `computeTierInfo`
    now uses the identical `par > 0` restriction + `tierGapStdDevs: 0.3` as
    `background.js`'s own `state.tierById`, so auction and snake can never
    disagree about what a tier is. Also fixed a related edge case this
    surfaced: a below-replacement player (excluded from tiering, `tier:
    null`) used to still come back `isLastInTier: true` (0 remaining in a
    `null` "tier" trivially satisfies `<= 1`), which would have rendered
    nonsense like "last in tier null of 6" — now guarded on `activeTier !==
    null`. Both fixes covered by new regression tests built against a
    realistically-shaped pool (a few real tiers plus a long flat tail),
    since the small curated pools already in this file can't expose either
    failure mode.
    - Run detection (🔥) and the tier-cliff underline now also render on
      auction's single-nominee header, computed identically to snake's
      (`computeActiveRunPosition` over the last 5 `soldEvents`, `state.tierById`
      via `computeTierInfo`) — genuinely the same signal in both modes, an
      auction's nomination order is just as real a pick sequence as snake's
      turn order. The existing "Market heat" ($/PAR live rate vs. baseline)
      and "Scarcity" text rows in the "Why this number" panel stay as-is —
      a real, separate, more precise dollar-based signal that has no
      snake equivalent — the glyphs are additive, not a replacement.

13. **Extension icon.** Previously shipped with none (Chrome's default
    generic puzzle-piece icon in both the toolbar and `chrome://extensions`).
    Added `extension/icons/icon-{16,32,48,128}.png`, matching the DraftGenius
    website's own brand mark — lucide-react's `Zap` glyph (already an
    existing dependency, ISC-licensed) filled in the site's `--primary`
    indigo (`#6366f1`), rasterized via an offscreen `<canvas>` (no system
    `cairo`/ImageMagick available in this environment). Wired into
    `manifest.json`'s top-level `icons` and `action.default_icon`.

14. **A live, real bug reported by the user: "Best Fit" kept recommending
    RB even with both RB starter slots AND both FLEX slots full.** Verified
    the pure computation first (`computeMyRosterState` + `recommendBestAvailable`,
    fed the user's exact real inputs) — it correctly closed RB to 0 open
    slots and excluded it, proving the math was never the problem. Two REAL,
    separate bugs found instead:
    - `loadSleeperSettings` (`sleeper-poll.js`) fetches this draft's own
      live `rosterSlots`/`scoringRules` correctly, but `background.js`'s
      `'sleeper-draft-id'` handler destructured them straight out of the
      returned object without ever assigning them to `state` — silently
      discarded. Confirmed live: the side panel's "Roster settings" panel
      was showing the generic global defaults (QB1/RB2/WR2/TE1/FLEX1/DST1/
      K1/BENCH6) instead of the user's real league (QB2/RB2/WR3/TE1/FLEX2/
      BENCH10, confirmed against the real captured fixture — matches the
      real "23 Rounds" shown in the draft room). Fixed: `state.sleeperRosterSlots`/
      `state.sleeperScoringRules` are now actually stored and used as a
      middle fallback tier in both `ensurePricing` and (renamed, now
      state-scoped) `computeTabPlayers` — a matched DraftGenius team's own
      config still wins when present; otherwise this draft's own live
      settings; only as a last resort, the generic global default.
    - Even with THIS bug fixed, a second, still-unresolved live-tracking
      bug remains: the user's own picks may not be correctly attributing
      to `state.ownTeamId` (via `resolveSleeperOwnRosterId`'s `draft_order`
      -> `slot_to_roster_id` chain), so `myPicks` could be undercounting
      real picks regardless of correct roster-slot values. Not yet
      root-caused — couldn't be, from static reading alone, without live
      session access. Added a direct diagnostic instead of guessing
      further: an "Open: QB 1 · RB 0 · ..." readout in the snake ranked
      list (from `openStarterSlots`, the EXACT gate "Best Fit" filters
      against) plus a picks-counted figure, so this exact failure mode is
      visible at a glance next time rather than only inferable from a
      wrong-looking recommendation list with no visible cause.

15. **"Draft Rank" tab — every team ranked by cumulative PAR so far, real
    time.** New `computeTeamRanking` (`liveDraftState.js`, unit tested) —
    pure summation over `[{teamId, par}]`, same split as
    `computeActiveRunPosition`: background.js resolves ALL `soldEvents`
    (league-wide, not just the user's own — unlike `myPicks`) to `{teamId,
    par}` pairs via the existing `playerIdentity` -> `parById` chain. Real
    team display names needed a genuinely new fetch — Sleeper's picks carry
    nothing but a bare numeric `roster_id` (unlike ESPN/Yahoo's live DOM
    team snapshot) — so `loadSleeperSettings` now also fetches
    `GET /v1/league/<id>/rosters` (`roster_id` -> `owner_id`) and
    `GET /v1/league/<id>/users` (`owner_id` -> `display_name`/custom
    `team_name`), mapped via new `mapSleeperRosterNames` (unit tested,
    falls back to a generic "Team N" label when a roster has no matching
    user or a user set no custom team name). Third tab alongside Best
    Available/Best Fit; the user's own team is highlighted.

16. **Root-caused item 14's second bug: `ownTeamId` was permanently locking
    in as `null` on a genuine race condition, confirmed via the new "0 of
    your picks counted" diagnostic added in item 14.** Draft Rank (item 15)
    working correctly while the user's own team never appeared highlighted
    ruled out identity resolution generally (Draft Rank uses the exact same
    `playerIdentity` -> `parById` chain and clearly worked) — narrowing it
    specifically to `resolveSleeperOwnRosterId`'s `userId` input.
    `dom/sleeper.js`/`relay-isolated.js` run at `document_start`, which can
    fire BEFORE Sleeper's own SPA has written `user_id` into localStorage —
    the very first `'sleeper-draft-id'` heartbeat can genuinely carry
    `userId: null`. League/scoring/roster-slot settings resolve fine
    regardless (they don't depend on `userId` at all), so the old single
    `sleeperSettingsLoaded` guard treated that PARTIAL success as "fully
    done, never retry" — permanently locking in `ownTeamId: null` for the
    rest of the draft, with `myPicks` then always empty (its filter
    compares every real, non-null `roster_id` against a `null` that can
    never match). Fixed: the guard now also retries (up to
    `sleeperOwnTeamAttempts`'s cap of 5, ~20s at the heartbeat's 4s
    interval) specifically while `ownTeamId` is still `null`, giving
    localStorage time to populate on a slow-loading tab while still
    settling permanently for a genuine spectator who was never going to
    resolve to a real team. Not independently unit-testable (chrome.runtime
    message-handler glue, same category as the rest of `background.js`'s
    event wiring) — needs live re-verification against a real draft.

17. **Tier number restored alongside the tier-cliff underline (was
    removed, then explicitly asked back).** Real user finding: the
    underline alone reads as "nothing visible most of the draft" even when
    working exactly as designed — confirmed live that 5 real, visibly
    different-PAR RBs (71.0 down to 43.0) were genuinely all in the SAME
    tier (15 players wide), so correctly showing zero cliffs among them —
    but a raw PAR gap still visually reads as "there's obviously a
    falloff here" even when the statistical clustering says otherwise. The
    tier number gives a constant, low-effort signal ("this is roughly where
    this player sits") for the common case; the underline stays reserved
    for the rarer, sharper "you'll lose this exact tier next pick" cliff
    signal. Row format: `${position}${tier}` (e.g. "RB4"), underlined only
    when `isLastInTier`.

18. **Side panel restructured into a Draft/Settings switcher, per the
    user's explicit ask.** Account/Roster/Scoring settings used to sit as
    three always-expanded-or-collapsed `<details>` blocks permanently above
    the draft view, pushing the actual ranked list down — a "set up once,
    rarely revisit mid-draft" surface competing for space with what
    actually matters while a draft is live. Moved into a `#settings-view`
    container, hidden by default behind a two-tab switcher at the very top
    (`.view-tabs`); `#draft-view` (budget prompt + nominee cards) is the
    default. Also removed the static "DraftGenius" `<h1>` header — Chrome's
    own side panel chrome already shows the extension's name and (now
    real, see item 13) icon above it, so it was pure duplication.

19. **The REAL root cause of item 16's `ownTeamId` bug, found via a live
    DevTools console check after item 16's timing-race fix demonstrably
    didn't resolve it.** Item 16's own new diagnostic (raw `ownTeamId` +
    recent real pick ids, side by side) showed `ownTeamId: null` persisting
    across 5+ real picks and far past the retry cap's ~20s window — ruling
    out "still resolving" and meaning the retry fix, while a real
    improvement, was never the actual bug. Had the user run
    `localStorage.getItem('user_id')` directly in Sleeper's own DevTools
    console: it returned the STRING `"1390452489643366448"` — **with
    literal embedded quote characters** — not the bare digit string
    `readSleeperUserId` (and every downstream consumer) had always assumed.
    Sleeper stores this value JSON-encoded; `draft_order`'s real keys are
    the bare digits, so a quoted lookup key always missed, unconditionally,
    regardless of timing — this bug has likely existed since
    `readSleeperUserId` was first written, item 16's race condition was a
    real-but-secondary issue layered on top of it. Fixed in
    `readSleeperUserId` (`dom/sleeper.js`): strip a single surrounding
    quote pair directly from the raw value — deliberately NOT
    `JSON.parse`, since these ids are 19-digit numbers well past
    `Number.MAX_SAFE_INTEGER` and parsing through JSON's number coercion
    would silently round-trip the value through a float, corrupting its
    precision (a subtly WRONG id being worse than an honestly-missing
    one). Verified directly against the real captured value before
    shipping. Needs live re-verification against a real draft, same as
    item 16 (this file's dom/ layer has no unit-test harness — see
    `readSleeperUserId`'s own comment). **Confirmed fixed live by the user**
    (`ownTeamId` resolved to a real id, "Best Fit" correctly excluded a
    full position) — the first fix in this whole Sleeper effort verified
    against a genuinely live draft rather than mocked/simulated data.

20. **Diagnostic readouts (item 16's raw-id line, item 14's open-slots
    line) removed once the bug they existed to find was confirmed fixed.**
    Real user feedback: the open-slots breakdown duplicated what the draft
    platform's own UI already shows (ESPN/Yahoo/Sleeper all have a
    "QB 0/2 · RB 2/2 · ..." filter row), so it was pure clutter once no
    longer needed for debugging — this codebase's established discipline
    (see the earlier Activity-log removal) is to delete a scaffold once its
    job is done, not leave it toggled off. Also surfaced a related, real
    confusion while investigating the removal: the manual "Roster settings"
    form's generic default numbers (unused for a detected Sleeper league,
    but still visibly ON SCREEN) read as "wrong" even with a disclaimer
    sentence above them. Fixed by showing the actual live-applied settings
    directly inside that same form too (`updateEffectiveRosterDisplays`),
    not just in the separate Account panel — a real side-by-side, not just
    more disclaimer text — and made it update regardless of login status
    (previously gated behind being logged in, even though the underlying
    settings apply either way per item 14's fix).

21. **Duplicate player id found and fixed — `slugify()` never included
    position.** Real React error surfaced live on draftgenius's Rankings
    page ("two children with the same key, `connor-heyward-lv`"): the id
    scheme was `${name}-${team}`, no position component, and FantasyPros'
    own 2026 export genuinely lists "Connor Heyward, LV" in BOTH `rb.csv`
    and `te.csv` — a full scan confirmed this was the ONLY collision across
    all 592 players, but any consumer keying off `id` (React's key prop
    here; `playerIdentity`/`parById` Maps in the extension's own
    `background.js`) was silently vulnerable to it. Fixed by
    position-qualifying the id (`connor-heyward-lv-rb` /
    `connor-heyward-lv-te`); added a build-time uniqueness check
    (`build-projections.js` now throws with a clear message on any future
    duplicate) so a bad export can never silently ship again. Separately:
    both source CSV rows list team "LV", which itself looks wrong — the
    real Connor Heyward has played his whole career at TE for
    Pittsburgh, not as a Las Vegas RB — but left the raw source data
    untouched rather than hand-correcting it, matching this pipeline's
    "sourced mechanically, never hand-curated" discipline; the erroneous RB
    row's value (6.4 adjusted points) is low enough it was never going to
    surface in a real recommendation regardless.

22. **Feedback button — a plain `mailto:` link, not a hosted form.** Small
    ✉️ button next to the Draft/Settings switcher, opens
    `mailto:wdenmaniv@gmail.com` prefilled with the extension version and
    which platform(s) have an active draft right now. Deliberately not a
    POST-to-an-API-route approach (would need a new backend endpoint, a
    transactional email service, and a manifest host-permission change) —
    zero new infrastructure, and guaranteed to land in a real inbox via
    whatever mail client/webmail is already configured, unlike a
    stored-in-a-database approach nobody's reminded to go check.

23. **Side panel polish pass, per real user feedback.** Three changes: (1)
    Account/Roster/Scoring converted from independently-expandable
    `<details>` accordions into tabs (one panel visible at a time) — same
    interaction pattern the draft view's own Best Available/Best Fit/Draft
    Rank tabs already use. (2) The platform badge ("SLEEPER") at the top of
    each nominee card sized up (10px→13px, bolder, letter-spaced) to read
    as a clear section header, a distinct tier above the 11-12.5px row text
    below it — it's the only place `.badge` renders, so this couldn't
    affect anything else. (3) `SNAKE_LIST_COUNT` 10→15 (real feedback: the
    panel had visibly unused vertical space) — deliberately not pushed all
    the way to 30 as literally asked: past ~15-20 rows "Best Available" is
    mostly replacement-level players nobody would seriously consider ahead
    of the top of the list, so it would mean more scrolling for
    diminishing signal, not genuinely more useful depth. Flagged that
    reasoning directly rather than just implementing the larger number.

24. **`computeTiers`' threshold algorithm changed — real bug found live,
    independently on RB and WR, cross-checked against a real third-party
    reference (boberto.app).** The `par > 0` restriction (items 9/12/19/21's
    fix) solved "everyone lands in tier 1" but left a different, deeper
    problem: comparing each gap to a multiple of the position's value
    standard deviation. That statistic is dominated by whatever huge gaps
    happen to sit at the very top of a position (RB1 vs. RB2, WR1 vs.
    WR2/3 are often real blowouts) — those few outliers inflate the value
    spread enough that the derived threshold becomes bigger than nearly
    every OTHER real gap further down. Confirmed live on 2026 data: RB
    dumped McCaffrey ($42) through Bucky Irving ($15) — 19 real, distinct
    players — into one "RB4"; WR was worse, putting literally everyone
    outside the top 4 into one "WR2". The user pulled up boberto.app's own
    tiers as a reference (visibly 2-8 players wide, never a megatier),
    which confirmed this was a real gap in quality, not just an unusual
    preference. Fixed by comparing each gap to `tierGapMultiplier` (default
    2) times the position's MEDIAN gap size instead of a multiple of the
    value std dev — a couple of huge outlier gaps barely move a median, so
    the threshold stays sized to what a "typical" step between neighboring
    players actually looks like. Real result on the exact data above: RB
    tier sizes went from `[1,1,1,19,...]` to `[1,1,1,5,14,...]` (a real,
    previously-invisible tier of 5 recovered); WR went from `[4,20+]` to
    `[2,2,1,1,1,3,3,3,7,...]` — closely matching boberto's own granularity.
    RB's remaining 14-player tier appears to be a genuine property of this
    year's flat RB2-RB20 range, not a remaining bug — no tiering method
    invents structure that isn't actually there in the underlying values.
    New regression test built from the exact real RB PAR values that
    triggered this live, guarding against a few big top-of-position gaps
    ever swallowing a smaller-but-real tier further down again. All three
    real call sites (background.js's `ensurePricing`, `computeTierInfo` in
    liveDraftState.js, draftgenius's Rankings page) updated to the new
    default — none of them had a reason to use a non-default multiplier, so
    the stale explicit `{tierGapStdDevs: 0.3}` at each call site was
    removed rather than translated to an equivalent-but-now-meaningless
    `tierGapMultiplier` value.

25. **A real, live-observed regression: item 10's "swallow the console
    error" fix for a stale content script made a real problem completely
    SILENT instead of just noisy.** Confirmed live during an actual draft:
    multiple drafted players (not just one — the exact symptom that
    revealed this wasn't a matchPlayer/identity bug) kept showing as
    available in the ranked list, growing over time. Root cause: this
    extension's version was bumped many times in one session (each fix
    requiring a `chrome://extensions` reload), and the DRAFT TAB itself was
    never also refreshed — leaving its content script's connection to the
    extension permanently dead. Before item 10, that produced a visible
    (if noisy) console error; after item 10 swallowed it, there was
    **zero** visible sign anything had stopped working — the only symptom
    was drafted players silently never disappearing from the list, with no
    obvious cause. Fixed with a one-time, unmissable banner
    (`showReconnectBanner` in `dom/sleeper.js`) injected directly onto the
    Sleeper page itself (not the extension's own side panel — equally
    disconnected from that specific tab) the moment `safeSendMessage`
    catches the synchronous "context invalidated" throw: "DraftGenius
    extension was updated — refresh this page to reconnect it," with a
    one-click Refresh button. Self-heals completely once refreshed — the
    tab's fresh content script reconnects, and background.js's per-tab
    `state.seenPickNos` (which survives a tab refresh — it's keyed by
    `tabId`, not reset by a page reload) means every pick made during the
    disconnected window arrives as "new" on the very next poll and gets
    processed correctly, with nothing double-counted.

26. **Sticky login — a real bug reported by an actual beta user.** A brief
    connectivity issue logged her out of the extension entirely and forced
    a full relogin. Root cause in `ensureFreshAccessToken` (`auth.js`): any
    non-2xx response from the refresh-token exchange was treated as "this
    refresh token is dead," clearing the whole stored session — but a 5xx
    (Supabase or an intermediate proxy failing during a real connectivity
    blip) is not proof the refresh token itself is invalid, only a
    definitive 4xx (GoTrue's own `invalid_grant` for a genuinely expired/
    revoked token) is. Fixed to only log out on a 4xx; any other failure
    (including the network-exception path, already handled correctly)
    leaves the still-valid stored refresh token in place for the next
    attempt to retry with. Not independently unit-testable (real network
    call + chrome.storage, same category as this file's other chrome-glue
    code) — needs live re-verification, same as items 16/19's similar
    live-only fixes.

27. **The REAL cause of "several drafted players stuck showing as
    available," found live during an actual draft — item 25's reconnect
    banner was the right fix for a different, real problem, but this one
    turned out to be something else entirely.** The tell: refreshing the
    draft tab (which would fix a stale-connection issue) did NOT unstick
    the players. Root cause: `applySleeperPicks` calls `matchPlayer`
    against the module-level `players` array, which starts as `[]` and is
    populated by its own async fetch — normally fast, but MV3 service
    workers are suspended after ~30s idle (routine during the natural gaps
    between picks in a real draft), wiping every module-level variable,
    `players` included. If a `'sleeper-picks-poll'` message is processed
    in the brief window between a fresh wake and that refetch finishing,
    every pick in that batch fails `matchPlayer` against an empty roster —
    and since `state.seenPickNos` marks a pick "seen" regardless of match
    success, that failure is PERMANENT, surviving a tab refresh (that
    state lives in the service worker, not the page). Confirmed live: real
    picks (Chris Olave, Jaxson Dart, Zay Flowers) got stuck for the rest
    of a real draft. Verified directly against Sleeper's real API for this
    exact draft (`curl`'d the live picks endpoint) that their metadata was
    completely normal — ruling out a data-shape issue and confirming it
    was a timing race. Fixed with a one-line guard: `applySleeperPicks`
    returns immediately (processing nothing, marking nothing seen) when
    `players.length` is still 0, so the next poll tick 4 seconds later —
    by which point `players` has virtually always finished loading —
    retries the exact same picks instead of having permanently burned
    them. This fix also serves as tonight's live recovery mechanism: a
    full extension reload (fresh `tabStates` + `players` reload) combined
    with a tab refresh reprocesses everything cleanly, since nothing from
    before the reload carries over.

28. **A second, unrelated, 100%-reproducible real bug — Sleeper's own
    "DEF" position code vs. players-2026.json's "DST" — found from a
    direct user tip, confirmed against Sleeper's own public player
    database.** `curl`'d `api.sleeper.app/v1/players/nfl` directly: every
    real team defense entry reports `position: "DEF"`. `matchPlayer`
    filters candidates by position BEFORE comparing names at all, so this
    mismatch meant every single Sleeper defense pick, in every draft,
    unconditionally failed to match — not a rare timing race like item 27,
    a deterministic failure for the entire position. Confirmed Kicker's
    position code ("K") already matched correctly, ruling out a broader
    position-naming problem. Fixed at the one place Sleeper's raw position
    code enters the system — `normalizeSleeperPosition` in
    `parsers/sleeper.js`, mapping "DEF" to "DST" before it ever reaches
    `matchPlayer` — rather than teaching every downstream consumer to
    treat the two as equivalent. Verified end to end against a real
    defense's real Sleeper shape (San Francisco 49ers) before shipping.

29. **Draft view: "Best Available" renamed "Best All," new "Position" tab
    (with QB/RB/WR/TE/K/DST sub-tabs), and a "Full Team"/"Starters Only"
    toggle on Draft Rank — all per direct user request.** "Position" is a
    TRUE per-position ranking (every undrafted player at that one
    position, by value) computed fresh server-side per position, not the
    existing top-15-overall list filtered down — filtering would show
    almost nothing for a position that isn't currently "hot," defeating
    the point. New `computeStarterOnlyRanking` (`liveDraftState.js`, unit
    tested) sums only the subset of each team's picks that would fill
    their real starting lineup (by position, plus a shared FLEX pool) —
    the same "best pick per slot; FLEX takes the best of what's left over"
    assignment `computeMyRosterState` already uses for the current user's
    own open-slot count, applied here per OTHER team for a ranking view. A
    real, acknowledged v1 simplification, same as that existing function:
    which specific picks fill FLEX vs. bench isn't a true assignment-
    optimization solve. Both the "Full Team" and "Starters Only" totals
    are computed and shipped together per team; the toggle just picks
    which field to sort/display by client-side, no extra round-trip.

30. **Website: PAR explained, and a real "last refreshed" date — both per
    direct user request.** A small ⓘ next to the Rankings table's PAR
    column header (click-to-toggle, same convention as the extension's own
    info buttons and this site's existing `factor-settings-form.tsx`
    `<details>` reveals) explains "Points Above Replacement" in plain
    language. The "last refreshed" date comes from a genuinely new build-
    time artifact — `players-2026-meta.json`, written by
    `build-projections.js` alongside `players-2026.json` — recording WHEN
    that script was last run, not FantasyPros' own internal "consensus
    last updated" timestamp (that's a fact from their webpage's header at
    download time, never encoded in the CSV export itself — claiming to
    know it precisely would be dishonest). Kept as a separate small file
    rather than a field folded into `players-2026.json`, since that file
    is consumed as a bare array everywhere (React keys, background.js's
    identity Maps) and wrapping it in an object would be a breaking change
    to every existing consumer. Added to `sync-engine.mjs`'s copied-file
    list alongside the main data file.

31. **Sleeper: a picked player could get permanently stuck showing
    "available" — a real bug found live, mid-draft, distinct from the
    earlier players-array race (#27).** Sleeper's pick `metadata` (the only
    source of the picked player's name/team/position — see
    `buildSleeperIdentityHint`) can lag a moment behind the pick itself
    appearing with a `player_id`. If a poll tick (every 4s) landed in that
    gap, `identityHint` came back null, `matchPlayer` never ran, and — since
    the pick was already marked seen (needed to avoid double-pushing it to
    `soldEvents` every tick) — that pick was never looked at again, even
    though Sleeper's metadata was fully populated on the very next poll.
    Confirmed live: Jameson Williams stayed "available" in the ranked list
    for several picks after actually being drafted. Fixed with a retry
    pass in `applySleeperPicks`: every tick, any already-seen pick whose
    identity is still unresolved gets a fresh `matchPlayer` attempt using
    that tick's current metadata — `seenPickNos`/`soldEvents` stay
    exactly-once, only identity resolution retries. `buildSleeperIdentityHint`
    pulled out of `newSleeperPicks` so both the first pass and the retry
    pass share the exact same construction. Shipped as extension v0.0.20.

32. **Sleeper: a player could stay "available" indefinitely even with
    background.js's internal state fully correct — a live-update channel
    bug, not a data bug, found by ruling out #31's cause first.** A live
    mid-draft report (Davante Adams, Terry McLaurin) initially looked like
    #31 recurring, but a temporary debug hook (`self.dgDebug()`, exposed on
    the service worker for exactly this — module-scoped `let`/`const`
    aren't reachable by typing their name into that console) proved
    `state.playerIdentity`/`state.seenPickNos`/`state.soldEvents` were ALL
    already fully correct for both players. The real cause: `ports` in
    background.js is a module-level `const ports = new Set()`, wiped on
    every MV3 service-worker suspension exactly like `players` (#27) and
    `tabStates` — but unlike those, nothing rebuilds it. Draft STATE
    self-heals on the next poll tick (background.js always reprocesses the
    FULL picks history), but `broadcastNominee`'s `for (const port of
    ports)` had nothing to iterate after a suspension — a real, connected
    side panel, invisible to the fresh (empty) `ports` Set in the new SW
    instance, silently stopped receiving live updates with no error on
    either end. Confirmed live: reloading the whole extension always fixed
    it (forces the panel to open a brand-new port, added to whatever
    instance's `ports` is current) — not something you can ask a user to do
    mid-draft. Fixed in `sidepanel.js`: the port connection is now wrapped
    in `connectPort()`, called again from `port.onDisconnect` — reconnects
    automatically and gets the same full, correct resync
    background.js's `onConnect` handler already sends any newly-connected
    port. Shipped as extension v0.0.22 (`self.dgDebug()` kept in for now,
    harmless and possibly still useful — first thing to strip out once this
    is confirmed solid over a few more live drafts).

33. **Headline pick recommendation (snake) + margined bid range/verdict
    (auction) + an injury-flag icon everywhere a player's name shows — per
    direct request: most drafters just want the decisive answer, not to
    synthesize it themselves from a ranked list.** Snake: a new
    `pickHeadlineRecommendation` (`engine/liveDraftState.js`) reads the top
    pick straight out of the existing Best Fit list and surfaces two real
    alternates — next-best at the SAME position, and best at the next
    DIFFERENT position — both degrading to `null` (never guessed) when the
    list is too short/concentrated. Rendered in a new section between the
    platform badge and the tab row. Auction: `applyValueMargin`
    (`engine/scoring.js`) discounts the recommended max by 8% of fair
    value (a percentage, not a flat dollar amount, so it scales sanely
    from bench players to stars) — winning at exact fair value is a wash,
    not a win; `computeBidVerdict` compares the room's live price against
    that margined max and returns bid/hold/pass (hold is a deliberate
    narrow $1 band right at the ceiling). Both left `recommendMaxBid`
    itself untouched — the margin is a separate, small transform on top,
    so its own existing tests and `bindingConstraint` reasoning stay valid
    as the *unmargined* number. Injury flag: a small inline red SVG cross
    next to any player whose `injuryDiscount` is currently nonzero — which
    was already the toggle-correct value everywhere it's read
    (`applyFactorToggles` already zeroes it when a team's injury-discount
    toggle is off, both in the extension and on the website), so this was
    pure rendering, no new plumbing. Shipped as extension v0.0.23 and on
    the website (players/rankings table).

34. **Headline pick section: a real card, not text crammed between the
    badge and the tabs.** Real feedback on #33's first version: "crowded
    and messy." Rebuilt `renderHeadlineHtml` (`sidepanel.js`) and its CSS
    (`sidepanel.html`) as a distinct card — own background/border/radius,
    real padding, a divider between the top pick and the two alternates,
    which now render as a 2-column grid of small bordered cells instead of
    stacked inline text. Alternates are labeled "Alt 1"/"Alt 2" as the
    PRIMARY label (with "Next QB"/"Best TE" etc. as a small sublabel) — per
    direct request, so they read unambiguously as alternatives, not more
    ranked-list noise. Verified by rendering the exact markup+CSS against a
    real captured screenshot's data in an isolated preview page before
    shipping (couldn't rely on a live draft being open). Shipped as
    extension v0.0.24.

35. **Draft Rank's tabs/pills/"(you)" swapped from green to the DraftGenius
    purple, and the ⓘ explanation text de-emphasized — both per direct
    feedback on #34's screenshot.** Purple accent: `.snake-rec-tab.active`,
    `.snake-rank-mode-tab.active`/`.snake-position-sub-tab.active` (Full
    Team/Starters Only and the Position sub-tabs — same pill family, would
    look inconsistent if only one got the treatment), `.snake-rank-you`,
    and `.snake-rank-own`'s row-wash all moved to `#a5b4fc`/`#818cf8`
    (same tint used for the headline "PICK" label — see #34), leaving PAR
    values themselves untouched (still `#7ee787` everywhere) since that
    was explicitly excluded. Scoped to the snake ranked-list/tab family
    actually shown in the feedback screenshot — the page-level Draft/
    Settings switcher (`.view-tabs`) is a different, unrelated element and
    stayed green. `.snake-rec-info` had NO dedicated styling before this —
    it rendered at the same size/weight as regular body text, reading as
    more dominant than the section headers around it; now explicitly
    smaller (10.5px vs. the tabs' own 10.5–12px, but lighter-weight and
    dimmer) and de-emphasized. Verified by rendering the real markup+CSS
    against the feedback screenshot's exact data in an isolated preview
    page before shipping. Shipped as extension v0.0.25.

36. **Roster and Scoring settings forms showed different numbers than the
    "Currently used for this draft" banners right next to them — real,
    confirmed user report, direct follow-on from #34/#35's own polish.**
    Root cause: `loadRosterSlots()`/`loadScoringRules()` (`sidepanel.js`)
    only ever read the generic MANUAL fallback from `chrome.storage.local`
    — never synced against `state.leagueConfig`'s real, live-detected
    values the banner text was built from. Scoring had it worse: no
    banner existed there at all, so a detected league's real scoring was
    silently in effect with zero indication the form below wasn't what
    was actually driving PAR. Fixed at the root, not just the display:
    `computeEffectiveScoringRules` pulled out of `computeTabPlayers`
    (`background.js`) so `buildNomineeSnapshot` can surface the exact same
    value as a new `effectiveScoringRules` field (mirrors the existing
    `effectiveRosterSlots`) — added a matching "Currently used" banner to
    the Scoring tab. Then, in `sidepanel.js`, a new
    `syncFormInputsToEffective` OVERWRITES the manual form's visible input
    values with these live numbers whenever they're available (skipping
    any field the user has currently focused, so an in-progress edit isn't
    clobbered by the next nominee update) — the actual fix, not just
    matching banner text: editing + Save still only ever writes the manual
    fallback to storage, unchanged, so it's still exactly what's used the
    moment no real league is detected. Verified by rendering the real
    markup+CSS+sync logic against the reported screenshot's exact detected
    values in an isolated preview page. Also: the website's players page
    subtitle unconditionally claimed "not a generic list" even while its
    own `usingDefaultLeague` banner admitted otherwise — same contradiction,
    same fix, made the subtitle conditional on that same flag
    (`src/app/app/players/page.tsx`). Shipped as extension v0.0.26.

37. **Website: no PAR before a team exists; roster + full scoring grid
    always visible, no expand step. Extension: a matched Sleeper team's
    saved settings drift-detected against the live draft, with a real
    persistent "update my saved team" accept; ESPN/Yahoo always get an
    explicit team picker instead of no settings integration at all.**
    Direct two-part request.
    - **Website** (`src/app/app/players/page.tsx`): PAR against silent
      generic defaults (10 teams, $200 budget) for a brand-new user isn't
      accurate for them — no longer computed or shown at all without a
      team; a CTA to `/app/league` replaces the whole rankings section
      instead. `manual-league-form.tsx`: the collapsed "Advanced
      settings" `<details>` is gone — Roster slots and the full per-stat
      Scoring grid both render inline, always. The scoring preset dropdown
      is now a pure quick-fill (`applyPreset`) rather than a mode gate —
      it used to hide the granular fields entirely unless "Custom" was
      selected, which read as "there's no points settings" even though
      the fields existed; `customScoring` is always what saves now, and
      editing any field by hand flips the label to "Custom"
      (`updateScoringField`).
    - **Extension**: new `extension/engine/settingsConflict.js`
      (`detectSettingsConflict`, Sleeper-only — ESPN/Yahoo have no live
      settings-detection to compare against yet) compares a matched
      team's SAVED `mapped_roster_slots`/`mapped_scoring_rules` against
      this draft's real live-fetched `state.sleeperRosterSlots`/
      `state.sleeperScoringRules`, both already merged against their
      DEFAULTs first (same merge `computeEffectiveScoringRules`/
      `ensurePricing` already use, so a partially-populated saved row
      never false-positives). Wired in right after both `state.matchedTeam`
      and the live Sleeper settings are set (`background.js`'s
      `'sleeper-draft-id'` handler); surfaced as `settingsConflict` on the
      nominee snapshot. Accepting the new Account-tab banner
      (`sidepanel.js`'s `accountSettingsConflictUpdateBtn`) sends
      `'accept-settings-conflict'` → `acceptSettingsConflict` →
      `team-match.js`'s new `updateTeamSettings` — a real `PATCH` to the
      team's row (persists for future drafts too, not just this one) —
      then updates `state.matchedTeam` in place and clears the conflict.
      Separately: `applyManualTeamMatch`'s tab filter was
      `state.teamMatchStatus !== 'no-match'` — correct for Sleeper, but
      it silently excluded ESPN/Yahoo tabs entirely, since nothing ever
      sets `teamMatchStatus` there (`null` forever, no auto-match exists
      for those platforms) — fixed to exclude only an existing `'matched'`
      status. `updateAccountMatchStatus` generalized from
      Sleeper-hardcoded to loop any currently-open platform
      (`ACCOUNT_PLATFORM_ORDER`), and `populateTeamPicker` is now
      platform-parameterized (was a Sleeper-only singleton) — ESPN/Yahoo
      now always get the same explicit team picker Sleeper's `no-match`
      case already had, instead of no account-settings integration at all.
      Verified: new `extension/engine/settingsConflict.test.js` (8 cases:
      identical, roster-only, scoring-only, both, partial-row-merge
      correctness, missing-data-is-not-a-conflict, null-handling,
      non-editable-field-exclusion); the new Account-tab banner/picker
      markup rendered in an isolated preview page before shipping. Not
      yet confirmed against a real live Sleeper draft with a genuinely
      stale matched team — next real opportunity should double-check the
      accept flow actually round-trips to the website.

38. **FLEX eligibility is now configurable per team — W/R/T (default) vs.
    W/R only (no TE), per direct request.** `engine/liveDraftState.js`
    already supported an arbitrary `flexEligible` array (`buildLeagueConfig`,
    `computeStarterOnlyRanking`) — nothing to change there. New
    `flex_includes_te` column on `teams` (website migration 0007, default
    `true`). Extension: same two-tier precedence as roster/scoring — a
    matched team's own `flex_includes_te` wins when set, else a new
    manual `chrome.storage.local` setting (`flexIncludesTe`, side panel
    checkbox "FLEX includes TE") — via new `computeEffectiveFlexEligible`
    (`background.js`), wired into `ensurePricing`'s `buildLeagueConfig`
    call. Also synced into the side panel display the same way roster
    slots/scoring rules already are (`effectiveFlexIncludesTe` on the
    nominee snapshot), for the identical reason: showing a stale checkbox
    value while a matched team's real setting drives pricing would be the
    same confusing mismatch already fixed once this session. Known,
    stated limitation: Sleeper's own live-fetched settings don't
    distinguish FLEX sub-type (`WRRB_FLEX` vs. plain `FLEX`) yet — only a
    slot COUNT (see `mapSleeperRosterSlots`'s own comment) — so there's no
    auto-detected middle tier for this one the way there is for roster
    slot counts/scoring; a real Sleeper `roster_positions` capture would
    be needed before that's honestly buildable. Shipped as extension
    v0.0.28.

39. **Auction's "Why this number" panel snapped back to collapsed moments
    after opening it — a real, live bug, direct user report.** Root cause:
    `nomineeCardsEl.innerHTML` is fully replaced on every nominee update
    (a new bid, a new nomination), which happens constantly in an active
    auction, and the `<details class="nominee-factors">` element had no
    persisted open/closed state at all — every re-render silently reset it
    to collapsed. Fixed the same way `snakeInfoOpen` already tracks the
    snake side's ⓘ panel: a new `nomineeFactorsOpen` map keyed by
    platform, re-applied as the `open` attribute on every render, kept in
    sync via a delegated `toggle` listener on `nomineeCardsEl` (capturing
    phase — `toggle` events don't reliably bubble to a delegated ancestor
    otherwise). Verified in an isolated interactive test: expand the
    panel, trigger a simulated re-render (a full innerHTML replace, same
    as a real live update), confirm `details.open` is still `true`
    afterward.

40. **Website -> extension auto-login, per direct request: logging into
    draftgenius.vercel.app did nothing for the extension** — it has a
    completely separate session with no automatic inheritance from the
    website's origin (there's no browser mechanism for that at all).
    Built via `externally_connectable` (`manifest.json`) + a new
    `chrome.runtime.onMessageExternal` listener (`background.js`) that
    accepts a real Supabase session handed over from the website and
    writes it with `auth.js`'s own `storeSession` (now exported, so this
    writes the exact same shape `login()`/`ensureFreshAccessToken()`
    already do — no second, driftable copy of that logic). Required
    pinning a fixed `"key"` in `manifest.json` first — Chrome derives a
    DIFFERENT, unpredictable extension id per unpacked install path per
    machine otherwise, which would make it impossible for the website to
    know which id to target; generated a real keypair and verified the
    resulting id (`efgblppaehojocojgmbahcnackknfeog`) against Chromium's
    own `id_util.cc` source (SHA-256 of the DER public key, first 16
    bytes, hex-encoded, each hex digit mapped to `'a' + value`) rather
    than trusting a remembered algorithm for something a wrong answer
    would silently break entirely. Website side: new
    `ExtensionAutoLogin` component (`src/components/app/
    extension-auto-login.tsx`) on the Extension page — pings the pinned
    id on mount, and on a response hands over the current session
    (`accessToken`/`refreshToken`/`expiresIn`/`email`) via
    `chrome.runtime.sendMessage`; a visible Retry covers "just installed,
    still on this page" (no background polling loop). `sender.origin` is
    checked in the listener too, not just left to the manifest
    declaration, since this writes real auth tokens into storage. **Real
    one-time cost worth flagging**: any existing unpacked install loaded
    BEFORE this manifest `key` existed had its id derived from the
    install path instead — reloading with this version changes that
    tab's extension id from Chrome's perspective, which means its
    OLD `chrome.storage.local` (saved settings, any existing login) does
    not carry over automatically; a fresh reload effectively starts that
    storage over once. Shipped as extension v0.0.29.

41. **Live bid-range gauge on the auction nominee card, per direct
    request**: a horizontal bar showing where the current price sits
    between $1 and the (already margined) recommended max, filling as
    bidding rises. New `renderBidRangeBar(currentPrice, maxBid, verdict)`
    (`sidepanel.js`) — no new data or computation, reuses
    `nominee.currentPrice` and the already-computed `bidVerdict` the
    Bid/Hold/Pass badge next to it already uses, so it updates on the
    exact same live re-renders as everything else in the card. Fill is
    clamped to 100% once price exceeds max (an overflowing bar would just
    look broken; solid red at 100% already communicates "past the
    ceiling" on its own) and colored by verdict (green/gold/red, same
    palette as the badge). Replaced the old plain-text "Range $1–$X" line
    — the bar shows the same range more usefully, so the text became
    redundant. Verified visually across all four real states (no bid yet,
    comfortably under, right at the ceiling, over the max) in an isolated
    preview before shipping. Shipped as extension v0.0.30.

## Loading it

1. `chrome://extensions` → enable Developer mode → "Load unpacked" → select
   `extension/`.
2. Click the extension's toolbar icon to open the side panel (or it opens
   automatically per the manifest's panel behavior).
3. Navigate to a live draft on ESPN or Yahoo in another tab and watch events
   stream in.
