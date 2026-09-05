// Service worker — combines the raw WS capture (from relay-isolated.js) with
// DOM team snapshots and active-player reads (also from relay-isolated.js)
// to run the real, Node-tested parsing/identity/scoring engine live, then
// fans enriched events — including live bid recommendations — out to the
// side panel. "type": "module" per manifest.json is what lets this import
// the exact same engine code covered by `npm test`, instead of a duplicated
// copy living only inside the extension.
import { parseEspnMessage } from '../engine/parsers/espn.js';
import { parseYahooMessage } from '../engine/parsers/yahoo.js';
import { loadSleeperSettings } from './sleeper-poll.js';
import { matchTeamByExternalLeagueId, updateTeamSettings } from './team-match.js';
import { storeSession } from './auth.js';
import { detectSettingsConflict } from '../engine/settingsConflict.js';
import { newSleeperPicks, buildSleeperIdentityHint } from '../engine/parsers/sleeper.js';
import { buildSpendLedger, resolveTeamIds } from '../engine/parsers/identity.js';
import { matchPlayer } from '../engine/projections/matchPlayer.js';
import { DEFAULT_SCORING_RULES } from '../engine/projections/leagueScoring.js';
import { applyFactorToggles } from '../engine/applyFactorToggles.js';
import { computeTiers, applyValueMargin, computeBidVerdict, fairPrice } from '../engine/scoring.js';
import {
  buildLeagueConfig,
  initDraftPricing,
  computeMyRosterState,
  computeLiveRatesByPosition,
  computeRecommendation,
  computeUndraftedPool,
  computeTierInfo,
  recomputeWithScoringRules,
  recommendBestAvailable,
  recommendTopAvailable,
  computeActiveRunPosition,
  computeTierRemainingCounts,
  computeTeamRanking,
  computeStarterOnlyRanking,
  pickHeadlineRecommendation,
  DEFAULT_ROSTER_SLOTS,
  DEFAULT_FLEX_ELIGIBLE,
} from '../engine/liveDraftState.js';

// Side panel's three-tab snake view: "Best Available" (pure value, no
// roster filter), "Best Fit" (need-filtered, positions with an open slot
// only), and "Draft Rank". Bumped from 10 to 15 (real user feedback: the
// panel had visibly unused vertical space) — deliberately not further than
// that: by ~15-20 deep, "Best Available" in particular is mostly
// replacement-level players nobody would seriously consider over the
// top of the list, so more rows would mean more scrolling for
// diminishing signal rather than genuinely more useful depth.
const SNAKE_LIST_COUNT = 15;

const SCORABLE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DST', 'K'];

const MAX_EVENTS = 500;
const events = [];
const ports = new Set();

// rawPlayers: static, built by scripts/build-projections.js from real
// FantasyPros data — see README.md's "Layer 1 projections" section. Loaded
// once via fetch rather than a JSON module import, since that avoids
// depending on this Chrome version's support for import-assertion syntax in
// a service worker. Each entry carries its own raw per-category stat fields
// (not just basePoints/adjustedPoints) specifically so it can be recomputed
// under a different scoring rules object — see refreshPlayers below.
//
// players: what everything downstream (identity matching, pricing) actually
// reads — either rawPlayers as-is, or rawPlayers recomputed under the user's
// own live scoringRules setting. Real league scoring settings differ per
// league (confirmed for real via elboberto's LeagueInfo tab — see
// leagueScoring.js), so requiring every user to hand-edit
// data/league-config.json and rerun a Node build script isn't usable by
// anyone but a developer editing their own numbers; this is what makes it a
// live side-panel setting instead, same as roster slots and bench budget %.
let rawPlayers = [];
let players = [];
// Kept in sync with `players` — a live scoring-rules edit found a real bug
// during testing: state.playerIdentity[playerId] caches the FULL matched
// player object (including adjustedPoints) at first-match time and is
// deliberately never re-matched afterward ("already resolved" — see
// captureIdentity below), so its own .adjustedPoints goes stale after any
// later scoring-rules/roster change. The $ recommendation already avoided
// this (state.parById is rebuilt fresh on every ensurePricing() call), but
// the broadcast's displayed "proj Npts" was reading straight off the stale
// cached object. Fixed by always looking up the CURRENT player fresh by id
// via this map instead of trusting the cached identity object's own fields
// for anything that can change — see the 'draft-event' handler below.
let playersById = new Map();

function refreshPlayers() {
  players = scoringRules ? recomputeWithScoringRules(rawPlayers, scoringRules) : rawPlayers;
  playersById = new Map(players.map((p) => [p.id, p]));
}

fetch(chrome.runtime.getURL('engine/data/players-2026.json'))
  .then((res) => res.json())
  .then((data) => {
    rawPlayers = data;
    refreshPlayers();
  })
  .catch(() => {
    // rawPlayers/players stay [] — identity resolution below degrades to
    // "unresolved" rather than throwing, same philosophy as the team resolver.
  });

// Real per-position roster requirements, the starter/bench budget split, AND
// scoring rules — all three user-configurable via the side panel's settings
// forms (see sidepanel.js) since no reliable DOM source exists on either
// platform for roster slots (see DEFAULT_ROSTER_SLOTS's comment in
// liveDraftState.js), budget-allocation preference was never something a DOM
// could tell us, and scoring rules genuinely differ by real league (see
// above). Persisted in chrome.storage.local so they're remembered across
// sessions instead of re-entered every draft; chrome.storage.onChanged picks
// up edits live, from this or any future settings surface, and forces PAR
// (and, for scoring rules, basePoints/adjustedPoints themselves) to
// recompute with the new value — changing any of these mid-draft is rare (a
// settings correction, not normal flow) but should still take effect rather
// than keeping a stale baseline.
let rosterSlots = DEFAULT_ROSTER_SLOTS;
let benchBudgetShare = 0; // 0 = spend everything on the starting lineup, matching SPEC.md's stated objective and this value's default in buildLeagueConfig
let scoringRules = null; // null = use players-2026.json's own precomputed basePoints/adjustedPoints as-is (the build-time defaults)
// ESPN/Yahoo have no live signal for auction-vs-snake (no non-budget identity
// path exists for either — see identity.js/resolveTeamIds' comment), so this
// is a manual side-panel toggle like the three settings above, not
// auto-detected. Sleeper's own poller (a separate, later piece of work) sets
// a tab's state.isSnake directly from the polled draft's own `type` field
// instead of reading this — see getTabState below — since that's a real,
// per-draft, no-guessing signal this global toggle can't be for ESPN/Yahoo.
let manualSnakeMode = false;
// A matched team's own saved draft_type ('snake' | 'auction' — already a
// real column, already fetched into TEAM_FIELDS — see team-match.js) beats
// the manual toggle whenever one's available: it's per-league, entered once
// on the website, and exactly what the "don't make me check a box every
// time" ask wanted. Falls back to the manual toggle for ESPN/Yahoo tabs with
// no matched team at all. Deliberately NOT applied to Sleeper — Sleeper's
// own live poller already reports the real draft.type directly (strictly
// better ground truth than a possibly-stale saved value), so its isSnake
// assignment (see the 'sleeper-draft-id' handler) stays untouched by this.
function effectiveIsSnake(matchedTeam, fallback) {
  return matchedTeam?.draft_type ? matchedTeam.draft_type === 'snake' : fallback;
}
// Whether the generic manual FLEX slot accepts TE (the common "W/R/T"
// flex) or only RB/WR ("W/R" — some leagues, especially ones with a
// separate TE-eligible slot elsewhere, restrict FLEX this way). Same
// manual-fallback/matched-team precedence as rosterSlots — see
// computeEffectiveFlexEligible. Sleeper's own live-fetched settings don't
// distinguish flex TYPE yet (only a slot COUNT — see
// mapSleeperRosterSlots' own comment), so there's no auto-detected middle
// tier for this one the way there is for roster slot counts/scoring.
let flexIncludesTe = true;

// The side panel's scoring form only covers the ~17 scalar rule fields (not
// pointsAllowedTiers or gamesPerSeason — see sidepanel.html) — merging with
// DEFAULT_SCORING_RULES here means a saved value missing those fields (or
// any future field) still produces a complete, correct rules object rather
// than leaving them `undefined` and silently breaking computeLeaguePoints'
// arithmetic for whichever position uses them.
function mergedScoringRules(saved) {
  return saved ? { ...DEFAULT_SCORING_RULES, ...saved } : null;
}

chrome.storage.local
  .get(['rosterSlots', 'benchBudgetShare', 'scoringRules', 'snakeMode', 'flexIncludesTe'])
  .then(({ rosterSlots: savedSlots, benchBudgetShare: savedShare, scoringRules: savedRules, snakeMode: savedSnakeMode, flexIncludesTe: savedFlexIncludesTe }) => {
    if (savedSlots) rosterSlots = savedSlots;
    if (typeof savedShare === 'number') benchBudgetShare = savedShare;
    if (savedRules) scoringRules = mergedScoringRules(savedRules);
    if (typeof savedSnakeMode === 'boolean') manualSnakeMode = savedSnakeMode;
    if (typeof savedFlexIncludesTe === 'boolean') flexIncludesTe = savedFlexIncludesTe;
    // Real, live bug found and fixed: this whole .get() is async, but a tab
    // can send its first 'team-snapshot' (see getTabState's isSnake:
    // manualSnakeMode default) before this promise resolves — especially
    // right after an extension reload, when a content script already
    // running in an open tab reconnects almost immediately. That tab's
    // isSnake got permanently stamped `false` (the pre-load default) with
    // nothing to ever revisit it, unlike the onChanged listener below (which
    // only fires on a LATER live toggle). Confirmed live: an ESPN snake
    // draft's ranked list silently stopped rendering entirely after
    // reloading the extension mid-draft, even though "Snake draft" was
    // already checked and saved from before the reload. Same fix as
    // onChanged's loop — reapply to whatever tabs already exist by the time
    // this resolves.
    if (typeof savedSnakeMode === 'boolean') {
      for (const state of tabStates.values()) {
        if (state.platform !== 'sleeper') state.isSnake = effectiveIsSnake(state.matchedTeam, manualSnakeMode);
      }
    }
    refreshPlayers();
  });
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area !== 'local' ||
    (!changes.rosterSlots && !changes.benchBudgetShare && !changes.scoringRules && !changes.snakeMode && !changes.flexIncludesTe)
  )
    return;
  if (changes.rosterSlots) rosterSlots = changes.rosterSlots.newValue || DEFAULT_ROSTER_SLOTS;
  if (changes.benchBudgetShare) benchBudgetShare = typeof changes.benchBudgetShare.newValue === 'number' ? changes.benchBudgetShare.newValue : 0;
  if (changes.flexIncludesTe) flexIncludesTe = typeof changes.flexIncludesTe.newValue === 'boolean' ? changes.flexIncludesTe.newValue : true;
  if (changes.scoringRules) {
    scoringRules = mergedScoringRules(changes.scoringRules.newValue);
    refreshPlayers();
  }
  if (changes.snakeMode) {
    manualSnakeMode = Boolean(changes.snakeMode.newValue);
    // Only reassign tabs this toggle actually governs — a Sleeper tab's
    // isSnake comes from its own poller (draft.type), not this global
    // setting, and shouldn't be clobbered by it.
    for (const state of tabStates.values()) {
      if (state.platform !== 'sleeper') state.isSnake = effectiveIsSnake(state.matchedTeam, manualSnakeMode);
    }
  }
  for (const state of tabStates.values()) {
    state.playersWithPAR = null;
    ensurePricing(state);
  }
});

// Per-tab draft state, since more than one draft tab can be open at once
// (true during dev — watched an ESPN and a Yahoo draft simultaneously).
const tabStates = new Map();

// TEMPORARY live-draft diagnostic — not a permanent product surface, to be
// removed once the current "Adams/McLaurin stuck available" investigation
// is resolved. tabStates/players are module-scoped `let`/`const`, which are
// invisible to code typed directly into the service worker's own DevTools
// console (a module's top-level bindings don't attach to `self`/global
// scope, so `tabStates` there throws "not defined" even though this exact
// code is what's running) — this attaches a callable dump to `self` so it
// CAN be reached that way: chrome://extensions → DraftGenius → "service
// worker" → Console tab → type `dgDebug()`.
self.dgDebug = () => {
  const out = [];
  for (const [tabId, state] of tabStates.entries()) {
    out.push({
      tabId,
      platform: state.platform,
      isSnake: state.isSnake,
      seenPickNosSize: state.seenPickNos ? state.seenPickNos.size : null,
      soldEventsCount: state.soldEvents ? state.soldEvents.length : null,
      playerIdentityCount: state.playerIdentity ? Object.keys(state.playerIdentity).length : null,
      // Davante Adams (2133) / Terry McLaurin (5927) — the two specific
      // Sleeper player_ids from this live draft under investigation.
      adamsIdentity: state.playerIdentity ? state.playerIdentity['2133'] : undefined,
      mclaurinIdentity: state.playerIdentity ? state.playerIdentity['5927'] : undefined,
      adamsPickSeen: state.seenPickNos ? [...state.seenPickNos].includes(83) : null,
      mclaurinPickSeen: state.seenPickNos ? [...state.seenPickNos].includes(84) : null,
    });
  }
  const result = { playersLoaded: players.length, tabs: out };
  console.log(JSON.stringify(result, null, 2));
  return result;
};

function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      platform: null,
      soldEvents: [], // [{teamId, price, playerId}] — price stays undefined for snake picks, no bidding
      resolvedTeams: {}, // name -> id
      domTeams: [], // last snapshot from relay-isolated.js
      ownTeamId: null,
      // Auction-vs-snake for this specific tab. Seeded from the global manual
      // toggle at tab-open time (ESPN/Yahoo have no live signal to detect
      // this from); a Sleeper tab's poller overwrites this directly from the
      // draft's own real `type` field once known, ignoring the toggle
      // entirely — see the chrome.storage.onChanged listener above.
      isSnake: manualSnakeMode,
      // Set once a live draft's external league id is matched against one
      // of the user's registered DraftGenius teams (Sleeper only for now —
      // see team-match.js). null until matched (or if the user isn't
      // logged in, or there's no match); ensurePricing prefers this team's
      // own roster/scoring/factor-toggle settings over the shared globals
      // when present. teamMatchStatus mirrors matchTeamByExternalLeagueId's
      // return status ('logged-out'|'auth-failed'|'no-match'|'matched') so
      // the side panel can render the right fallback UI.
      matchedTeam: null,
      teamMatchStatus: null,
      // Sleeper-only: guards against re-running the one-time settings fetch
      // (loadSleeperSettings) on every 'sleeper-draft-id' resend — the
      // content script now resends that message periodically as its own
      // heartbeat (see dom/sleeper.js), which doubles as self-healing if
      // this tab's background state ever got reset (e.g. the service
      // worker was suspended and restarted, wiping tabStates), but a
      // *healthy*, already-initialized tab shouldn't redo the settings
      // fetch + team-match lookup on every single heartbeat.
      sleeperSettingsLoaded: false,
      // Per-tab pick dedup for the recurring 'sleeper-picks-poll' messages
      // (see applySleeperPicks below) — replaces what used to be a closure
      // variable inside sleeper-poll.js's now-removed setInterval; living
      // on state instead means a service-worker restart's fresh (empty) Set
      // correctly triggers a full, harmless resync of already-known picks
      // rather than silently missing new ones.
      seenPickNos: new Set(),
      startingBudget: null,
      budgetPromptSent: false, // avoids re-broadcasting 'needs-starting-budget' on every reresolveTeams() call
      // Whoever is currently up for bid — see withActivePlayerFallback below.
      // Needed because Yahoo's generic clock tick ('C' wire message) carries
      // NO player/team context at all (confirmed live: {"type":"clock",
      // "secondsRemaining":18} and nothing else), unlike ESPN's phase-2 clock
      // tick which does carry teamId/playerId/currentBid. Without this,
      // Yahoo's displayed recommendation only refreshed on actual bid/
      // nomination events — sparse if autobid is doing most of the work —
      // while ESPN's refreshed on every clock tick (~once/second). Confirmed
      // live by the user: "a guy on the clock but nothing from Yahoo."
      activePlayerId: null,
      // Whoever's currently winning/nominating, and the last known price —
      // tracked the same way and for the same reason as activePlayerId
      // above (neither is reliably present on every event, especially
      // Yahoo's bare clock tick), feeding the side panel's nominee card
      // (see buildNomineeSnapshot below). All three reset together on 'sold'.
      activeTeamId: null,
      activePrice: null,
      playerIdentity: {}, // platform playerId -> matched players-2026.json row (no .par)
      // Set once numTeams is known — PAR is a static baseline per SPEC.md,
      // computed once from the full pool, not recomputed as picks happen.
      leagueConfig: null,
      playersWithPAR: null,
      parById: null, // Map: players-2026.json id -> PAR-augmented row
      auctionBaseline: null,
      // Live-fetched from THIS draft's own Sleeper settings (loadSleeperSettings)
      // — real, but previously fetched and then silently discarded (never
      // assigned to state at all). Used in ensurePricing as a middle
      // fallback tier: a matched DraftGenius team's own mapped_roster_slots/
      // mapped_scoring_rules still win when present (a user's deliberate
      // per-team config), but an UNMATCHED Sleeper tab now gets this live
      // draft's real settings instead of silently falling all the way back
      // to the generic global defaults.
      sleeperRosterSlots: null,
      sleeperScoringRules: null,
      // {rosterDiffers, scoringDiffers} | null — set once a matched team's
      // saved settings are compared against this draft's real live-fetched
      // ones (see detectSettingsConflict, called right after both are
      // available).
      settingsConflict: null,
      // roster_id -> real team display name, for the "Draft Rank" tab —
      // Sleeper's own picks carry nothing but a bare roster_id (see
      // mapSleeperRosterNames' own comment).
      sleeperTeamNames: {},
      // Real, live bug found and fixed: content scripts run at
      // document_start, which can fire BEFORE Sleeper's own SPA has
      // written user_id to localStorage — the very first
      // 'sleeper-draft-id' heartbeat can genuinely carry userId: null.
      // resolveSleeperOwnRosterId correctly returns null for that, but
      // league/scoring/roster-slot settings resolve FINE regardless (they
      // don't depend on userId at all) — so the old single sleeperSettingsLoaded
      // guard treated that partial success as "fully done, never retry",
      // permanently locking in ownTeamId: null for the whole draft.
      // Confirmed live: "Best Fit" never filtered anything, diagnostic
      // readout showed "0 of your picks counted" despite real picks made.
      // Fix: retry specifically while ownTeamId is still null, capped so a
      // genuine spectator (not a real participant — resolution will always
      // correctly return null) doesn't refetch forever every heartbeat.
      sleeperOwnTeamAttempts: 0,
    });
  }
  return tabStates.get(tabId);
}

function resolvedNameForId(resolvedTeams, id) {
  for (const [name, teamId] of Object.entries(resolvedTeams)) {
    if (teamId === id) return name;
  }
  return null;
}

function reresolveTeams(state) {
  if (!state.domTeams.length) return;

  // Infer the starting budget from a snapshot taken before any sale — every
  // team's remaining budget at that point IS the starting budget, no
  // assumption needed. If capture happened to start mid-draft (at least one
  // sale already occurred before we ever saw a pre-sale snapshot), that
  // inference is impossible — the pre-capture spending is invisible to us.
  // Previously this silently guessed $200, which quietly corrupted team
  // identity and every dollar figure downstream for any league with a
  // different budget. Now it stays null (pricing/identity that depend on it
  // simply don't start — see ensurePricing()) and asks the side panel to
  // prompt the user for the real value once, via 'set-starting-budget'.
  // Snake drafts have no budget concept at all — never infer one, never
  // prompt for one. (Doing so would also mean resolveTeamIds' own
  // budget-dependent identity heuristic below simply won't resolve ESPN/
  // Yahoo snake teams reliably — a known, real gap, not fixed by this pass;
  // see the plan's non-goals. Sleeper needs no such heuristic at all, since
  // its own picks carry team identity directly.)
  //
  // Real, live bug found and fixed: `state.soldEvents.length === 0` was
  // trusted as "no sale has happened in this draft yet" — true for a tab
  // that's been open since the draft started, but ALSO true for a tab that
  // just reloaded mid-draft (soldEvents starts fresh and empty regardless
  // of how far the real draft has actually progressed). That silently
  // treated team[0]'s CURRENT, already-spent-down remaining budget as if it
  // were the full original budget — tanking auctionBaseline.dollarPerPAR
  // league-wide and floor-clamping every single player's fair value to $1.
  // Confirmed live: reloading mid-auction made the entire Players/Results
  // tabs show every player at $1 regardless of real value. A real signal
  // for "no sale has happened league-wide yet" is available and doesn't
  // depend on trusting our own possibly-stale soldEvents at all: if every
  // team's remaining budget is still identical, nobody's spent anything.
  if (!state.isSnake) {
    if (state.startingBudget === null) {
      const budgets = state.domTeams.map((t) => t.remainingBudget).filter((b) => Number.isFinite(b));
      if (budgets.length && budgets.every((b) => b === budgets[0])) {
        state.startingBudget = budgets[0];
      }
    }
    if (state.startingBudget === null && !state.budgetPromptSent) {
      state.budgetPromptSent = true;
      broadcast({ ts: Date.now(), platform: state.platform, kind: 'needs-starting-budget' });
    }
  }

  const alreadyResolved = { ...state.resolvedTeams };
  if (state.ownTeamId !== null) {
    const ownTeam = state.domTeams.find((t) => t.isOwn) || state.domTeams.find((t) => t.name === 'You');
    if (ownTeam) alreadyResolved[ownTeam.name] = state.ownTeamId;
  }

  state.resolvedTeams = resolveTeamIds({
    ledger: buildSpendLedger(state.soldEvents),
    domTeams: state.domTeams,
    startingBudget: state.startingBudget,
    alreadyResolved,
    numTeams: state.domTeams.length,
  });
}

// Applies a user-supplied starting budget (side panel prompt, triggered by
// 'needs-starting-budget' above) to every tab whose budget is still unknown.
// Not tab-scoped because the side panel's port isn't associated with a
// specific tab (same reason its event feed already merges multiple tabs) —
// in practice there's only ever one draft the user is actively missing a
// budget for at a time.
function applyManualStartingBudget(value) {
  if (!Number.isFinite(value) || value <= 0) return;
  for (const state of tabStates.values()) {
    if (state.isSnake || state.startingBudget !== null || !state.domTeams.length) continue;
    state.startingBudget = value;
    reresolveTeams(state);
    ensurePricing(state);
  }
}

// Applies a manually-picked team (side panel's fallback picker, shown when
// auto-match came back 'no-match') to whichever tab of that platform is
// actually waiting on one — same "not tab-scoped, side panel port isn't
// tied to a specific tab" reasoning as applyManualStartingBudget above.
// Applies newly-seen Sleeper picks (raw array from the content script's
// poll — see dom/sleeper.js) to a tab's state: identity resolution, sold
// events, and a fresh nominee broadcast. Deduped against state.seenPickNos
// (per-tab, survives as long as this tab's state does) rather than trusting
// the caller to only send genuinely-new picks — the content script
// currently sends the full raw array every tick, and re-processing an
// already-applied pick would double-count it in soldEvents.
function applySleeperPicks(state, rawPicks) {
  // Real, live bug found and fixed: `players` (module-level) starts as []
  // and is only populated once its own async fetch resolves — normally
  // fast, but MV3 service workers are suspended after ~30s idle (routine
  // during the natural gaps between picks in a real draft) and wipe EVERY
  // module-level variable, `players` included, when they do. If a
  // 'sleeper-picks-poll' message is processed in the brief window between
  // a fresh wake and that refetch finishing, matchPlayer runs against an
  // EMPTY roster for every pick in that batch — and since state.seenPickNos
  // marks a pick "seen" regardless of whether the match succeeded, that
  // failure is PERMANENT: the pick is never retried again, even after
  // players finishes loading a moment later. Confirmed live: several real
  // picks got stuck showing as available for the rest of a real draft,
  // and — the key tell that ruled out a simple stale-connection issue —
  // refreshing the draft tab did NOT fix it, since state.seenPickNos lives
  // in the service worker, not the page, and survives a tab refresh.
  // Simplest correct fix: don't process (or mark seen) ANY picks while
  // players hasn't loaded yet — just wait for the next poll tick 4s later,
  // by which point it very reliably has.
  if (!players.length) return;

  const fresh = newSleeperPicks(rawPicks, state.seenPickNos);
  let changed = false;
  for (const pick of fresh) {
    state.seenPickNos.add(pick.pickNo);
    // Real, live bug fixed here: without this, state.playerIdentity was
    // never populated for Sleeper picks at all — sale.playerId (Sleeper's
    // own numeric id) never resolved to our internal players-2026.json id,
    // so computeRecommendationAndFactors' soldIds stayed empty forever and
    // drafted players never left the "best available" ranked list
    // (confirmed live, mid-draft: already-picked players kept showing after
    // 5+ real picks). pick.identityHint carries name/team/position straight
    // from Sleeper's own pick metadata (see newSleeperPicks) — matchPlayer
    // is the exact same function ESPN/Yahoo already use for DOM-read
    // identity, just fed a different (still real) source.
    if (pick.identityHint && !state.playerIdentity[pick.playerId]) {
      const match = matchPlayer(pick.identityHint, players);
      if (match) state.playerIdentity[pick.playerId] = match;
    }
    state.soldEvents.push({ teamId: pick.teamId, price: undefined, playerId: pick.playerId });
    changed = true;
  }

  // Real, live bug found and fixed: Sleeper's pick `metadata` (the ONLY
  // source of the picked player's name/team/position — see
  // buildSleeperIdentityHint) can lag a moment behind the pick itself
  // showing up with a player_id, if our poll tick lands in that gap.
  // identityHint above then comes back null, matchPlayer never runs, and
  // — since the pick is already marked seen above (required to avoid
  // double-pushing it to soldEvents every tick) — that pick was never
  // looked at again, even though Sleeper's metadata WAS fully populated by
  // the very next poll. Confirmed live, mid-draft: Jameson Williams stayed
  // "available" in the ranked list for several picks after actually being
  // drafted. Fix: every tick, retry identity resolution (never
  // seenPickNos/soldEvents — those stay exactly-once) for any already-seen
  // pick that still has no resolved identity, using THIS tick's fresh
  // metadata. Cheap (a handful of picks at most, each a plain array scan)
  // and self-limiting — stops retrying the instant it resolves.
  for (const pick of rawPicks) {
    if (!pick || pick.pick_no === undefined) continue;
    if (!state.seenPickNos.has(pick.pick_no)) continue; // not yet seen — handled by `fresh` above, or next tick
    if (!pick.player_id || state.playerIdentity[pick.player_id]) continue;
    const hint = buildSleeperIdentityHint(pick);
    if (!hint) continue;
    const match = matchPlayer(hint, players);
    if (match) {
      state.playerIdentity[pick.player_id] = match;
      changed = true;
    }
  }

  if (!changed) return;
  // Deliberately not calling reresolveTeams here — that function's
  // name/budget-ledger heuristic (resolveTeamIds) exists only because
  // ESPN/Yahoo's wire protocols never state team identity directly.
  // Sleeper's picks already carry real identity via roster_id (used as
  // teamId above), so there's nothing to resolve; state.resolvedTeams just
  // stays empty, and the nominee card's teamName field degrades to null
  // (best-effort display only, not used for matching).
  broadcastNominee('sleeper', buildNomineeSnapshot(state));
}

// Applies ESPN's live pick feed (see readEspnPickFeed/sendEspnPickFeed) to a
// tab's state — the snake-mode counterpart to applySleeperPicks above.
// readEspnPickFeed now reads the Pick History tab's own table, which holds
// the FULL draft (round 1 onward, ever-growing, never evicting) — an earlier
// version read a different element that turned out to be a sliding window
// (only the ~10 most recent picks), which permanently lost every earlier
// pick on any fresh tab state (extension reload, or a routine MV3 service-
// worker restart mid-draft); confirmed live as the cause of a real bug
// report ("top picks have been taken, but they're showing" as available
// right after a reload). Since entries is now the complete history every
// tick, this just reprocesses the whole thing and relies entirely on
// state.playerIdentity[match.id] as the dedup key — correct AND simple for
// both "one new pick since last tick" and "whole draft, first time this tab
// state has ever seen it" without needing to distinguish the two cases.
//
// Unlike Sleeper, there's no external numeric playerId to key
// state.playerIdentity by — matchPlayer's own resolved id is used for both
// state.playerIdentity's key AND soldEvents' playerId, which is fine since
// nothing outside this function ever sees ESPN's snake-mode "playerId" as
// anything but our own internal id.
function applyEspnPickFeed(state, entries, teamNameToId) {
  if (!players.length || !Array.isArray(entries)) return;

  let changed = false;
  for (const entry of entries) {
    const match = matchPlayer({ name: entry.name, team: entry.team, position: entry.position }, players);
    if (!match || state.playerIdentity[match.id]) continue;
    state.playerIdentity[match.id] = match;
    const teamId =
      teamNameToId && Object.prototype.hasOwnProperty.call(teamNameToId, entry.teamName)
        ? teamNameToId[entry.teamName]
        : undefined;
    state.soldEvents.push({ teamId, price: undefined, playerId: match.id });
    changed = true;
  }
  if (!changed) return;
  broadcastNominee('espn', buildNomineeSnapshot(state));
}

function applyManualTeamMatch(platform, team) {
  if (!team) return;
  for (const state of tabStates.values()) {
    // Was strictly `!== 'no-match'` — correct for Sleeper (whose status is
    // always one of null/'no-match'/'matched'/'auth-failed'), but that
    // excluded ESPN/Yahoo tabs entirely: teamMatchStatus stays at its
    // default `null` there forever (nothing ever sets it — no auto-match
    // exists for those platforms), so the picker's selection would have
    // silently done nothing once it started being offered there too (see
    // updateAccountMatchStatus). Anything short of an existing match is
    // fair game to manually (re)pick.
    if (state.platform !== platform || state.teamMatchStatus === 'matched') continue;
    state.matchedTeam = team;
    state.teamMatchStatus = 'matched';
    // ESPN/Yahoo only reach this path (Sleeper auto-matches via its own
    // settings-load block, which leaves isSnake alone — see
    // effectiveIsSnake's comment) — always safe to defer to the matched
    // team's own draft_type here instead of the manual toggle.
    state.isSnake = effectiveIsSnake(team, manualSnakeMode);
    // Same gap as isSnake had: startingBudget only ever came from a live DOM
    // read (state.domTeams[0].remainingBudget, only correct if capture
    // started at the very beginning of the draft) or the manual
    // "couldn't detect the budget" prompt — never from the matched team's
    // own saved budget_per_team, even though that's exactly what a matched
    // team is for. Only fills a budget that's still unknown — never
    // overrides one already detected live or entered manually, and only for
    // auction (state.isSnake here reflects the fix just above, so this runs
    // with the correct mode already known).
    if (!state.isSnake && state.startingBudget === null && Number(team.budget_per_team) > 0) {
      state.startingBudget = Number(team.budget_per_team);
    }
    state.leagueConfig = null;
    state.playersWithPAR = null;
    ensurePricing(state);
    broadcastNominee(platform, buildNomineeSnapshot(state));
  }
}

// "Update my saved team" accept — a REAL, persistent write (see
// updateTeamSettings' own comment), not a one-draft-only override. Always
// writes BOTH fields to this draft's live-fetched values regardless of
// which one(s) actually differed — the field that already matched is a
// harmless no-op write, and it keeps this simple (no partial-field
// bookkeeping to track). Mirrors applyManualTeamMatch's own
// state-mutation/rebroadcast pattern, just async (the write is a real
// network call) and scoped to tabs with an ACTIVE conflict rather than
// every tab on the platform.
async function acceptSettingsConflict(platform) {
  for (const state of tabStates.values()) {
    if (state.platform !== platform || !state.matchedTeam || !state.settingsConflict) continue;
    const mapped_roster_slots = state.sleeperRosterSlots;
    const mapped_scoring_rules = state.sleeperScoringRules;
    const result = await updateTeamSettings(state.matchedTeam.id, { mapped_roster_slots, mapped_scoring_rules });
    if (result.status !== 'ok') continue; // leave settingsConflict as-is — the banner stays up, user can retry
    state.matchedTeam = { ...state.matchedTeam, mapped_roster_slots, mapped_scoring_rules };
    state.settingsConflict = null;
    state.leagueConfig = null;
    state.playersWithPAR = null;
    ensurePricing(state);
    broadcastNominee(platform, buildNomineeSnapshot(state));
  }
}

// When a live draft is matched to one of the user's registered teams (see
// team-match.js), that team's OWN scoring rules and factor-toggle
// preferences should drive this tab's numbers — computed fresh from
// rawPlayers here rather than touching the shared module-level `players`,
// so it only ever affects this one tab (a simultaneously-open ESPN/Yahoo
// tab must never see a Sleeper team's settings — same reasoning that kept
// this deliberately unapplied before team-matching existed).
//
// Three-tier scoring-rules precedence (matches ensurePricing's identical
// precedence for rosterSlots below, and note this is state-scoped now, not
// just team-scoped — a REAL bug fix): a matched team's own
// mapped_scoring_rules wins when present; otherwise THIS draft's own
// live-fetched Sleeper scoring (state.sleeperScoringRules) — previously
// fetched by loadSleeperSettings and silently discarded, never actually
// used; only as a last resort, the generic global manual setting
// (mirrors refreshPlayers()'s own "no scoring rules set -> use rawPlayers
// as-is" fallback). Pulled out into its own function (not just inlined in
// computeTabPlayers) so buildNomineeSnapshot can surface the SAME real
// value the "Currently used for this draft" banner claims is in effect —
// see effectiveScoringRules below, added for exactly the reason
// effectiveRosterSlots already exists: a real, confirmed user report that
// the Scoring settings form's fields showed completely different numbers
// than what was actually driving this draft, with no way to tell.
function computeEffectiveScoringRules(state) {
  const team = state.matchedTeam;
  return team?.mapped_scoring_rules
    ? { ...DEFAULT_SCORING_RULES, ...team.mapped_scoring_rules }
    : state.sleeperScoringRules || scoringRules;
}

// Two-tier (not three — see flexIncludesTe's own comment on why there's
// no Sleeper-live-detected middle tier yet): a matched team's own
// flex_includes_te wins when explicitly set (a real per-team column, not
// nullable-by-omission the way an unset factor toggle might be — but
// checked with `typeof` anyway rather than `??`, since a matched team row
// predating this feature could still have it as `null`/`undefined`);
// otherwise the generic manual setting.
function computeEffectiveFlexEligible(state) {
  const includesTe =
    typeof state.matchedTeam?.flex_includes_te === 'boolean' ? state.matchedTeam.flex_includes_te : flexIncludesTe;
  return includesTe ? DEFAULT_FLEX_ELIGIBLE : ['RB', 'WR'];
}

function computeTabPlayers(state) {
  const team = state.matchedTeam;
  if (!team && !state.sleeperScoringRules) return players; // fast path: nothing tab-specific to apply, reuse the shared global array

  const base = team
    ? applyFactorToggles(rawPlayers, {
        historicalBiasEnabled: team.historical_bias_enabled,
        injuryDiscountEnabled: team.injury_discount_enabled,
      })
    : rawPlayers; // no matched team -> no per-team factor-toggle preference to apply

  const effectiveScoringRules = computeEffectiveScoringRules(state);
  return effectiveScoringRules ? recomputeWithScoringRules(base, effectiveScoringRules) : base;
}

// PAR needs numTeams (from domTeams) and, for auction, budgetPerTeam (from
// startingBudget) — both observed live, not guessed. Runs once per draft; a
// no-op after. Snake drafts skip the startingBudget gate entirely: PAR
// itself (replacement-level points) doesn't depend on a dollar figure — only
// computeAuctionBaseline's dollarPerPAR does, and that's simply never
// consulted for a snake tab (see computeRecommendationAndFactors). The 0
// passed as budgetPerTeam below is a nominal placeholder, not a real value.
function ensurePricing(state) {
  if (state.playersWithPAR || !state.domTeams.length || !players.length) return;
  if (!state.isSnake && state.startingBudget === null) return;
  // Three-tier rosterSlots precedence: a matched DraftGenius team's own
  // mapped_roster_slots wins when present (a deliberate per-team config);
  // otherwise THIS draft's own live-fetched Sleeper settings
  // (state.sleeperRosterSlots) — real, previously fetched by
  // loadSleeperSettings and silently discarded rather than ever applied
  // (confirmed live: an unmatched, or even a matched-but-stale, Sleeper
  // tab's "Roster settings" panel was showing the generic global defaults
  // instead of the real league's real slots); only as a last resort, the
  // generic global manual setting (unrelated to this specific draft at all
  // — the ESPN/Yahoo/no-detection case).
  state.leagueConfig = buildLeagueConfig({
    numTeams: state.domTeams.length,
    budgetPerTeam: state.isSnake ? 0 : state.startingBudget,
    rosterSlots: state.matchedTeam?.mapped_roster_slots || state.sleeperRosterSlots || rosterSlots,
    benchBudgetShare: state.isSnake ? 0 : benchBudgetShare,
    flexEligible: computeEffectiveFlexEligible(state),
  });
  const { playersWithPAR, auctionBaseline } = initDraftPricing(computeTabPlayers(state), state.leagueConfig);
  state.playersWithPAR = playersWithPAR;
  state.parById = new Map(playersWithPAR.map((p) => [p.id, p]));
  state.auctionBaseline = auctionBaseline;

  // Tier, per position — computed once over the full static pool (same
  // "static, not recomputed as picks happen" discipline PAR itself already
  // follows), restricted to above-replacement players (par > 0). Mirrors a
  // real, already-found bug fix from draftgenius's own rankings page:
  // running tier computation over a full position pool including a long
  // tail of $0 bench players used to inflate the value spread so much that
  // literally every player at a position landed in "tier 1." Uses
  // computeTiers' default tierGapMultiplier — see that function's own
  // comment for the separate, later fix to how the threshold itself is
  // calculated (median gap size, not a multiple of the value std dev,
  // which was itself found to collapse 15-20 players into one tier
  // whenever a position had one huge gap near the top).
  const byPosition = new Map();
  for (const p of playersWithPAR) {
    if (p.par <= 0) continue;
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  state.tierById = new Map();
  for (const pool of byPosition.values()) {
    for (const t of computeTiers(pool)) {
      state.tierById.set(t.id, t.tier);
    }
  }
}

// Message types where the DOM's "currently up for bid" player is reliably
// the SAME player the event's playerId refers to — i.e. no race between the
// two. Deliberately excludes 'sold', since the DOM panel may have already
// advanced to the next nominee by the time that event is processed.
const IDENTITY_CAPTURE_TYPES = new Set(['bid', 'nomination']);

function captureIdentity(state, parsed, activePlayer) {
  if (!activePlayer || parsed.playerId === undefined) return;
  const isClockWithPlayer = parsed.type === 'clock' && parsed.playerId !== undefined;
  if (!IDENTITY_CAPTURE_TYPES.has(parsed.type) && !isClockWithPlayer) return;
  if (state.playerIdentity[parsed.playerId]) return; // already resolved

  const match = matchPlayer(activePlayer, players);
  if (match) state.playerIdentity[parsed.playerId] = match;
}

// Backfills playerId onto a bare clock tick from state.activePlayerId (see
// that field's comment on the tab-state initializer) — ESPN's phase-2 clock
// already carries its own playerId, so this is a no-op there; Yahoo's clock
// never does, so this is what lets Yahoo's recommendation redisplay on every
// tick instead of only on the sparser bid/nomination events themselves. Only
// backfills 'clock' events specifically — deliberately not applied broadly,
// so a genuinely player-less event type never gets a fabricated identity.
function withActivePlayerFallback(state, parsed) {
  if (parsed.playerId !== undefined || parsed.type !== 'clock' || state.activePlayerId === null) return parsed;
  return { ...parsed, playerId: state.activePlayerId };
}

// Same trigger set as captureIdentity — these are the events where we know,
// with confidence, which player is actively being bid on right now.
const RECOMMENDATION_TYPES = IDENTITY_CAPTURE_TYPES;

// Returns { recommendation, factors } | null, given an already-resolved
// activePlayerWithPAR — the shared core behind both computeLiveRecommendation
// (per-event, for the log line) and buildNomineeSnapshot (per-tab "current
// nomination" state, for the side panel's card). Split out so both call
// sites compute this once, the same way, instead of drifting.
//
// `factors` feeds the card's "why this number" panel — see sidepanel.js.
// Every field is a real, already-computed number (or, for tierInfo, a
// capability that already existed in scoring.js — computeTiers/
// computeTierDropoff were built and tested for SPEC.md's tier-dropoff
// signal but had no live consumer until now), not a new guess:
//   errorAdjustment/injuryDiscount — carried straight through from the
//     player object (players-2026.json ships these per player — see
//     build-projections.js — specifically so downstream consumers like this
//     one don't need to redo the calibration lookup). errorAdjustment is the
//     mean-centered version — see historicalErrorAdjustments.js's comment
//     for why centering (not the raw, all-negative measurement) is what
//     actually gets applied.
//   liveRateVsBaselineRatio — how hot/cold the room is running at this
//     position tonight vs. the static preseason fair-value rate. Informational
//     only — computeRecommendation prices off the static baseline, not this,
//     so a hot market is flagged for the user's own judgment rather than
//     silently pushing the number up (see that function's comment).
//   tierInfo — is this the last real option before a cliff, or deep in a
//     flat tier (see computeTierInfo in liveDraftState.js).
function computeRecommendationAndFactors(state, activePlayerWithPAR) {
  if (!state.parById || !state.playersWithPAR) return null;

  const myPicks = state.soldEvents
    .filter((sale) => sale.teamId === state.ownTeamId)
    .map((sale) => {
      const saleMatch = state.playerIdentity[sale.playerId];
      const withPAR = saleMatch ? state.parById.get(saleMatch.id) : null;
      return withPAR ? { position: withPAR.position, price: sale.price } : null;
    })
    .filter(Boolean);
  const myRosterState = computeMyRosterState({ myPicks, leagueConfig: state.leagueConfig });

  const soldIds = new Set(
    state.soldEvents.map((sale) => state.playerIdentity[sale.playerId]?.id).filter((id) => id !== undefined),
  );
  const undraftedPlayers = computeUndraftedPool(state.playersWithPAR, soldIds);

  // Run detection: resolve the last few soldEvents (league-wide, not just
  // the user's own picks) to a position each, via the same
  // playerIdentity -> parById chain myPicks above already uses. Order
  // matches real pick order — soldEvents is pushed to as picks are detected
  // (see applySleeperPicks/the 'sold' DOM handler), never reordered — so a
  // plain slice(-5) is real recent history, not a guess. Computed once here
  // (not duplicated per branch below) since it applies identically to both
  // snake's ranked list AND auction's single nominee — a run is the same
  // "3 of the last 5 real picks, whoever's making them" signal either way,
  // auction's nomination order is just as real a pick sequence as snake's.
  const recentPositions = state.soldEvents.slice(-5).map((sale) => {
    const identity = state.playerIdentity[sale.playerId];
    const withPAR = identity ? state.parById.get(identity.id) : null;
    return withPAR ? withPAR.position : null;
  });
  const hotPosition = computeActiveRunPosition(recentPositions);

  // Snake drafts have no bid/dollar dimension and no single "active nominee"
  // to price against a budget — two ranked lists instead, matching the side
  // panel's two-tab view: recommendationList ("Best Fit") ranks against
  // open roster need, bestAvailableList ("Best Available") is pure value
  // with no roster filter at all. No activePlayerWithPAR needed for either.
  if (state.isSnake) {
    // Tier-cliff underline: how many undrafted players remain in each
    // (position, tier) bucket right now (live, shrinks as the draft
    // happens) — see computeTierRemainingCounts' own comment. state.tierById
    // itself is only set once ensurePricing has run at least once; an empty
    // Map here just means no player ever qualifies as "last in tier" yet.
    const tierRemainingCounts = computeTierRemainingCounts(undraftedPlayers, state.tierById || new Map());

    // Attaches each row's tier (see ensurePricing's tierById comment),
    // whether it's the last player left in that tier (tier-cliff underline
    // — replaces the old "· RB2" text once every tier-mate is gone), and
    // whether its position is in an active run (fire emoji) — small enough
    // to be worth surfacing without cluttering a 10-row list.
    const withTier = (list) =>
      list.map((p) => {
        const tier = state.tierById?.get(p.id) ?? null;
        const remainingInTier = tier !== null ? (tierRemainingCounts.get(`${p.position}|${tier}`) ?? 0) : 0;
        return {
          ...p,
          tier,
          isLastInTier: tier !== null && remainingInTier <= 1,
          isRun: hotPosition !== null && p.position === hotPosition,
        };
      });
    // "Draft Rank" tab: every team's cumulative PAR so far, league-wide —
    // resolves ALL soldEvents (not just the user's own, unlike myPicks
    // above) to {teamId, position, par} triples via the same
    // playerIdentity -> parById chain. Team names come from
    // state.sleeperTeamNames (real display names fetched once per draft —
    // see loadSleeperSettings) when available, falling back to a generic
    // label otherwise. Computes BOTH the "Full Team" and "Starters Only"
    // totals up front and ships both in one row per team — the toggle
    // (per the user's own request) then just picks which field to sort/
    // display by client-side, no extra round-trip needed.
    const salesWithPAR = state.soldEvents.map((sale) => {
      const identity = state.playerIdentity[sale.playerId];
      const withPAR = identity ? state.parById.get(identity.id) : null;
      return withPAR ? { teamId: sale.teamId, position: withPAR.position, par: withPAR.par } : null;
    });
    const starterParByTeam = new Map(
      computeStarterOnlyRanking(salesWithPAR, {
        rosterSlots: state.leagueConfig?.rosterSlots || {},
        flexEligible: state.leagueConfig?.flexEligible,
      }).map((row) => [row.teamId, row.totalPAR]),
    );
    const teamRanking = computeTeamRanking(salesWithPAR).map((row) => ({
      ...row,
      starterPAR: starterParByTeam.get(row.teamId) ?? 0,
      teamName: state.sleeperTeamNames?.[row.teamId] ?? `Team ${row.teamId}`,
      isOwn: row.teamId === state.ownTeamId,
    }));

    // "Position" tab: a TRUE per-position ranking (not the top-15-overall
    // list filtered down, which would show almost nothing for a position
    // that isn't currently "hot") — every undrafted player at that one
    // position, by value, regardless of roster fit. SCORABLE_POSITIONS
    // already covers all six real positions including DST (a real user
    // concern: don't drop K/DST from a general-purpose list just because
    // one particular league doesn't use them — other leagues do).
    const positionLists = {};
    for (const pos of SCORABLE_POSITIONS) {
      positionLists[pos] = withTier(
        undraftedPlayers
          .filter((p) => p.position === pos)
          .slice()
          .sort((a, b) => b.par - a.par)
          .slice(0, SNAKE_LIST_COUNT),
      );
    }

    // Headline "who do I pick" section, per direct request: most drafters
    // just want the decisive answer, not to synthesize it themselves from
    // the ranked list below. Reads straight out of the same Best Fit list
    // already computed here — real, need-aware, PAR-sorted — not a
    // separate computation.
    const recommendationList = withTier(recommendBestAvailable({ undraftedPlayers, myRosterState, count: SNAKE_LIST_COUNT }));
    const headline = pickHeadlineRecommendation(recommendationList);

    return {
      // Raw diagnostic values, not derived — the previous "0 of your picks
      // counted" readout narrowed this down to ownTeamId, but a real fix
      // attempt (item 16, the document_start race) didn't actually resolve
      // it live, meaning either the retry still isn't reaching a real
      // value, OR it resolves to a real-but-WRONG roster_id (a materially
      // different bug the retry fix wouldn't touch at all — it only
      // retries while ownTeamId is null). Exposing both the resolved id
      // AND actual recent picks' real ids side by side is what actually
      // distinguishes those two cases, rather than guessing blind again.
      ownTeamId: state.ownTeamId,
      recentPickTeamIds: state.soldEvents.slice(-5).map((s) => s.teamId),
      headline,
      recommendationList,
      bestAvailableList: withTier(recommendTopAvailable({ undraftedPlayers, count: SNAKE_LIST_COUNT })),
      positionLists,
      teamRanking,
      // Diagnostic readout ("Your roster so far" in the side panel) — real,
      // live gate on whether a position still shows up in "Best Fit".
      // Surfaced directly rather than only implied by the ranked list, so a
      // pick-attribution bug (soldEvents not correctly matching
      // state.ownTeamId) is visible at a glance instead of silently
      // producing a wrong-looking "Best Fit" list with no obvious cause —
      // confirmed live as a real, hard-to-diagnose-blind failure mode.
      openStarterSlots: myRosterState.openStarterSlots,
      myPicksCount: myPicks.length,
      factors: null,
    };
  }

  if (!activePlayerWithPAR) return null;

  const soldWithPAR = state.soldEvents
    .map((sale) => {
      const saleMatch = state.playerIdentity[sale.playerId];
      const withPAR = saleMatch ? state.parById.get(saleMatch.id) : null;
      return withPAR ? { position: withPAR.position, price: sale.price, par: withPAR.par } : null;
    })
    .filter(Boolean);

  // Margined "leave value on the table" max — per direct request, winning
  // at exact fair value is a wash, not a win. See applyValueMargin's own
  // comment for why this is a % of value rather than a flat dollar amount.
  // The verdict compares the room's actual live price against THIS
  // (already-discounted) number, not the raw fair value.
  const recommendation = {
    ...applyValueMargin(computeRecommendation({ activePlayerWithPAR, myRosterState, auctionBaseline: state.auctionBaseline })),
    // Same static fairPrice the Results/Players tabs already show — real
    // feedback: 'no-open-slot' used to hide the $ number entirely, but a
    // full starting lineup doesn't mean this player has no value at all,
    // just that they'd have to go to the bench. Always included (not just
    // for the no-open-slot case) so it's one consistent reference number.
    benchValue: fairPrice(activePlayerWithPAR, state.auctionBaseline),
  };
  const bidVerdict = computeBidVerdict(state.activePrice ?? null, recommendation ? recommendation.maxBid : null);

  // Computed purely for the "market heat" display factor below — NOT fed
  // into the recommendation itself (see computeRecommendation's comment).
  const liveRatesByPosition = computeLiveRatesByPosition({ soldWithPAR, auctionBaseline: state.auctionBaseline, positions: SCORABLE_POSITIONS });

  const tierInfo = computeTierInfo({ activePlayerWithPAR, playersWithPAR: state.playersWithPAR, undraftedPlayers });
  const baselineRate = state.auctionBaseline?.dollarPerPAR || 0;
  const liveRate = liveRatesByPosition[activePlayerWithPAR.position] || 0;
  const liveRateVsBaselineRatio = baselineRate > 0 ? liveRate / baselineRate - 1 : 0;

  return {
    recommendation,
    bidVerdict,
    isRun: hotPosition !== null && activePlayerWithPAR.position === hotPosition,
    factors: {
      errorAdjustment: activePlayerWithPAR.errorAdjustment || 0,
      injuryDiscount: activePlayerWithPAR.injuryDiscount || 0,
      liveRateVsBaselineRatio,
      tierInfo,
    },
  };
}

function computeLiveRecommendation(state, parsed) {
  if (!state.parById || parsed.playerId === undefined) return null;
  const isClockWithPlayer = parsed.type === 'clock' && parsed.playerId !== undefined;
  if (!RECOMMENDATION_TYPES.has(parsed.type) && !isClockWithPlayer) return null;

  const matched = state.playerIdentity[parsed.playerId];
  const activePlayerWithPAR = matched ? state.parById.get(matched.id) : null;
  return computeRecommendationAndFactors(state, activePlayerWithPAR);
}

// Auction's "Players" tab — every undrafted player's fair-value $ price
// (fairPrice — the same static, buyer-independent number the Results tab
// compares actual sales against), ranked overall and split per position.
// Auction has no roster-need filter the way snake's "Best Fit" does (no
// single obviously-relevant "next pick" to filter toward when anyone could
// nominate anyone at any moment) — just value, like snake's "Best
// Available" tab.
function buildAuctionPlayersList(state) {
  if (!state.parById || !state.playersWithPAR || !state.auctionBaseline) return { all: [], byPosition: {} };

  const soldIds = new Set(
    state.soldEvents.map((sale) => state.playerIdentity[sale.playerId]?.id).filter((id) => id !== undefined),
  );
  const undraftedPlayers = computeUndraftedPool(state.playersWithPAR, soldIds);
  const sorted = undraftedPlayers
    .map((p) => ({ ...p, value: fairPrice(p, state.auctionBaseline) }))
    .sort((a, b) => b.value - a.value);

  const byPosition = {};
  for (const pos of SCORABLE_POSITIONS) {
    byPosition[pos] = sorted.filter((p) => p.position === pos).slice(0, SNAKE_LIST_COUNT);
  }

  return { all: sorted.slice(0, SNAKE_LIST_COUNT), byPosition };
}

// Auction's "Results"/"Teams" tabs — a running ledger of every completed
// sale against what that player was actually WORTH (fairPrice: PAR times
// the static per-league dollarPerPAR rate — the same "fair value in a
// vacuum" number the live recommendation itself is built from, not a
// specific bidder's max-bid, which also factors in THEIR remaining budget
// and open slots and would make the same player look like a different
// "value" depending on who bought them). value = recommendedValue - price,
// so positive means a bargain (paid less than fair value) and negative
// means an overpay — same sign convention for the per-team rollup.
// Computed fresh every time (no caching) — soldEvents is short enough
// (at most one league's full draft) that this is cheap, and it keeps this
// immune to any staleness bug a cached version could introduce.
function buildDraftResults(state) {
  if (!state.parById || !state.auctionBaseline) return { results: [], teamDeltas: [] };

  const results = [];
  for (const sale of state.soldEvents) {
    const identity = state.playerIdentity[sale.playerId];
    const withPAR = identity ? state.parById.get(identity.id) : null;
    if (!withPAR || typeof sale.price !== 'number') continue;
    const recommendedValue = fairPrice(withPAR, state.auctionBaseline);
    results.push({
      playerName: withPAR.name,
      position: withPAR.position,
      price: sale.price,
      recommendedValue,
      value: recommendedValue - sale.price,
      teamId: sale.teamId,
      teamName: sale.teamId !== undefined && sale.teamId !== null ? resolvedNameForId(state.resolvedTeams, sale.teamId) : null,
      isOwn: sale.teamId === state.ownTeamId,
    });
  }

  const byTeam = new Map();
  for (const r of results) {
    if (r.teamId === undefined || r.teamId === null) continue;
    const entry = byTeam.get(r.teamId) || { teamId: r.teamId, teamName: r.teamName, totalValue: 0, picks: 0, isOwn: r.isOwn };
    entry.totalValue += r.value;
    entry.picks += 1;
    byTeam.set(r.teamId, entry);
  }
  const teamDeltas = [...byTeam.values()].sort((a, b) => b.totalValue - a.totalValue);

  return { results, teamDeltas };
}

// The side panel's primary view — one persistent card per platform with an
// active nomination, replacing the old "read every scrolling log line"
// experience with "the current player, the key numbers, done" (the user's
// own framing). Rebuilt from scratch on every relevant event rather than
// mutated incrementally, same anti-staleness discipline as playersById
// above: always derive from current state, never trust a cached snapshot.
//
// Deliberately reads state.parById here, NOT the module-level playersById —
// caught live by the mocked verification script before this ever shipped:
// playersById holds the raw (pre-PAR) player objects, so `.par` comes back
// `undefined` there, which silently produced NaN (renders as `null` in
// JSON) for valueCap/maxBid throughout the whole card. state.parById is the
// PAR-augmented, per-tab map — the same source computeLiveRecommendation
// already uses correctly below — and it's kept fresh by the exact same
// chrome.storage.onChanged rebuild that keeps playersById fresh, so there's
// no staleness tradeoff either way; parById is just the actually-correct one.
function buildNomineeSnapshot(state) {
  if (!state.parById) return null;

  // Snake mode: the ranked list doesn't depend on the current nominee's
  // identity resolving at all (recommendBestAvailable ranks the whole
  // undrafted pool, not one player) — so, unlike the auction branch below,
  // this doesn't gate on activePlayerId/identity match. Whoever's "up"
  // (name/team/position) is best-effort display only, shown when it
  // happens to be known.
  if (state.isSnake) {
    const result = computeRecommendationAndFactors(state, null);
    if (!result) return null;
    const identity = state.activePlayerId !== null ? state.playerIdentity[state.activePlayerId] : null;
    const activePlayerWithPAR = identity ? state.parById.get(identity.id) : null;
    return {
      playerName: activePlayerWithPAR ? activePlayerWithPAR.name : null,
      team: activePlayerWithPAR ? activePlayerWithPAR.team : null,
      position: activePlayerWithPAR ? activePlayerWithPAR.position : null,
      ourProjectedPoints: activePlayerWithPAR ? activePlayerWithPAR.adjustedPoints : null,
      theirProjectedPoints: activePlayerWithPAR ? (activePlayerWithPAR.fptsSource ?? null) : null,
      currentPrice: null, // snake has no bidding
      teamName: state.activeTeamId !== null ? resolvedNameForId(state.resolvedTeams, state.activeTeamId) : null,
      recommendation: null,
      headline: result.headline,
      recommendationList: result.recommendationList,
      bestAvailableList: result.bestAvailableList,
      positionLists: result.positionLists,
      teamRanking: result.teamRanking,
      openStarterSlots: result.openStarterSlots,
      myPicksCount: result.myPicksCount,
      ownTeamId: result.ownTeamId,
      recentPickTeamIds: result.recentPickTeamIds,
      // Real applied roster slots for this draft — matched team's own
      // config, else this draft's own live-fetched Sleeper settings, else
      // the generic global default (same precedence as ensurePricing). The
      // side panel's "Roster settings" panel previously always showed the
      // generic global default regardless — a real, confirmed display bug.
      effectiveRosterSlots: state.leagueConfig?.rosterSlots ?? null,
      // Same story, same fix, for Scoring — see computeEffectiveScoringRules's
      // own comment. Real user report: the Roster tab's own banner/form
      // mismatch (fixed alongside this) prompted checking whether Scoring
      // had the identical problem — it did, and worse: no banner existed
      // there at all to even warn a manual edit wouldn't take effect.
      effectiveScoringRules: computeEffectiveScoringRules(state),
      // Same story again — the FLEX checkbox showing a stale/generic
      // value while a matched team's own flex_includes_te actually drives
      // pricing would be the exact same confusing mismatch already fixed
      // for roster slots/scoring above. Only surfaced once a team's
      // actually matched (Sleeper has no live-detected middle tier for
      // this — see computeEffectiveFlexEligible).
      effectiveFlexIncludesTe: state.matchedTeam ? computeEffectiveFlexEligible(state).includes('TE') : null,
      // {rosterDiffers, scoringDiffers} | null — set alongside matchedTeam
      // above whenever this draft's real live-fetched Sleeper settings
      // have drifted from what's saved for the matched team. See
      // detectSettingsConflict's own comment.
      settingsConflict: state.settingsConflict,
      factors: null,
      teamMatchStatus: state.teamMatchStatus,
      matchedTeamName: state.matchedTeam ? state.matchedTeam.league_name : null,
    };
  }

  // Results/Teams tabs need to stay populated whether or not anyone's
  // currently up for bid — unlike the nominee fields below, they don't
  // depend on activePlayerId at all, so this is computed before any of the
  // early returns that used to make the whole snapshot (and therefore the
  // panel) go blank between nominations.
  const { results: draftResults, teamDeltas } = buildDraftResults(state);
  const auctionPlayersList = buildAuctionPlayersList(state);

  if (state.activePlayerId === null) {
    return {
      playerName: null,
      team: null,
      position: null,
      ourProjectedPoints: null,
      theirProjectedPoints: null,
      currentPrice: null,
      teamName: null,
      recommendation: null,
      bidVerdict: null,
      recommendationList: null,
      bestAvailableList: null,
      factors: null,
      isRun: false,
      isLastInTier: false,
      draftResults,
      teamDeltas,
      auctionPlayersList,
    };
  }
  const identity = state.playerIdentity[state.activePlayerId];
  const activePlayerWithPAR = identity ? state.parById.get(identity.id) : null;
  if (!activePlayerWithPAR) {
    return {
      playerName: null,
      team: null,
      position: null,
      ourProjectedPoints: null,
      theirProjectedPoints: null,
      currentPrice: state.activePrice,
      teamName: state.activeTeamId !== null ? resolvedNameForId(state.resolvedTeams, state.activeTeamId) : null,
      recommendation: null,
      bidVerdict: null,
      recommendationList: null,
      bestAvailableList: null,
      factors: null,
      isRun: false,
      isLastInTier: false,
      draftResults,
      teamDeltas,
      auctionPlayersList,
    };
  }

  const result = computeRecommendationAndFactors(state, activePlayerWithPAR);
  return {
    playerName: activePlayerWithPAR.name,
    team: activePlayerWithPAR.team,
    position: activePlayerWithPAR.position,
    ourProjectedPoints: activePlayerWithPAR.adjustedPoints,
    // FantasyPros' own raw FPTS figure — their default scoring assumptions,
    // pre-league-scoring-conversion and pre-bias/injury adjustment. Already
    // captured in players-2026.json (fantasyProsLoader.js's fptsSource
    // field) — no new DOM read needed, unlike the platform's OWN live
    // displayed projection (ESPN/Yahoo may show a third, different number;
    // that still needs a real DOM selector, not yet captured — see README).
    theirProjectedPoints: activePlayerWithPAR.fptsSource ?? null,
    currentPrice: state.activePrice,
    teamName: state.activeTeamId !== null ? resolvedNameForId(state.resolvedTeams, state.activeTeamId) : null,
    recommendation: result ? result.recommendation : null,
    bidVerdict: result ? result.bidVerdict : null,
    recommendationList: null,
    bestAvailableList: null,
    factors: result ? result.factors : null,
    // Same two glyph-level signals the snake ranked list shows inline next
    // to each row's position (🔥 for a run, an underline for a tier cliff)
    // — surfaced here too so the single-nominee auction card gets the same
    // at-a-glance treatment, not just the existing text-only "Market
    // heat"/"Scarcity" rows buried in the "Why this number" panel below.
    isRun: result ? result.isRun : false,
    isLastInTier: result?.factors?.tierInfo?.isLastInTier ?? false,
    draftResults,
    teamDeltas,
    auctionPlayersList,
  };
}

function broadcast(event) {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  for (const port of ports) {
    try {
      port.postMessage({ type: 'event', event });
    } catch (e) {
      // port likely closed; onDisconnect will clean it up
    }
  }
}

// Ephemeral live state, not a historical log entry — deliberately not
// pushed into `events`/MAX_EVENTS. The side panel keeps at most one of
// these per platform (0-2 total, matching the "watch an ESPN and a Yahoo
// draft at once" dev/testing pattern already established elsewhere in this
// project), replacing its card in place rather than appending anything.
function broadcastNominee(platform, nominee) {
  for (const port of ports) {
    try {
      port.postMessage({ type: 'nominee', platform, nominee });
    } catch (e) {
      // port likely closed; onDisconnect will clean it up
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  ports.add(port);
  // Lets a freshly-opened (or reopened) side panel show any already-in-
  // progress nomination immediately, instead of waiting for the next event.
  const nominees = {};
  for (const state of tabStates.values()) {
    if (state.platform) nominees[state.platform] = buildNomineeSnapshot(state);
  }
  port.postMessage({ type: 'init', events, nominees });
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'set-starting-budget') applyManualStartingBudget(Number(msg.value));
    if (msg && msg.type === 'select-team') applyManualTeamMatch(msg.platform, msg.team);
    if (msg && msg.type === 'accept-settings-conflict') acceptSettingsConflict(msg.platform);
  });
  port.onDisconnect.addListener(() => ports.delete(port));
});

// Website -> extension auto-login handoff — real, direct user feedback:
// logging into draftgenius.vercel.app doesn't do anything for the
// extension, which has its own completely separate session (a Chrome
// extension's storage isn't reachable from — or shared with — a website's
// origin at all; there's no automatic inheritance to rely on). Requires
// `externally_connectable` in manifest.json (scoped to the real
// production origin, plus localhost for dev) and a PINNED extension `key`
// there too — Chrome derives a different id per unpacked install path per
// machine otherwise, which would make it impossible for the website to
// know which id to send this to. `sender.origin` is checked here too, not
// just left to the manifest declaration — defense in depth, since this
// handler writes real auth tokens into storage. Two message types:
// 'ping' (does the extension exist / respond at all — no auth implied)
// and 'auth-handoff' (the real payload: the website's own current
// Supabase session, handed over so the user never re-types a password).
const ALLOWED_EXTERNAL_ORIGINS = ['https://draftgenius.vercel.app'];
function isAllowedExternalOrigin(origin) {
  return Boolean(origin) && (ALLOWED_EXTERNAL_ORIGINS.includes(origin) || origin.startsWith('http://localhost'));
}
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || !isAllowedExternalOrigin(sender.origin)) return;
  if (message.type === 'ping') {
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'auth-handoff') {
    const { accessToken, refreshToken, expiresIn, email } = message;
    if (!accessToken || !refreshToken) {
      sendResponse({ ok: false });
      return;
    }
    storeSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: typeof expiresIn === 'number' ? expiresIn : 3600,
      user: { email: email ?? null },
    }).then(() => sendResponse({ ok: true }));
    return true; // keep the async sendResponse channel open
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender.tab) return;
  const state = getTabState(sender.tab.id);

  if (message.type === 'team-snapshot') {
    state.platform = message.platform;
    state.domTeams = message.teams;
    state.ownTeamId = message.ownTeamId;
    reresolveTeams(state);
    ensurePricing(state);
    return;
  }

  if (message.type === 'sleeper-draft-id') {
    state.platform = 'sleeper';
    // The content script resends this message periodically (see
    // dom/sleeper.js) as a heartbeat/self-heal signal, not just once — a
    // *healthy* tab shouldn't redo the settings fetch + team-match lookup
    // on every single resend, only the first time (or after a service-
    // worker restart wiped this tab's in-memory state back to defaults).
    //
    // EXCEPT: keep retrying (up to a cap) while ownTeamId is still null —
    // see sleeperOwnTeamAttempts' own comment on getTabState for the real,
    // confirmed-live bug this fixes (content scripts run at document_start,
    // which can beat Sleeper's own SPA to writing user_id into localStorage
    // — the very first heartbeat can genuinely have nothing to resolve
    // with, even though league/scoring/roster-slot settings resolve fine
    // regardless). Capped so a genuine spectator (never resolves, and
    // correctly so) doesn't refetch every single heartbeat for the whole
    // draft.
    const MAX_OWN_TEAM_ATTEMPTS = 5;
    const stillResolvingOwnTeam = state.ownTeamId === null && state.sleeperOwnTeamAttempts < MAX_OWN_TEAM_ATTEMPTS;
    if (state.sleeperSettingsLoaded && !stillResolvingOwnTeam) return;
    state.sleeperSettingsLoaded = true;

    (async () => {
      // Defensively isolated: an unexpected throw anywhere in here (network
      // hiccup, storage access issue, anything not already handled inside
      // loadSleeperSettings'/matchTeamByExternalLeagueId's own try/catch)
      // must never leave this tab permanently stuck — resetting the guard
      // lets the content script's next heartbeat retry from scratch.
      try {
        const settings = await loadSleeperSettings(message.draftId, message.userId);
        if (!settings) {
          state.sleeperSettingsLoaded = false; // draft/league fetch failed — retry next heartbeat
          return;
        }
        const { isSnake, numTeams, ownRosterId, leagueId, warnings, rosterSlots, scoringRules, rosterNames } = settings;
        state.isSnake = isSnake;
        // Real, live-fetched from THIS draft — see this field's own comment
        // on getTabState. Previously fetched by loadSleeperSettings and then
        // never actually read here; a real bug, not by design (confirmed
        // live: a Sleeper user's own "Roster settings" panel was showing the
        // generic global defaults — QB1/RB2/WR2/TE1/FLEX1/DST1/K1/BENCH6 —
        // instead of their real league's settings).
        state.sleeperRosterSlots = rosterSlots;
        state.sleeperScoringRules = scoringRules;
        state.sleeperTeamNames = rosterNames || {};
        // Confirmed live against a real logged-in session: resolved from
        // localStorage's user_id (read by dom/sleeper.js) via the draft's
        // own draft_order/slot_to_roster_id fields — see
        // resolveSleeperOwnRosterId in engine/parsers/sleeper.js. Stays
        // null (its getTabState default) if that resolution genuinely fails
        // (e.g. viewing a draft you're not a participant in) — or, for the
        // first heartbeat or two, simply because userId wasn't available
        // yet (see sleeperOwnTeamAttempts' comment); count the attempt so
        // the retry above eventually gives up rather than looping forever.
        state.ownTeamId = ownRosterId;
        if (ownRosterId === null) state.sleeperOwnTeamAttempts += 1;
        // No DOM team snapshot exists for Sleeper (see reresolveTeams'
        // isSnake branch — no budget-dependent identity is even attempted
        // here, since Sleeper's own picks already carry real team identity
        // via roster_id). domTeams.length is what ensurePricing/
        // reresolveTeams use throughout as "how many teams, are we ready" —
        // a placeholder array of the right length satisfies that without a
        // parallel signal.
        if (numTeams) state.domTeams = Array.from({ length: numTeams }, () => ({}));
        if (warnings && warnings.length) {
          console.warn(`Sleeper scoring mapping warnings for draft ${message.draftId}:`, warnings);
        }

        // Try to match this draft against one of the user's registered
        // DraftGenius teams (no-op, no network call, if not logged in — see
        // ensureFreshAccessToken). On a match, ensurePricing below applies
        // THAT team's own roster/scoring/factor-toggle settings — scoped to
        // this tab only, never the shared global rosterSlots/scoringRules
        // (which stay untouched, so a simultaneously-open ESPN/Yahoo tab is
        // never affected). No match / not logged in falls back to the
        // shared global settings, same as before this feature existed.
        if (leagueId) {
          try {
            const result = await matchTeamByExternalLeagueId('sleeper', leagueId);
            state.teamMatchStatus = result.status;
            state.matchedTeam = result.status === 'matched' ? result.team : null;
          } catch (err) {
            console.error('Team match lookup threw unexpectedly:', err);
            state.teamMatchStatus = 'auth-failed';
            state.matchedTeam = null;
          }
        }

        // Real, live divergence check, per direct request: a matched
        // team's SAVED settings are what actually drives pricing (see
        // ensurePricing's own three-tier precedence — the matched team
        // wins over these same live-fetched values) — but if this
        // draft's real Sleeper settings have since drifted from what's
        // saved, the drafter should be told, not silently draft off
        // stale numbers. Both sides are already sitting on `state` right
        // here (matchedTeam just above, sleeperRosterSlots/
        // sleeperScoringRules a few lines up) — nothing new to fetch.
        state.settingsConflict = null;
        if (state.matchedTeam) {
          const conflict = detectSettingsConflict({
            savedRosterSlots: state.matchedTeam.mapped_roster_slots,
            liveRosterSlots: state.sleeperRosterSlots,
            savedScoringRules: state.matchedTeam.mapped_scoring_rules,
            liveScoringRules: state.sleeperScoringRules,
          });
          if (conflict.rosterDiffers || conflict.scoringDiffers) state.settingsConflict = conflict;
        }

        state.leagueConfig = null;
        state.playersWithPAR = null;
        ensurePricing(state);
        broadcastNominee('sleeper', buildNomineeSnapshot(state));
      } catch (err) {
        console.error('Sleeper settings load threw unexpectedly:', err);
        state.sleeperSettingsLoaded = false;
      }
    })();
    return;
  }

  if (message.type === 'sleeper-picks-poll') {
    applySleeperPicks(state, message.picks);
    return;
  }

  if (message.type === 'espn-pick-feed') {
    applyEspnPickFeed(state, message.entries, message.teamNameToId);
    return;
  }

  // Retries identity resolution for the CURRENT active player, on the same
  // periodic cadence as sendActivePlayerRetry (relay-isolated.js) — real
  // bug report: a nomination occasionally never showed up in the panel at
  // all, mid-draft. captureIdentity only ever gets ONE shot at resolving a
  // player's name (right at the WS bid/nomination event's own tick), and
  // that DOM read can race the page's own React re-render — a miss there
  // was previously permanent (nothing ever tried again). Same "keep
  // checking until it works" shape as applySleeperPicks' own retry loop for
  // stuck picks, just for auction's single active nominee instead of a
  // list of past picks.
  if (message.type === 'active-player-retry') {
    if (state.activePlayerId === null || state.playerIdentity[state.activePlayerId]) return;
    const match = matchPlayer(message.activePlayer, players);
    if (!match) return;
    state.playerIdentity[state.activePlayerId] = match;
    broadcastNominee(state.platform, buildNomineeSnapshot(state));
    return;
  }

  if (message.type !== 'draft-event') return;
  state.platform = state.platform || message.platform;

  if (message.kind !== 'ws-message') {
    // Only surface non-WS capture events (fetch/xhr/etc.) from the draft
    // platform's own domain. This used to be unconditional ("useful for
    // debugging the capture layer itself"), back when the wire protocols
    // were still being reverse-engineered — now that they're understood and
    // stable, that debug value is gone, and third-party ad/analytics traffic
    // (pbs.yahoo.com, casalemedia.com, criteo.com, rubiconproject.com,
    // seedtag.com, adnxs.com, etc.) was actively hurting usability: confirmed
    // live, a burst of ad-tech fetches was crowding real draft events out of
    // the 500-event ring buffer. Filtered by root domain, not exact host, so
    // Yahoo's/ESPN's own first-party subdomains still come through.
    let isDraftPlatformUrl = false;
    try {
      const host = new URL(message.url || '').hostname;
      isDraftPlatformUrl = host.endsWith('yahoo.com') || host.endsWith('espn.com');
    } catch {
      // malformed/missing URL — treat as noise, not draft-relevant
    }
    if (!isDraftPlatformUrl) return;
    broadcast({ ts: message.ts, platform: message.platform, kind: message.kind, url: message.url, data: message.data });
    return;
  }

  const parser = message.platform === 'espn' ? parseEspnMessage : message.platform === 'yahoo' ? parseYahooMessage : null;
  if (!parser) return;
  const parsed = parser(message.data);

  if (parsed.type === 'sold') {
    state.soldEvents.push({ teamId: parsed.teamId, price: parsed.price, playerId: parsed.playerId });
    reresolveTeams(state);
    // Bidding for this player is over — clear the whole "current nomination"
    // bundle together (see withActivePlayerFallback and buildNomineeSnapshot).
    state.activePlayerId = null;
    state.activeTeamId = null;
    state.activePrice = null;
  } else {
    if ((parsed.type === 'nomination' || parsed.type === 'bid') && parsed.playerId !== undefined) {
      state.activePlayerId = parsed.playerId;
    }
    if (parsed.teamId !== undefined) state.activeTeamId = parsed.teamId;
    // amount (bid) / currentBid (ESPN clock phase 2) / startingBid (Yahoo
    // nomination) — whichever this event actually carries, in that order of
    // recency-meaning; a later, more specific field always wins on its own event.
    if (parsed.amount !== undefined) state.activePrice = parsed.amount;
    else if (parsed.currentBid !== undefined) state.activePrice = parsed.currentBid;
    else if (parsed.startingBid !== undefined) state.activePrice = parsed.startingBid;
  }

  const enrichedParsed = withActivePlayerFallback(state, parsed);

  captureIdentity(state, enrichedParsed, message.activePlayer);

  const teamName = parsed.teamId !== undefined ? resolvedNameForId(state.resolvedTeams, parsed.teamId) : null;
  // Fresh lookup by id (not the cached identity object directly) — see the
  // playersById comment above for why: the cached match's own .adjustedPoints
  // goes stale after a live scoring-rules or roster-slot change.
  const identity = enrichedParsed.playerId !== undefined ? state.playerIdentity[enrichedParsed.playerId] : null;
  const player = identity ? playersById.get(identity.id) || identity : null;
  const liveResult = computeLiveRecommendation(state, enrichedParsed);

  broadcast({
    ts: message.ts,
    platform: message.platform,
    kind: 'parsed',
    parsed,
    teamName,
    playerName: player ? player.name : null,
    playerProjectedPoints: player ? player.adjustedPoints : null,
    recommendation: liveResult ? liveResult.recommendation : null, // { maxBid, reason, valueCap?, budgetCap?, bindingConstraint? } | null
    recommendationList: liveResult ? liveResult.recommendationList : null, // snake mode only — "Best Fit" (need-filtered)
    bestAvailableList: liveResult ? liveResult.bestAvailableList : null, // snake mode only — "Best Available" (pure value)
  });

  broadcastNominee(message.platform, buildNomineeSnapshot(state));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
