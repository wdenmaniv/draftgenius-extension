// Parses Yahoo's live auction draft WebSocket protocol — captured live from
// a real mock draft. Pipe-delimited, not JSON (except the `G` message, whose
// payload happens to be JSON). Confidence varies by type: `0`, `D`, `n` are
// cross-checked against each other (e.g. an `n` message's teamId/playerId/
// price for a given pick matched the following `0` message's team/player/
// price exactly, every time). `b` is understood from a single real example
// — this draft's budgets were mostly exhausted by the time capture started,
// so competing bids were rare; worth re-verifying against a draft with more
// active bidding. `L`, `J`, `5`, `6` appeared rarely with single numeric
// payloads and aren't obviously draft-mechanics messages — passed through
// generically rather than guessed at.
//
// Lifecycle observed: D (announce whose turn to nominate) -> n (nomination
// made, starts the bid clock) -> zero or more b (competing bids) -> C
// (generic ticking clock throughout) -> 0 (sale confirmed).
//
// Samples this was built against:
//   "D|145|7|30"           nominate-your-turn: pickNumber, teamId, clockSeconds
//   "n|7|40075|1|20"       nomination made: teamId, playerId, startingBid, clockSeconds
//   "b|1|34036|4|11"       competing bid: teamId, playerId, amount, clockSeconds
//   "C|12"                 generic countdown tick: secondsRemaining
//   "0|145|40075|7|RB|1"   sale confirmed: pickNumber, playerId, teamId, position, price
//   "G|[{...}]"            Yahoo's own pick-quality grade — see parseYahooGrade below
//
// The G message is a notable find: Yahoo already computes its own per-pick
// value grade. Real shape now confirmed live (previously only described
// conceptually) — an array with one object:
//   [{"pickId":51,"score":84.8,"letterGrade":"B+","components":[
//     {"name":"ADP Value","points":4.76,"weight":1,"weighted":4.76,"explanation":"Player fell 3 picks past ADP 47 — good value"},
//     {"name":"VOLS Value","points":12,"weight":1,"weighted":12,"explanation":"VOLS value 8.6 contributes 12.0 points"},
//     {"name":"Availability","points":-3.98,"weight":1,"weighted":-3.98,"explanation":"Passed over better-ranked players (ADP gap 38)"},
//     {"name":"Early Round Bonus","points":0,"weight":0,"explanation":"No early round bonus"},
//     {"name":"Market Mispricing","points":0,"weight":1,"weighted":0,"explanation":"No market mispricing bonus"}
//   ]}]
// "VOLS Value" = value-over-(something), similar in spirit to our own PAR;
// "Availability" = an opportunity-cost penalty for passing over
// better-ranked players. Decided: surfaced in the side panel as a reference
// only (see sidepanel.js), never blended into our own recommendation — PAR
// stays the one real source of truth, more theoretically grounded per the
// earlier "maximize starting-lineup PAR" discussion.

export function parseYahooMessage(raw) {
  const parts = String(raw).split('|');
  const type = parts[0];

  switch (type) {
    case '0':
      return {
        type: 'sold',
        pickNumber: Number(parts[1]),
        playerId: parts[2],
        teamId: Number(parts[3]),
        position: parts[4],
        price: Number(parts[5]),
      };
    case 'D':
      return {
        type: 'nominate-turn',
        pickNumber: Number(parts[1]),
        teamId: Number(parts[2]),
        clockSeconds: Number(parts[3]),
      };
    case 'n':
      return {
        type: 'nomination',
        teamId: Number(parts[1]),
        playerId: parts[2],
        startingBid: Number(parts[3]),
        clockSeconds: Number(parts[4]),
      };
    case 'b':
      return {
        type: 'bid',
        teamId: Number(parts[1]),
        playerId: parts[2],
        amount: Number(parts[3]),
        clockSeconds: Number(parts[4]),
      };
    case 'C':
      return { type: 'clock', secondsRemaining: Number(parts[1]) };
    case 'G':
      return { type: 'pick-grade', grades: parseYahooGrade(parts.slice(1).join('|')) };
    default:
      return { type: 'unknown', raw: String(raw) };
  }
}

// Isolated so a malformed/changed grade payload can't take down message
// parsing generally — grades are supplementary, not load-bearing.
export function parseYahooGrade(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}
