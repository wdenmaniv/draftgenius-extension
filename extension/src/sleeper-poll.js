// One-time Sleeper draft/league settings fetch. The RECURRING picks poll
// used to live here too (a setInterval inside this module, called from
// background.js's service worker) — moved out to the content script
// (dom/sleeper.js) after a real, live bug: MV3 service workers can be
// suspended after ~30s of inactivity, and Chrome does not guarantee a plain
// setInterval survives that suspension. Confirmed as the actual root cause
// of "picks stop updating mid-draft, sometimes for good, only a full
// extension reload recovers it" — a Cloudflare CDN cache on the picks
// endpoint (fixed earlier, see the cache-busting query param still used by
// the content script's poll) explained SOME staleness but not a total,
// permanent stall. Content scripts have no such lifecycle — they live
// exactly as long as the tab/page does — so the recurring fetch belongs
// there now; this file just does the one-time settings fetch when a draft
// is first detected, since a one-shot async call isn't vulnerable to the
// same "silently stops forever" failure mode a long-lived interval is.
import {
  mapSleeperRosterSlots,
  mapSleeperScoringToEngine,
  resolveSleeperOwnRosterId,
  mapSleeperRosterNames,
} from '../engine/parsers/sleeper.js';

// Returns { isSnake, numTeams, rosterSlots, scoringRules, ownRosterId,
// leagueId, rosterNames, warnings } | null (null on any fetch failure —
// caller retries via the next 'sleeper-draft-id' resend, since the content
// script keeps sending that periodically as its own SW-wake/resync
// heartbeat).
export async function loadSleeperSettings(draftId, userId) {
  let draft;
  try {
    draft = await fetch(`https://api.sleeper.app/v1/draft/${draftId}`).then((r) => r.json());
  } catch {
    return null;
  }
  if (!draft || !draft.settings) return null;

  // Confirmed live: type is "snake" for a real snake draft. Sleeper also
  // supports "linear" (no snake reversal) and "auction" — only "auction"
  // has a dollar dimension, so anything else routes to the same
  // no-bidding recommendation path as snake.
  const isSnake = draft.type !== 'auction';
  const numTeams = draft.settings.teams ?? null;
  const rosterSlots = mapSleeperRosterSlots(draft.settings);
  // Confirmed live against a real logged-in session and a real draft:
  // userId -> draft_order -> pick slot -> slot_to_roster_id -> roster_id.
  // See resolveSleeperOwnRosterId's own comment for the full chain.
  const ownRosterId = resolveSleeperOwnRosterId(draft, userId);

  let scoringRules = null;
  let warnings = [];
  let rosterNames = {};
  if (draft.league_id) {
    try {
      const league = await fetch(`https://api.sleeper.app/v1/league/${draft.league_id}`).then((r) => r.json());
      const mapped = mapSleeperScoringToEngine(league.scoring_settings);
      scoringRules = mapped.scoringRules;
      warnings = mapped.warnings;
    } catch {
      // scoringRules stays null — background.js falls back to the
      // engine's own DEFAULT_SCORING_RULES, same as an unset manual value.
    }
    // Real team names for the "Draft Rank" tab — Sleeper's picks/soldEvents
    // carry nothing but a bare numeric roster_id (unlike ESPN/Yahoo's live
    // DOM team snapshot), so without this every team would just show as
    // "Team 8", "Team 10", etc. Two separate fetches (rosters -> owner_id,
    // users -> display_name) since that's how Sleeper's API splits this —
    // failure here is non-fatal, same pattern as the scoring fetch above:
    // rosterNames just stays {} and the UI falls back to generic labels.
    try {
      const [rosters, users] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/league/${draft.league_id}/rosters`).then((r) => r.json()),
        fetch(`https://api.sleeper.app/v1/league/${draft.league_id}/users`).then((r) => r.json()),
      ]);
      rosterNames = mapSleeperRosterNames(rosters, users);
    } catch {
      // rosterNames stays {} — Draft Rank falls back to generic "Team N" labels.
    }
  }

  return { isSnake, numTeams, rosterSlots, scoringRules, ownRosterId, leagueId: draft.league_id, rosterNames, warnings };
}
