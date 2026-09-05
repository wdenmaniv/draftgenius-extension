// Matches a live-draft player reference (read from the DOM at the moment a
// WS event fires — see relay-isolated.js's activePlayer capture) against the
// FantasyPros dataset. Needed because neither platform's numeric playerId
// means anything outside that platform; the DOM is the only place a live
// pick's name is ever exposed.
//
// Confirmed live on real drafts: Yahoo abbreviates the first name to an
// initial ("D. Maye" for Drake Maye, "M. Evans" for Mike Evans) while ESPN
// and FantasyPros both use full first names. Tries an exact full-name match
// first (handles ESPN, which never abbreviates) before falling back to
// last-name + position, using team as confirmation/tie-break rather than a
// hard filter (team abbreviations aren't guaranteed to match exactly across
// sources — JAX/JAC, WAS/WSH). The fallback is specifically for Yahoo's
// abbreviated form, where an exact match is never possible.
//
// The full-name-first tier matters, not just as an optimization: caught
// live that Bijan Robinson and Brian Robinson Jr. are both real ATL RBs in
// the same dataset — same last name, same team, same first initial. The
// last-name-based fallback alone genuinely cannot tell them apart (correctly
// returns null rather than guess), but ESPN always gives the full name, so
// there's no reason to fall back to the ambiguous path for it.

const TEAM_ALIASES = {
  JAX: 'JAC',
  WAS: 'WSH',
  LA: 'LAR',
};

function normalizeTeam(team) {
  const t = (team || '').trim().toUpperCase();
  return TEAM_ALIASES[t] || t;
}

function normalizeLastName(name) {
  const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (parts.length > 1 && suffixes.has(parts[parts.length - 1].toLowerCase().replace(/\./g, ''))) {
    parts.pop();
  }
  return (parts[parts.length - 1] || '').toLowerCase().replace(/[^a-z]/g, '');
}

function firstInitial(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return (parts[0] || '').charAt(0).toLowerCase();
}

function normalizeFullName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ');
}

// domPlayer: { name, team, position } as read from the live draft room.
// players: the FantasyPros dataset (players-2026.json shape).
// Returns the matched player, or null if there's no candidate or it's
// genuinely ambiguous — an honest "unresolved" is preferable to guessing
// wrong and attributing the wrong player's projection to a live pick.
export function matchPlayer(domPlayer, players) {
  const samePosition = players.filter((p) => p.position === domPlayer.position);

  // Tier 1 — exact full-name match. Only path that can distinguish two
  // same-surname/team/initial players (e.g. Bijan vs. Brian Robinson).
  const fullName = normalizeFullName(domPlayer.name);
  const exactNameMatches = samePosition.filter((p) => normalizeFullName(p.name) === fullName);
  if (exactNameMatches.length === 1) return exactNameMatches[0];
  if (exactNameMatches.length > 1) {
    // Two identically-named players at the same position (rare) — team
    // still helps here.
    const team = normalizeTeam(domPlayer.team);
    const byTeam = exactNameMatches.filter((p) => normalizeTeam(p.team) === team);
    return byTeam.length === 1 ? byTeam[0] : null;
  }

  // Tier 2 — last-name fallback, for Yahoo's abbreviated first-name form,
  // where an exact full-name match is never possible.
  const lastName = normalizeLastName(domPlayer.name);
  if (!lastName) return null;

  const samePosLastName = samePosition.filter((p) => normalizeLastName(p.name) === lastName);
  if (samePosLastName.length === 0) return null;
  if (samePosLastName.length === 1) return samePosLastName[0];

  const team = normalizeTeam(domPlayer.team);
  const sameTeam = samePosLastName.filter((p) => normalizeTeam(p.team) === team);
  const pool = sameTeam.length > 0 ? sameTeam : samePosLastName;
  if (pool.length === 1) return pool[0];

  const initial = firstInitial(domPlayer.name);
  const byInitial = pool.filter((p) => firstInitial(p.name) === initial);
  if (byInitial.length === 1) return byInitial[0];

  return null;
}
