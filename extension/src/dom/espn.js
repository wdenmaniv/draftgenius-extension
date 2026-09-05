// DOM reader for ESPN's live auction draft room. Runs as an ordinary
// (isolated-world) content script — reading the DOM doesn't need the page's
// own JS context the way patching WebSocket does, so this doesn't need to be
// a "world": "MAIN" script like capture-main.js.
//
// Selectors below were found and validated live against a real draft:
// `li.picklist--pick` is one row per team; `.team-name` is the display name
// (with a leading "N. " ordinal ESPN adds, stripped here), `.cash` is
// remaining budget. The user's own team's `.content` container additionally
// carries an `auction-pick-component--own` class — confirmed live it's
// unique to that one team regardless of who's nominating/autopicking, so it
// pairs directly with the URL's teamId (readEspnOwnTeamId below) without
// needing any budget/ledger inference for "which team is me."
function readEspnTeams() {
  const items = [...document.querySelectorAll('li.picklist--pick')];
  return items.map((li) => {
    const nameRaw = li.querySelector('.team-name')?.textContent.trim() || '';
    const name = nameRaw.replace(/^\d+\.\s*/, '');
    const cashText = li.querySelector('.cash')?.textContent.trim() || '';
    const remainingBudget = Number(cashText.replace(/[^0-9.-]/g, ''));
    const isOwn = li.querySelector('.content')?.className.includes('auction-pick-component--own') || false;
    return { name, remainingBudget, isOwn };
  });
}

// ESPN's draft URL carries the user's own numeric team id directly —
// ?...&teamId=6&... — so "who am I" never needs DOM/ledger resolution at
// all, only every OTHER team does.
function readEspnOwnTeamId() {
  const match = /[?&]teamId=(\d+)/.exec(location.search);
  return match ? Number(match[1]) : null;
}

// The player currently up for bid — shown in `.player-selected`, confirmed
// live to update in lockstep with the WS CLOCK(phase 2)/BID events' playerId
// (cross-checked two different ways: correlating with the most recent WS
// message, and independently confirming the same numeric id appears in this
// same container's headshot image URL). This is what lets background.js
// build a playerId -> name map without any dedicated identity message ever
// existing on the wire — see relay-isolated.js and matchPlayer.js.
function readEspnActivePlayer() {
  const container = document.querySelector('.player-selected');
  if (!container) return null;
  const name = container.querySelector('.playerinfo__playername')?.textContent.trim();
  const team = container.querySelector('.playerinfo__playerteam')?.textContent.trim();
  const position = container.querySelector('.playerinfo__playerpos')?.textContent.trim();
  if (!name) return null;
  return { name, team, position };
}

// Live pick feed for ESPN's SNAKE draft room. First version of this read
// `li[class*="pick-message__container"]" (the little pick-announcement
// list) — confirmed LIVE, the hard way, mid-draft: that list is a SLIDING
// WINDOW (ESPN keeps only the ~10 most recent picks there, evicting older
// ones), so any tab whose state got wiped (extension reload, or an MV3
// service-worker restart — routine mid-draft) would permanently lose every
// pick before whatever was in that window at the time, even though ESPN's
// own player pool correctly stayed accurate (bug report: "top picks have
// been taken, but they're showing" as available, right after a reload).
//
// This reads the Pick History tab's own table instead —
// `div[class*="pick-history"]` — confirmed live to hold the FULL draft
// (every completed pick, round 1 onward) in the DOM at once, growing only
// (never evicting), and confirmed to keep updating even while the "Players"
// tab is the one actually showing on screen (switched tabs mid-draft and
// watched the row count keep climbing). Solves the sliding-window bug
// outright: a freshly-created tab state gets the ENTIRE draft in one read,
// not just whatever's left in a 10-item window.
function readEspnPickFeed() {
  const container = document.querySelector('div[class*="pick-history"]');
  if (!container) return [];
  const rows = [...container.querySelectorAll('[class*="fixedDataTableRowLayout_rowWrapper"]')];
  return rows
    .map((row) => {
      const cells = [...row.querySelectorAll('.public_fixedDataTableCell_cellContent')];
      // Column order confirmed live: [overall pick #, player, fantasy team,
      // 2025 pts, proj pts, round #] — player is always index 1, team name
      // (plain text, no distinguishing class of its own) is always index 2.
      if (cells.length < 3) return null;
      const playerCell = cells[1];
      const name = playerCell.querySelector('.playerinfo__playername')?.textContent.trim();
      const team = playerCell.querySelector('.playerinfo__playerteam')?.textContent.trim();
      const position = playerCell.querySelector('.positionPill')?.textContent.trim();
      const teamName = cells[2].textContent.trim();
      if (!name) return null;
      return { name, team, position, teamName };
    })
    .filter(Boolean);
}

// Numeric ESPN team id -> display name, read from the Roster panel's own
// team-switcher <select> (`.roster__dropdown select`) — confirmed live this
// exists in BOTH the auction and snake draft rooms, unlike `li.picklist--pick`
// (auction-only), and its option values are the same numeric ids
// readEspnOwnTeamId() reads from the URL's teamId param. Used to turn
// readEspnPickFeed's plain-text team name into the numeric id
// state.soldEvents/state.ownTeamId need to agree on for snake-mode picks.
function readEspnTeamNameToId() {
  const select = document.querySelector('.roster__dropdown select');
  if (!select) return {};
  const map = {};
  for (const option of select.options) {
    if (/^\d+$/.test(option.value)) map[option.textContent.trim()] = Number(option.value);
  }
  return map;
}
