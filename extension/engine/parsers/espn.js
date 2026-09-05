// Parses ESPN's live auction draft WebSocket protocol — captured live from a
// real mock draft (see ../../README.md). It's not JSON, it's a compact
// space-delimited text protocol. Confidence varies by field: the ones used
// below are cross-checked against what was visible in the draft UI at
// capture time (e.g. NOMINATION's teamId matched the team highlighted "on
// the clock" in the DOM, SOLD's price matched the immediately preceding
// BID's amount). Fields marked "unlabeled" are present in the wire format
// but their meaning wasn't confidently determined from a single capture
// session — worth re-verifying against more samples before relying on them.
//
// Samples this was built against (672 messages captured live, so shapes
// below — including CLOCK's three variants — are validated across the whole
// set, not just a first-glance handful):
//   "BID 2 4429795 45 25000 10000\n"
//   "CLOCK 1 24248 1\n"                (nomination countdown: phase, msRemaining, teamId)
//   "CLOCK 2 9499 2 4429795 45\n"      (bid countdown: phase, msRemaining, teamId, playerId, currentBid)
//   "CLOCK 3 1750\n"                   (phase, msRemaining — no team context; meaning unconfirmed)
//   "NOMINATION 5 25000\n"
//   "SOLD 1 4429795 2 46 0\n"
//   "AUTOSUGGEST 4430807\n"
//   "PONG PING%201786917110373\n"
//
// Snake draft samples (captured live from a real ESPN snake mock draft — a
// genuinely different message set from auction's above, not a variant of
// it; no bidding, so no BID/NOMINATION/SOLD/CLOCK-phase-2 equivalents):
//   "SELECTING 6 30000\n"                                            (turn started: teamId, clockMs — always 30000 across every sample seen)
//   "SELECTED 9 4429025 11\n"                                        (pick made: teamId, playerId, ...)
//   "SELECTED 5 4038941 1 {02FC685B-B902-4CBF-9D8E-7FF8B2D4D2C8}\n"  (same shape, with an extra trailing token on some samples)
// The third SELECTED field (11, 12, 1 across samples) and the occasional
// trailing GUID-looking token aren't returned below — genuinely not
// confidently understood from the handful of samples captured (tried
// "overall pick number": doesn't match the draft's actual pick count at
// capture time; "roster slot" or "position id": unconfirmed either way; the
// GUID appeared on only one of several SELECTED samples, so even its
// presence/absence isn't understood). Worth re-verifying against more
// samples before guessing further, same "don't guess" discipline as the
// auction fields marked unlabeled above.

export function parseEspnMessage(raw) {
  const tokens = String(raw).trim().split(/\s+/);
  const [type, ...rest] = tokens;

  switch (type) {
    case 'BID':
      return {
        type: 'bid',
        teamId: Number(rest[0]),
        playerId: rest[1],
        amount: Number(rest[2]),
        // rest[3], rest[4] — unlabeled, likely clock-related (ms values).
      };
    case 'CLOCK': {
      // Three shapes seen live in auction, distinguished by `phase`:
      //   phase 1 — nomination countdown: has teamId, no player/bid yet
      //   phase 2 — bid countdown: has teamId, playerId, and the current bid
      //   phase 3 — msRemaining only, no team context; meaning not confirmed
      // A fourth shape seen live in a SNAKE draft: phase 4 with NO further
      // tokens at all (no msRemaining, no teamId) — e.g. raw "CLOCK 4\n".
      // Meaning not confirmed (possibly paused/idle/between-pick, specific
      // to snake), only seen once so far. msRemaining is only included when
      // actually present — it used to be set unconditionally via
      // `Number(rest[1])`, which silently produced NaN (renders as `null` in
      // JSON) for this shape instead of honestly omitting a field that
      // genuinely isn't in the wire message.
      const event = { type: 'clock', phase: Number(rest[0]) };
      if (rest.length >= 2) event.msRemaining = Number(rest[1]);
      if (rest.length >= 3) event.teamId = Number(rest[2]);
      if (rest.length >= 5) {
        event.playerId = rest[3];
        event.currentBid = Number(rest[4]);
      }
      return event;
    }
    case 'NOMINATION':
      return {
        type: 'nomination',
        teamId: Number(rest[0]),
        msRemaining: Number(rest[1]),
      };
    case 'SOLD':
      return {
        type: 'sold',
        teamId: Number(rest[0]), // winning team
        playerId: rest[1],
        nominatingTeamId: Number(rest[2]),
        price: Number(rest[3]),
        // rest[4] — unlabeled flag, always seen as 0 so far.
      };
    case 'SELECTING':
      // Snake's equivalent of NOMINATION — no bidding, just "it's teamId's
      // turn to pick, clock started."
      return {
        type: 'selecting',
        teamId: Number(rest[0]),
        msRemaining: Number(rest[1]),
      };
    case 'SELECTED':
      // Snake's equivalent of SOLD — no price, since snake has no bidding.
      // See the file-header comment for why rest[2] (and the occasional
      // trailing GUID-looking token) aren't included here.
      return {
        type: 'picked',
        teamId: Number(rest[0]),
        playerId: rest[1],
      };
    case 'AUTOSUGGEST':
      return { type: 'autosuggest', playerId: rest[0] };
    case 'PONG':
      return { type: 'pong' }; // heartbeat, no draft-state content
    default:
      return { type: 'unknown', raw: String(raw) };
  }
}
