// Matches a live draft (known platform + external league id) against the
// user's registered teams on the website, so the extension can apply that
// team's real settings automatically instead of the generic global
// defaults or a manual pick every time.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ensureFreshAccessToken } from './auth.js';

const TEAM_FIELDS =
  'id,league_name,platform,mapped_scoring_rules,mapped_roster_slots,num_teams,budget_per_team,draft_type,historical_bias_enabled,injury_discount_enabled,flex_includes_te';

function teamsUrl(query) {
  return `${SUPABASE_URL}/rest/v1/teams?select=${TEAM_FIELDS}&${query}`;
}

async function fetchTeams(url, accessToken) {
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      // Non-public schema — PostgREST needs this outside the JS SDK's own
      // schema option (see draftgenius's createClient({db:{schema}}) for
      // the equivalent).
      'Accept-Profile': 'draftgenius',
    },
  });
  if (!res.ok) throw new Error(`teams fetch failed: ${res.status}`);
  return res.json();
}

// Returns one of:
//   {status:'logged-out'}   — no fetch attempted at all
//   {status:'auth-failed'}  — token refresh failed (dead session)
//   {status:'no-match'}     — logged in, but no team has this external id
//   {status:'matched', team}
export async function matchTeamByExternalLeagueId(platform, externalLeagueId) {
  const accessToken = await ensureFreshAccessToken();
  if (!accessToken) return { status: 'logged-out' };

  try {
    const rows = await fetchTeams(
      teamsUrl(`platform=eq.${encodeURIComponent(platform)}&external_league_id=eq.${encodeURIComponent(externalLeagueId)}`),
      accessToken,
    );
    if (rows.length === 0) return { status: 'no-match' };
    return { status: 'matched', team: rows[0] };
  } catch {
    return { status: 'auth-failed' };
  }
}

// Broader lookup for the fallback picker (no external-id filter) — every
// team the user has for a given platform, so they can pick manually when
// auto-match comes up empty.
export async function listTeamsForPlatform(platform) {
  const accessToken = await ensureFreshAccessToken();
  if (!accessToken) return { status: 'logged-out', teams: [] };
  try {
    const rows = await fetchTeams(teamsUrl(`platform=eq.${encodeURIComponent(platform)}`), accessToken);
    return { status: 'ok', teams: rows };
  } catch {
    return { status: 'auth-failed', teams: [] };
  }
}

// Persists a settings-conflict "update my saved team" accept (see
// detectSettingsConflict / background.js's 'accept-settings-conflict'
// handler) — a REAL write to the team's row, not a one-draft-only
// override, per direct request: future drafts against this same team
// should use the corrected values too. Same auth/header pattern as
// fetchTeams above; RLS's existing "teams owner all" policy already
// covers UPDATE for the owning user (confirmed against the schema
// migration — no new migration needed for this).
export async function updateTeamSettings(teamId, { mapped_roster_slots, mapped_scoring_rules }) {
  const accessToken = await ensureFreshAccessToken();
  if (!accessToken) return { status: 'logged-out' };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/teams?id=eq.${encodeURIComponent(teamId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Accept-Profile': 'draftgenius',
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ mapped_roster_slots, mapped_scoring_rules }),
    });
    if (!res.ok) throw new Error(`team update failed: ${res.status}`);
    return { status: 'ok' };
  } catch {
    return { status: 'error' };
  }
}
