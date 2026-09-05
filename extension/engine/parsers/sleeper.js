// Pure mapping functions translating Sleeper's own public REST API shapes
// (api.sleeper.app/v1/draft/<id> and .../league/<id> — no auth, no
// developer approval; confirmed live against a real in-progress draft) into
// the exact field shapes the engine's liveDraftState.js/leagueScoring.js
// expect. Split out from the chrome-dependent polling glue
// (src/sleeper-poll.js) the same way parseEspnMessage/parseYahooMessage are
// pure and separate from background.js's chrome.runtime wiring — lets this
// be unit tested with plain `node --test`, no chrome mocks needed.
//
// Unlike ESPN/Yahoo (reverse-engineered wire protocols, or DOM scraping),
// this whole file is built from a real, live-fetched response — see
// sleeper.test.js's fixtures for the exact captured values — not a reading
// of Sleeper's own docs. Where a field wasn't exercised by that one real
// league (defense/kicking scoring, non-standard roster slots), that's
// called out explicitly below, same honesty standard as
// draftgenius/src/lib/yahoo/mapSettings.ts.

// Confirmed live: settings.slots_qb/rb/wr/te/flex/bn. slots_def/slots_k
// follow Sleeper's documented naming convention but are NOT yet confirmed
// against a real response — the league this was verified against plays 2QB
// with neither a DST nor a K slot. Falls back to 0 rather than guessing a
// nonzero default.
export function mapSleeperRosterSlots(settings) {
  if (!settings) return null;
  return {
    QB: settings.slots_qb ?? 0,
    RB: settings.slots_rb ?? 0,
    WR: settings.slots_wr ?? 0,
    TE: settings.slots_te ?? 0,
    FLEX: settings.slots_flex ?? 0,
    DST: settings.slots_def ?? 0,
    K: settings.slots_k ?? 0,
    BENCH: settings.slots_bn ?? 0,
  };
}

// pts_allow_X buckets map directly onto the engine's {max, points} tier
// format (see leagueScoring.js's DEFAULT_SCORING_RULES.pointsAllowedTiers
// comment for why tiers are PER-GAME, not season totals — Sleeper's bucket
// names are also per-game: 0 / 1-6 / 7-13 / 14-20 / 21-27 / 28-34 / 35+
// points allowed in a single game).
function mapPointsAllowedTiers(scoring) {
  return [
    { max: 0, points: scoring.pts_allow_0 ?? 0 },
    { max: 6, points: scoring.pts_allow_1_6 ?? 0 },
    { max: 13, points: scoring.pts_allow_7_13 ?? 0 },
    { max: 20, points: scoring.pts_allow_14_20 ?? 0 },
    { max: 27, points: scoring.pts_allow_21_27 ?? 0 },
    { max: 34, points: scoring.pts_allow_28_34 ?? 0 },
    { max: Infinity, points: scoring.pts_allow_35p ?? 0 },
  ];
}

// scoring: a league's raw scoring_settings object from
// GET /v1/league/<league_id>. Returns { scoringRules, warnings } — the
// caller merges scoringRules with DEFAULT_SCORING_RULES for any field this
// couldn't fill in, same as background.js's own mergedScoringRules() does
// for manually-edited settings.
export function mapSleeperScoringToEngine(scoring) {
  if (!scoring) return { scoringRules: {}, warnings: ['No scoring_settings in response'] };

  // Sleeper scores yardage as points-PER-yard (e.g. pass_yd: 0.02); the
  // engine wants yards-PER-point (the inverse) — confirmed real values:
  // pass_yd 0.02 -> 50 yds/pt, rush_yd/rec_yd 0.05 -> 20 yds/pt each.
  const yardsPerPoint = (pointsPerYard) =>
    typeof pointsPerYard === 'number' && pointsPerYard > 0 ? 1 / pointsPerYard : undefined;

  const warnings = [];

  const scoringRules = {
    // Confirmed directly against a real league response.
    passYardsPerPoint: yardsPerPoint(scoring.pass_yd),
    passTd: scoring.pass_td,
    interception: scoring.pass_int,
    rushYardsPerPoint: yardsPerPoint(scoring.rush_yd),
    rushTd: scoring.rush_td,
    receptionPoints: scoring.rec,
    recYardsPerPoint: yardsPerPoint(scoring.rec_yd),
    recTd: scoring.rec_td,
    fumbleLost: scoring.fum_lost,
    extraPoint: scoring.xpm,
    // Defense/special-teams field names follow Sleeper's documented
    // convention, not yet cross-validated against a real non-zero
    // DST-scoring league (the one league this was built against scores no
    // defense at all — every def_*/st_* field read back 0, which confirms
    // the fields EXIST but not that the mapping is semantically right).
    defSack: scoring.sack,
    defInt: scoring.int,
    defFumbleRecovery: scoring.fum_rec,
    defForcedFumble: scoring.st_ff,
    defTd: scoring.def_td,
    defSafety: scoring.safe,
    pointsAllowedTiers: mapPointsAllowedTiers(scoring),
  };

  // The engine's fieldGoal is a single flat per-make value (leagueScoring.js:
  // "FantasyPros doesn't break FG out by distance"), but Sleeper scores field
  // goals per distance bucket (fgm_0_19...fgm_60p). Using the 20-29yd bucket
  // as the flat stand-in is a real approximation, not a confirmed-correct
  // mapping — flagged whenever the league's buckets actually differ from
  // each other (a league scoring every distance the same makes this a
  // no-op simplification instead of a lossy one).
  scoringRules.fieldGoal = scoring.fgm_20_29;
  if (scoring.fgm_0_19 !== scoring.fgm_50_59 || scoring.fgm_20_29 !== scoring.fgm_40_49) {
    warnings.push(
      'Sleeper scores field goals by distance; DraftGenius uses a single flat value (20-29yd bucket) — your real scoring may differ for long or short kicks.',
    );
  }

  if (scoring.def_st_ff !== undefined && scoring.st_ff !== scoring.def_st_ff) {
    warnings.push('Both st_ff and def_st_ff are set to different values — used st_ff for forced fumbles, unconfirmed which one your league actually uses.');
  }

  return { scoringRules, warnings };
}

// Sleeper's draft-room URL is exactly https://sleeper.com/draft/nfl/<id> —
// confirmed live, no redirect, no auth wall for a public draft view.
export function readSleeperDraftIdFromPath(pathname) {
  const match = /\/draft\/nfl\/(\d+)/.exec(pathname || '');
  return match ? match[1] : null;
}

// Solves the "which team is me" gap flagged when this file was first
// written — confirmed live, with a real logged-in session, not guessed:
// the draft room's own localStorage carries the viewer's Sleeper user_id
// directly (`localStorage.getItem('user_id')`, read by dom/sleeper.js — not
// a token/credential, just an account id, same category of non-secret
// identifier as ESPN's own `?teamId=` URL param). That id resolves to a
// real roster_id via two fields already present on the draft object itself:
// draft_order (user_id -> pick slot) and slot_to_roster_id (slot ->
// roster_id) — cross-checked against a real draft: user_id
// "1390452489643368448" (wdenmaniv) -> slot 2 -> roster_id 8, matching the
// draft room's own displayed "1.2" pick position for that team.
export function resolveSleeperOwnRosterId(draft, userId) {
  if (!draft || !userId) return null;
  const slot = draft.draft_order?.[userId];
  if (slot === undefined) return null;
  const rosterId = draft.slot_to_roster_id?.[String(slot)];
  return rosterId === undefined ? null : rosterId;
}

// rosters: raw array from GET /v1/league/<league_id>/rosters (each has
// roster_id + owner_id). users: raw array from GET /v1/league/<league_id>/
// users (each has user_id + display_name, and optionally
// metadata.team_name for a user who's set a custom team name). Returns a
// plain { [roster_id]: displayName } map — the "Draft Rank" tab's only
// source of real team names, since Sleeper draft picks/soldEvents carry
// nothing but a bare numeric roster_id (unlike ESPN/Yahoo, which have a
// live DOM team snapshot with names attached — see reresolveTeams' isSnake
// branch comment on why Sleeper has no equivalent).
export function mapSleeperRosterNames(rosters, users) {
  if (!Array.isArray(rosters) || !Array.isArray(users)) return {};
  const userById = new Map(users.map((u) => [u.user_id, u]));
  const names = {};
  for (const roster of rosters) {
    if (roster.roster_id === undefined) continue;
    const user = roster.owner_id ? userById.get(roster.owner_id) : null;
    names[roster.roster_id] = user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
  }
  return names;
}

// picks: the raw array from GET /v1/draft/<draft_id>/picks. Returns only
// the picks not already in `seenPickNos`, in the shape background.js's
// soldEvents expects — no price (snake has no bidding), teamId is Sleeper's
// own roster_id, which IS real team identity handed to us directly, unlike
// ESPN/Yahoo where it has to be inferred via the budget-dependent
// resolveTeamIds heuristic (see identity.js) that snake drafts have no
// equivalent signal for. pick_no is Sleeper's own monotonic overall-pick
// counter — confirmed present on every real pick object, simpler and more
// robust as a dedup key than reconstructing round/slot ourselves.
//
// Real, live bug found and fixed: without identityHint below, background.js
// had no way to ever populate state.playerIdentity for a Sleeper pick — so
// computeRecommendationAndFactors' soldIds (derived from
// state.playerIdentity[sale.playerId]?.id) stayed empty forever, and
// already-drafted players NEVER got excluded from the "best available"
// ranked list. Confirmed live mid-draft: the side panel kept showing
// already-picked players after 5+ real picks had gone.
//
// A SECOND, separate real bug found the same way (a real user's tip, then
// confirmed directly against Sleeper's own public player database):
// Sleeper reports every team defense's position as "DEF"
// (api.sleeper.app/v1/players/nfl — confirmed live: every real defense
// entry has position: "DEF"), but players-2026.json (built from
// FantasyPros' own convention) uses "DST" throughout. matchPlayer filters
// candidates by position BEFORE comparing names at all, so this mismatch
// meant EVERY Sleeper defense pick, unconditionally, failed to match —
// not a rare timing race like the earlier Olave/Dart/Flowers bug, but a
// 100%-reproducible failure for every single DST pick in every Sleeper
// draft. Normalized here, at the one place Sleeper's raw position code
// enters the system, rather than teaching every downstream consumer
// (matchPlayer, roster-slot bucketing, the ranked lists) to treat "DEF"
// and "DST" as equivalent.
function normalizeSleeperPosition(position) {
  return position === 'DEF' ? 'DST' : position;
}

// Confirmed live: every real pick object embeds the picked player's own
// name/team/position directly in `metadata` — no separate player-lookup
// endpoint needed. Shaped to match matchPlayer()'s own expected input (the
// same function ESPN/Yahoo already use against DOM-read name/team data) so
// background.js can resolve identity with zero new matching logic.
//
// Exported separately (not just inlined into newSleeperPicks below) because
// background.js also calls it on a RETRY pass for already-seen picks — see
// its own comment for the real, live bug that requires that second call.
export function buildSleeperIdentityHint(pick) {
  return pick && pick.metadata
    ? {
        name: `${pick.metadata.first_name || ''} ${pick.metadata.last_name || ''}`.trim(),
        position: normalizeSleeperPosition(pick.metadata.position),
        team: pick.metadata.team,
      }
    : null;
}

export function newSleeperPicks(picks, seenPickNos) {
  if (!Array.isArray(picks)) return [];
  return picks
    .filter((pick) => pick && pick.pick_no !== undefined && !seenPickNos.has(pick.pick_no))
    .map((pick) => ({
      pickNo: pick.pick_no,
      teamId: pick.roster_id,
      playerId: pick.player_id,
      identityHint: buildSleeperIdentityHint(pick),
    }));
}
