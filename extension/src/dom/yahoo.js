// DOM reader for Yahoo's live auction draft room ("draftclient" app). Same
// deal as espn.js — ordinary isolated-world content script, no MAIN world
// needed for DOM reads.
//
// Selectors found and validated live: `tr.ys-team` is one row per team, with
// 4 cells — [0] the team's current active bid (blank unless they're the one
// bidding right now), [1] display name, [2] remaining budget, [3] roster
// fill ("13/15"). Own team shows as the literal string "You", not a real
// name — resolved separately below via the URL, not the DOM/ledger, same
// reasoning as ESPN's teamId query param.
function readYahooTeams() {
  const rows = [...document.querySelectorAll('tr.ys-team')];
  return rows.map((row) => {
    const cells = [...row.children];
    const name = cells[1]?.textContent.trim() || '';
    const budgetText = cells[2]?.textContent.trim() || '';
    const remainingBudget = Number(budgetText.replace(/[^0-9.-]/g, ''));
    return { name, remainingBudget };
  });
}

// Yahoo's draftclient URL is /draftclient/f1/<leagueId>/<teamId>?auth=... —
// the trailing path segment before the query string is the user's own team id.
function readYahooOwnTeamId() {
  const segments = location.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const id = Number(last);
  return Number.isFinite(id) ? id : null;
}

const POSITION_CODES = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DEF']);

// The player currently up for bid. Confirmed live to update in lockstep with
// the WS `n`/`b` events' playerId. Yahoo uses build-hashed atomic CSS classes
// (e.g. "_ys_1o5vjbq") with no stable semantic names, unlike ESPN — so this
// finds the bidding panel structurally (via the "Offer $N" button, which IS
// stable text) and reads its leaf text nodes positionally: [0] name
// (abbreviated to a first initial — "D. Maye", not "Drake Maye" — matchPlayer.js
// handles that), [1] position, [2] team. Confirmed this order live across
// multiple different players/positions.
function readYahooActivePlayer() {
  const offerBtn = [...document.querySelectorAll('button')].find((el) => /^Offer \$/.test(el.textContent.trim()));
  if (!offerBtn) return null;
  let node = offerBtn;
  for (let i = 0; i < 4 && node; i++) node = node.parentElement;
  if (!node) return null;
  const leaves = [...node.querySelectorAll('*')]
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent.trim())
    .filter(Boolean);
  const [name, position, team] = leaves;
  if (!name || !POSITION_CODES.has(position)) return null; // sanity check against layout drift
  return { name, team, position };
}
