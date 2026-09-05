// Runs in the extension's isolated content-script world (default), so unlike
// capture-main.js it has access to chrome.runtime — but it can't see the page's
// real WebSocket/fetch objects, hence the split. It just relays what capture-main.js
// posts across the world boundary into the extension's background service worker.
//
// Also periodically reads team names/budgets from the DOM (readEspnTeams /
// readYahooTeams — loaded as plain global functions from dom/espn.js and
// dom/yahoo.js earlier in this same manifest entry, so they share this
// script's global scope with no import needed) and forwards that too, since
// identity resolution in background.js needs both the WS-derived ledger and
// this DOM snapshot.
(function () {
  const TAG = '__draftAssistantEvent__';

  const platform = location.hostname.includes('espn.com')
    ? 'espn'
    : location.hostname.includes('yahoo.com')
      ? 'yahoo'
      : location.hostname.includes('sleeper.com')
        ? 'sleeper'
        : 'unknown';

  // The player currently up for bid, read fresh on every WS message — same
  // synchronous tick as the message dispatch, so there's no round-trip
  // latency between the two reads (that latency is what made ad-hoc manual
  // testing of this look racy; production code doesn't have that problem).
  // background.js uses this to build a playerId -> name map, since neither
  // platform's wire protocol ever states a player's name directly.
  function readActivePlayer() {
    if (platform === 'espn') return readEspnActivePlayer();
    if (platform === 'yahoo') return readYahooActivePlayer();
    return null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data[TAG]) return;
    const { kind, platform: eventPlatform, ts, ...rest } = data;
    const activePlayer = kind === 'ws-message' ? readActivePlayer() : null;
    safeSendMessage({ type: 'draft-event', kind, platform: eventPlatform, ts, activePlayer, ...rest });
  });

  function sendTeamSnapshot() {
    let teams, ownTeamId;
    if (platform === 'espn') {
      teams = readEspnTeams();
      ownTeamId = readEspnOwnTeamId();
    } else if (platform === 'yahoo') {
      teams = readYahooTeams();
      ownTeamId = readYahooOwnTeamId();
    } else {
      return;
    }
    if (!teams.length) return; // draft room hasn't rendered yet
    safeSendMessage({ type: 'team-snapshot', platform, teams, ownTeamId, ts: Date.now() });
  }

  // Sleeper needs no team/budget DOM snapshot at all — its own REST API
  // gives background.js that directly (see src/sleeper-poll.js). The draft
  // id is re-checked on the same interval since Sleeper is a client-rendered
  // SPA (a user can navigate from one draft to another without a full page
  // reload, which content_scripts wouldn't re-inject for).
  //
  // Deliberately resent on EVERY tick now, not just when the draft id
  // changes — this doubles as a heartbeat that lets background.js's service
  // worker self-heal. Real, live bug this fixes: MV3 service workers can be
  // suspended after ~30s idle, and background.js used to own the recurring
  // picks-poll setInterval itself — once suspended, that timer was just
  // gone, with nothing to ever restart it (confirmed as the actual cause of
  // "picks stop updating, permanently, until a full reload" — worse than
  // the Cloudflare cache staleness fixed earlier, which was bounded). The
  // picks-poll interval now lives here instead (see startSleeperPicksPoll in
  // dom/sleeper.js) — content scripts have no such suspension lifecycle —
  // and resending this message periodically lets a freshly-woken (or
  // freshly-restarted) background.js re-run its one-time settings/team-match
  // setup on its own; background.js's own idempotency guard
  // (state.sleeperSettingsLoaded) makes repeat sends on an already-healthy
  // tab a cheap no-op.
  let sleeperDraftId = null;
  function sendSleeperDraftId() {
    if (platform !== 'sleeper') return;
    const draftId = readSleeperDraftId();
    if (!draftId) return;
    if (draftId !== sleeperDraftId) {
      sleeperDraftId = draftId;
      startSleeperPicksPoll(draftId);
    }
    const userId = readSleeperUserId();
    safeSendMessage({ type: 'sleeper-draft-id', draftId, userId, ts: Date.now() });
  }

  // ESPN's snake draft room has no WS-adjacent identity source for "who was
  // just picked" (unlike auction's .player-selected, read at the same tick
  // as the BID/NOMINATION event — see readActivePlayer above). Instead this
  // reads the Pick History tab's own table (readEspnPickFeed — the FULL
  // draft, not just recent picks) on the same poll cadence Sleeper's
  // picks-poll already uses, sending the whole current list every tick and
  // letting background.js dedupe by resolved identity (state.playerIdentity)
  // — simpler and racier-proof than trying to correlate this async DOM read
  // with the WS 'picked' event's own tick, and correct on a freshly-created
  // tab state too since there's no "recent window" to have missed anything
  // outside of.
  function sendEspnPickFeed() {
    if (platform !== 'espn') return;
    const entries = readEspnPickFeed();
    if (!entries.length) return;
    const teamNameToId = readEspnTeamNameToId();
    safeSendMessage({ type: 'espn-pick-feed', entries, teamNameToId, ts: Date.now() });
  }

  // Retry hook for a real, live-reported bug: identity capture (see
  // readActivePlayer's own comment) reads the DOM at the SAME tick as the
  // WS nomination/bid event, which is racy in practice — React's own
  // re-render of "who's up" can lag a WS message's own onmessage handler by
  // a beat, especially if the background service worker was suspended and
  // had to wake up first. Before this, that miss was PERMANENT: nothing
  // ever re-read the DOM for that player again, and the nominee card just
  // silently stayed on whatever was up before (or blank) until the NEXT
  // nomination — user report: "mid-draft players are getting nominated and
  // not showing up." Sending a fresh DOM read on this same periodic
  // cadence lets background.js retry identity resolution for the CURRENT
  // active player every ~4s until it resolves, the same "keep checking
  // until it works" pattern applySleeperPicks already uses for stuck picks.
  function sendActivePlayerRetry() {
    if (platform !== 'espn' && platform !== 'yahoo') return;
    const activePlayer = readActivePlayer();
    if (!activePlayer) return;
    safeSendMessage({ type: 'active-player-retry', platform, activePlayer, ts: Date.now() });
  }

  function sendSnapshot() {
    sendTeamSnapshot();
    sendSleeperDraftId();
    sendEspnPickFeed();
  }

  setInterval(sendSnapshot, 4000);
  sendSnapshot();

  // Own, faster interval (not folded into the 4s sendSnapshot above) — per
  // direct request, so a missed nomination gets caught sooner rather than
  // waiting on the same cadence as the team/pick-history polls, which don't
  // need to be this aggressive.
  setInterval(sendActivePlayerRetry, 2000);
  sendActivePlayerRetry();
})();
