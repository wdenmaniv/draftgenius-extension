// DOM/URL reader (and, below, poller) for Sleeper's draft room. Unlike
// ESPN/Yahoo, Sleeper needs no WebSocket/fetch interception or team/budget
// DOM scraping at all — its own public REST API (api.sleeper.app, no auth)
// already hands over everything needed: settings, roster shape, scoring
// rules (fetched once by src/sleeper-poll.js), and every pick as it happens
// (polled recurringly right here — see startSleeperPicksPoll below). The
// two things the API can't tell us unprompted — which draft is open, and
// which team is the viewer's own — come from this file's DOM/URL readers.
//
// Confirmed live against a real, in-progress draft: the URL is exactly
// https://sleeper.com/draft/nfl/<draft_id>, no redirect, no auth wall for a
// public draft view.
//
// The regex below is deliberately a literal copy of
// engine/parsers/sleeper.js's readSleeperDraftIdFromPath (the tested source
// of truth for this logic) rather than an import — content scripts here are
// loaded as plain classic scripts sharing global scope (see dom/espn.js's
// header comment), not ES modules, so `export`/`import` isn't available in
// this file the way it is in engine/. Keep the two in sync if this pattern
// ever changes.
function readSleeperDraftId() {
  const match = /\/draft\/nfl\/(\d+)/.exec(location.pathname || '');
  return match ? match[1] : null;
}

// "Which team is me" — confirmed live with a real logged-in session: the
// draft room's own localStorage carries the viewer's Sleeper user_id
// directly under the key 'user_id'. Not a token/credential (those keys read
// back BLOCKED when inspected — correctly so), just an account id, the same
// category of non-secret identifier as ESPN's own `?teamId=` URL param.
// background.js resolves this to a real roster_id via the draft's own
// draft_order/slot_to_roster_id fields — see
// engine/parsers/sleeper.js's resolveSleeperOwnRosterId (tested against
// this exact real id).
//
// Real, live bug found and fixed: the raw stored value is JSON-encoded —
// confirmed directly via DevTools console on a real draft:
// localStorage.getItem('user_id') returns the STRING `"1390452489643366448"`
// (with literal embedded quote characters), not the bare digit string this
// originally assumed. draft_order's real keys are the bare digits, so
// looking a quoted string up against it always missed — permanently
// locking ownTeamId at null for the entire draft (myPicks then always
// empty, "Best Fit" never filtering anything). Strip a single surrounding
// quote pair directly rather than JSON.parse — these ids are 19-digit
// numbers, well past Number.MAX_SAFE_INTEGER, so parsing through JSON
// would silently round-trip the value through a float and corrupt its
// precision (a subtly WRONG id is worse than an honestly-missing one).
function readSleeperUserId() {
  try {
    const raw = localStorage.getItem('user_id');
    if (raw === null) return null;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
    return raw; // already bare (or some other shape) — use as-is rather than guessing further
  } catch {
    return null; // storage access can throw in some contexts — degrade, don't crash
  }
}

// The recurring picks poll — deliberately lives HERE (content script), not
// in background.js's service worker. Real, live bug this fixes: MV3 service
// workers can be suspended after ~30s of inactivity, and Chrome does not
// guarantee a plain setInterval survives that — confirmed as the actual
// cause of "picks stop updating mid-draft, sometimes permanently, only a
// full extension reload recovers it." Content scripts have no such
// lifecycle; they live exactly as long as the tab/page does, so the
// recurring fetch belongs here. background.js just consumes the raw picks
// array via the 'sleeper-picks-poll' message and does its own dedup
// (state.seenPickNos) — sending the full array every tick rather than
// pre-filtering here keeps the filtering logic in one tested place
// (engine/parsers/sleeper.js's newSleeperPicks) instead of duplicated into
// this classic (no-import) script.
//
// The cache-busting query param defeats a real, confirmed Cloudflare cache
// on this endpoint (`cache-control: public, s-maxage=15,
// stale-while-revalidate=300`) — without it, a freshly-made pick could sit
// invisible behind that shared cache for a real, visible stretch of time.
// Comfortably within Sleeper's own 1000-calls/minute guidance (this adds up
// to ~15 calls/minute per open draft tab).
// A stale content script (chrome.runtime.sendMessage throwing "context
// invalidated" — see safeSendMessage below) used to fail COMPLETELY
// SILENTLY once the error-spam was fixed there. Real, live bug found:
// with zero visible signal, a user's picks silently stopped updating for
// the rest of a real draft — every player picked after an extension
// update (without also refreshing the draft tab) just stayed "available"
// forever, discovered only because several drafted players kept showing
// up in the ranked list. The extension's own side panel can't show
// anything either — it's equally disconnected from this exact tab. A
// one-time, unmissable banner injected directly onto the draft page
// itself is the fix: shown once per page load, tells the user exactly
// what happened and gives them a one-click way to fix it.
let reconnectBannerShown = false;
function showReconnectBanner() {
  if (reconnectBannerShown) return;
  reconnectBannerShown = true;
  try {
    const banner = document.createElement('div');
    banner.textContent = 'DraftGenius extension was updated — refresh this page to reconnect it. ';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;' +
      'padding:10px 16px;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);';
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh now';
    refreshBtn.style.cssText =
      'margin-left:8px;padding:4px 10px;border-radius:6px;border:none;background:#fff;color:#111;' +
      'font-weight:700;cursor:pointer;font-size:13px;';
    refreshBtn.addEventListener('click', () => location.reload());
    banner.appendChild(refreshBtn);
    document.documentElement.appendChild(banner);
  } catch {
    // if even this fails, there's nothing more to do — the underlying
    // sendMessage failure is still safely swallowed by the caller either way
  }
}

// chrome.runtime.sendMessage throws SYNCHRONOUSLY (not just an async
// rejection) once this content script's extension context has been
// invalidated — confirmed live: reloading/updating the extension from
// chrome://extensions while a matching draft tab is already open leaves
// the OLD content script injected but disconnected, and every send from it
// throws before a .catch() even attaches. That old script is dead until
// the tab itself reloads — nothing to recover from here — so this shows
// the one-time banner above instead of letting it spam the console as an
// uncaught error on every poll tick (the original problem) OR fail with
// zero visible signal at all (the regression the banner now fixes).
// Defined here (loaded before relay-isolated.js per manifest.json's
// content_scripts order) since both files need it and content scripts
// share global scope (see this file's header comment on why there's no
// import/export).
function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    showReconnectBanner();
  }
}

let sleeperPicksPollId = null;
function startSleeperPicksPoll(draftId) {
  if (sleeperPicksPollId !== null) clearInterval(sleeperPicksPollId);

  async function poll() {
    let picks;
    try {
      const res = await fetch(`https://api.sleeper.app/v1/draft/${draftId}/picks?_=${Date.now()}`);
      picks = await res.json();
    } catch {
      return; // transient network hiccup — retried on the next tick
    }
    safeSendMessage({ type: 'sleeper-picks-poll', draftId, picks });
  }

  poll();
  sleeperPicksPollId = setInterval(poll, 4000);
}
