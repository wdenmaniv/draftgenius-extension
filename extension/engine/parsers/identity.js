// Resolves ESPN's numeric team IDs (from the WS protocol) to team display
// names (from the DOM), without needing to catch any particular handshake
// message. Two independent signals, cross-checked live:
//
// 1. A team that hasn't been renamed from ESPN's default shows up in the DOM
//    literally as "Team {id}" — the id IS the number in the name. Confirmed
//    live: the team highlighted "on the clock" in the DOM was named
//    "Team 5", and the WS stream's NOMINATION message at that same moment
//    was `NOMINATION 5 ...` — same id, two independent sources.
// 2. For custom-named teams, correlate a running per-team spend ledger
//    (built from parsed `sold` events) against a DOM snapshot of each team's
//    displayed remaining budget. A team's true id is whichever ledger id
//    makes (startingBudget - spent) equal its displayed remaining budget —
//    unique once enough picks have happened to disambiguate.
// 3. Elimination fallback for when (2) can't get an exact match — see
//    resolveTeamIds below. Needed in practice: validated live against a real
//    8-team draft where capture started mid-draft, so the ledger understated
//    some teams' true spend; 7 of 8 teams resolved cleanly via (1)/(2), and
//    elimination alone correctly placed the 8th.

const DEFAULT_NAME_RE = /^Team (\d+)$/;

export function idFromDefaultName(displayName) {
  const m = DEFAULT_NAME_RE.exec(String(displayName).trim());
  return m ? Number(m[1]) : null;
}

export function buildSpendLedger(soldEvents) {
  const ledger = {};
  for (const e of soldEvents) {
    ledger[e.teamId] = (ledger[e.teamId] || 0) + e.price;
  }
  return ledger;
}

// domTeams: [{ name, remainingBudget }]
// numTeams: total teams in the league — only needed for the elimination pass
// (3) below; omit it to skip that pass.
// Returns { [teamName]: teamId } for whatever could be resolved this pass —
// call again as more sold events accumulate to resolve the rest.
export function resolveTeamIds({ ledger, domTeams, startingBudget, alreadyResolved = {}, numTeams }) {
  const resolved = { ...alreadyResolved };
  const resolvedIds = new Set(Object.values(resolved));

  // Pass 1 — default names resolve immediately, no ledger needed.
  for (const team of domTeams) {
    if (resolved[team.name] !== undefined) continue;
    const defaultId = idFromDefaultName(team.name);
    if (defaultId !== null) {
      resolved[team.name] = defaultId;
      resolvedIds.add(defaultId);
    }
  }

  // Pass 2 — custom names resolve via a unique exact budget match.
  for (const team of domTeams) {
    if (resolved[team.name] !== undefined) continue;
    const candidates = Object.entries(ledger)
      .map(([id, spent]) => [Number(id), spent])
      .filter(([id]) => !resolvedIds.has(id))
      .filter(([, spent]) => startingBudget - spent === team.remainingBudget);
    if (candidates.length === 1) {
      const [id] = candidates[0];
      resolved[team.name] = id;
      resolvedIds.add(id);
    }
  }

  // Pass 3 — elimination. If capture started mid-draft, the ledger
  // understates a team's true total spend (picks made before capture began
  // are invisible to it), which breaks pass 2's exact match even when the
  // mapping is genuinely unambiguous. Confirmed live: in a real draft, one
  // custom-named team's displayed budget didn't match any ledger id exactly
  // for this reason, but it was the only unresolved name left with exactly
  // one unclaimed id — elimination determined it correctly without needing
  // the budget math to agree at all.
  if (numTeams) {
    const unresolvedNames = domTeams.map((t) => t.name).filter((n) => resolved[n] === undefined);
    const unclaimedIds = [];
    for (let id = 1; id <= numTeams; id++) {
      if (!resolvedIds.has(id)) unclaimedIds.push(id);
    }
    if (unresolvedNames.length === 1 && unclaimedIds.length === 1) {
      resolved[unresolvedNames[0]] = unclaimedIds[0];
      resolvedIds.add(unclaimedIds[0]);
    }
  }

  return resolved;
}
