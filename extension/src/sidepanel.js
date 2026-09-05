import { DEFAULT_ROSTER_SLOTS } from '../engine/liveDraftState.js';
import { DEFAULT_SCORING_RULES } from '../engine/projections/leagueScoring.js';
import { login, logout, getStoredEmail } from './auth.js';
import { listTeamsForPlatform } from './team-match.js';

// Real, live bug found and fixed: `ports` in background.js is a
// module-level `const ports = new Set()` — exactly like `players` and
// `tabStates` elsewhere in that file, it gets wiped every time the MV3
// service worker is suspended (routine during the natural quiet gaps
// between picks) and restarted. Draft STATE self-heals on the very next
// poll tick either way (background.js always reprocesses the full picks
// history, not just new ones), but this port connection does not — the
// side panel's `port` object here was still technically "open" from its
// own perspective, yet pointed at a now-defunct service worker instance
// whose fresh, empty `ports` Set never knew this panel existed. Confirmed
// live: two real players (Davante Adams, Terry McLaurin) stayed
// "available" in the ranked list well after being drafted, even though
// background.js's own internal state was already fully correct — only
// reloading the whole extension (which force-recreates this connection)
// fixed it, which isn't something you can ask a user to do mid-draft.
// Fix: reconnect automatically whenever the port disconnects.
// background.js's onConnect handler already sends a fresh, fully correct
// full snapshot ('init') to any newly-connected port — reconnecting here
// gets the panel that same resync without the user touching anything.
let port;
function connectPort() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    setTimeout(connectPort, 500);
  });
}

// Draft/Settings top-level switcher — account/roster/scoring settings used
// to sit permanently above the draft view (three collapsible <details>
// blocks pushing the actual ranked list further down every time). Moved
// into their own view, hidden by default, since they're a "set up once,
// rarely revisit mid-draft" surface — the draft view is what actually
// matters while a draft is live.
const viewTabButtons = document.querySelectorAll('.view-tab');
const settingsViewEl = document.getElementById('settings-view');
const draftViewEl = document.getElementById('draft-view');
function setActiveView(view) {
  settingsViewEl.style.display = view === 'settings' ? 'block' : 'none';
  draftViewEl.style.display = view === 'draft' ? 'block' : 'none';
  for (const btn of viewTabButtons) btn.classList.toggle('active', btn.dataset.view === view);
}
for (const btn of viewTabButtons) {
  btn.addEventListener('click', () => setActiveView(btn.dataset.view));
}

// Account/Roster/Scoring tabs within Settings — was three independently
// expandable <details> accordions, converted to tabs (one panel visible at
// a time) at the user's request. Same pattern as setActiveView above.
const settingsTabButtons = document.querySelectorAll('.settings-tab');
const settingsTabPanels = {
  account: document.getElementById('settings-tab-account'),
  roster: document.getElementById('settings-tab-roster'),
  scoring: document.getElementById('settings-tab-scoring'),
};
function setActiveSettingsTab(tab) {
  for (const [name, panel] of Object.entries(settingsTabPanels)) panel.style.display = name === tab ? 'block' : 'none';
  for (const btn of settingsTabButtons) btn.classList.toggle('active', btn.dataset.settingsTab === tab);
}
for (const btn of settingsTabButtons) {
  btn.addEventListener('click', () => setActiveSettingsTab(btn.dataset.settingsTab));
}

// Feedback — a plain mailto: link rather than a hosted form/API: zero new
// backend, zero new paid service, and guaranteed to land in a real inbox
// (wdenmaniv@gmail.com) via whatever mail client/webmail the user already
// has configured, unlike a stored-in-a-database approach that would need
// someone to remember to go check it. Prefills useful debugging context
// automatically (extension version, which platform(s) have an active
// draft right now) so a bug report doesn't start from zero — `nominees` is
// declared further down this file but already initialized by the time a
// real click can happen, since this only runs on user interaction.
document.getElementById('feedback-btn').addEventListener('click', () => {
  const version = chrome.runtime.getManifest().version;
  const activePlatforms = Object.keys(nominees).join(', ') || 'none';
  const body = [
    'What happened?',
    '',
    '',
    '---',
    `Extension version: ${version}`,
    `Active draft platform(s): ${activePlatforms}`,
  ].join('\n');
  const url = `mailto:wdenmaniv@gmail.com?subject=${encodeURIComponent('DraftGenius feedback')}&body=${encodeURIComponent(body)}`;
  window.open(url);
});

const nomineeCardsEl = document.getElementById('nominee-cards');
const nomineeEmptyEl = document.getElementById('nominee-empty');
const budgetPromptEl = document.getElementById('budget-prompt');
const budgetInputEl = document.getElementById('budget-input');
const budgetSubmitBtn = document.getElementById('budget-submit');
const rosterSaveBtn = document.getElementById('roster-save');
const rosterSavedEl = document.getElementById('roster-saved');
const ROSTER_POSITIONS = Object.keys(DEFAULT_ROSTER_SLOTS);
const scoringSaveBtn = document.getElementById('scoring-save');
const scoringSavedEl = document.getElementById('scoring-saved');
// Only the scalar fields shown in the form — pointsAllowedTiers and
// gamesPerSeason aren't user-editable here (a nested tier array doesn't fit
// this simple form; gamesPerSeason is essentially always 17). Both still
// have real, documented defaults from DEFAULT_SCORING_RULES — background.js
// merges any saved partial value with those defaults, so leaving these out
// of the form never produces a broken/incomplete rules object.
const SCORING_RULE_FIELDS = [
  'passYardsPerPoint',
  'passTd',
  'interception',
  'rushYardsPerPoint',
  'rushTd',
  'receptionPoints',
  'recYardsPerPoint',
  'recTd',
  'fumbleLost',
  'fieldGoal',
  'extraPoint',
  'defSack',
  'defInt',
  'defFumbleRecovery',
  'defForcedFumble',
  'defTd',
  'defSafety',
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The primary view — see README.md's "Nominee card" section. One persistent
// card per platform with an active nomination, keyed and updated in place
// (via background.js's 'nominee' broadcast) rather than appended to like the
// event log below it. `nominees` holds at most one entry per platform;
// background.js sends `nominee: null` to clear one (a sale went through, or
// there's genuinely nothing active yet).
const nominees = {};

function formatPct(ratio) {
  const pct = ratio * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function factorClass(ratio) {
  if (Math.abs(ratio) < 0.005) return 'neutral';
  return ratio < 0 ? 'negative' : 'positive';
}

// Real, live bug found and fixed: this <details> lost its open/closed
// state on every re-render — nomineeCardsEl's innerHTML is fully replaced
// on every nominee update (a new bid, a new nomination), which for an
// active auction happens constantly, so the panel silently snapped back
// to collapsed moments after a user expanded it, before they could
// actually read it. Tracked the same way snakeInfoOpen already tracks the
// snake side's ⓘ panel — keyed by platform, re-applied as the `open`
// attribute on every render, kept in sync via a delegated `toggle`
// listener below (capturing phase, since native <details> `toggle` events
// don't reliably bubble to a delegated ancestor otherwise).
const nomineeFactorsOpen = {};

// The "why this number" panel — every field here is a real computed value
// from background.js's computeRecommendationAndFactors (see that function's
// comment for where each one comes from), not decorative. Collapsed by
// default (a <details> the user can expand), matching the "click in to see
// more about key factors" ask directly.
function renderFactors(factors, recommendation, platform) {
  if (!factors) return '';
  const rows = [];

  // Mean-centered relative bias (see historicalErrorAdjustments.js) — a
  // positive value means FantasyPros has historically been MORE reliable
  // than average at this position, negative means less, both relative to
  // the field, not to some absolute "always right" baseline.
  rows.push(
    `<div class="factor-row"><span class="factor-label">Position bias (historical, relative)</span><span class="factor-value ${factorClass(factors.errorAdjustment)}">${formatPct(factors.errorAdjustment)}</span></div>`,
  );

  rows.push(
    factors.injuryDiscount > 0
      ? `<div class="factor-row"><span class="factor-label">Injury risk</span><span class="factor-value negative">flagged, −${(factors.injuryDiscount * 100).toFixed(0)}%</span></div>`
      : `<div class="factor-row"><span class="factor-label">Injury risk</span><span class="factor-value neutral">not flagged</span></div>`,
  );

  // Informational only — NOT priced into the recommendation above (see
  // computeRecommendation's comment in liveDraftState.js). Flagged so the
  // user can apply their own judgment about whether a run is a real
  // repricing or a temporary spike, rather than the tool silently chasing it.
  rows.push(
    `<div class="factor-row"><span class="factor-label">Market heat at this position (flag only, not priced in)</span><span class="factor-value ${factorClass(factors.liveRateVsBaselineRatio)}">${formatPct(factors.liveRateVsBaselineRatio)} vs. fair value</span></div>`,
  );

  const t = factors.tierInfo;
  if (t) {
    const tierText = t.isLastInTier
      ? `last in tier ${t.tier} of ${t.tierCount} — drop-off ${t.dropoffStdDevs.toFixed(1)} std devs`
      : `tier ${t.tier} of ${t.tierCount}, ${t.remainingInTier} left in tier`;
    rows.push(`<div class="factor-row"><span class="factor-label">Scarcity</span><span class="factor-value ${t.isLastInTier ? 'negative' : 'neutral'}">${escapeHtml(tierText)}</span></div>`);
  }

  if (recommendation && recommendation.reason === 'value') {
    const constraintText = recommendation.bindingConstraint === 'budget' ? "capped by your budget, not his value" : 'capped by his value, not your budget';
    rows.push(`<div class="factor-row"><span class="factor-label">What's binding this number</span><span class="factor-value neutral">${constraintText}</span></div>`);
  }

  return `<details class="nominee-factors"${nomineeFactorsOpen[platform] ? ' open' : ''}><summary>Why this number</summary><div class="factors-list">${rows.join('')}</div></details>`;
}

// Snake mode: no single priced nominee to show — a two-tab ranked list
// instead. "Best Fit" (recommendBestAvailable) filters to positions where
// you still have an open startable slot; "Best Available" (recommendTopAvailable)
// is pure value, no roster filter at all — e.g. useful for a straight
// best-player-available approach, or just seeing who the very best players
// left on the board are regardless of your own roster. Shares the outer
// .nominee-card shell with the auction card (badge/on-the-clock row) but
// replaces the $-max-bid body with the tabbed list.
//
// Per-platform tab selection and info-panel open state live here
// (module-level), not per-render — nomineeCardsEl's innerHTML is fully
// replaced on every update, so both have to survive outside the DOM.
// snakeListTab defaults to 'fit' (the pre-existing single-list behavior,
// before "Best Available" existed).
const snakeListTab = {};
const snakeInfoOpen = {};
// Which position sub-tab is active within the "Position" tab, per
// platform — defaults to QB (SCORABLE_POSITIONS' own order, matched here).
const snakePositionSubTab = {};
// "Full Team" (every pick, per-team cumulative PAR) vs "Starters Only"
// (only the picks that would fill a team's real starting lineup) within
// Draft Rank, per platform — per the user's own request. Defaults to
// 'full', the pre-existing single-metric behavior.
const snakeRankMode = {};

const POSITION_SUB_TABS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

const SNAKE_TAB_EXPLANATION = {
  available: 'Top players by projected value, regardless of position — a straight best-player-available view.',
  fit: 'Top players among positions where you still have an open roster slot to fill.',
  position: 'Every undrafted player at one position, ranked by value — pick a position above to switch.',
  rank: 'Every team ranked by projected value (PAR) of their picks so far — toggle Full Team vs. Starters Only above. Updates live as the draft goes.',
};

// A temporary "your roster so far" / raw-id diagnostic readout lived here —
// built specifically to root-cause a real bug (own picks not correctly
// attributing to open starter slots — see README items 14/16/19) and
// removed once that bug was found, fixed, and confirmed live: the same
// per-position breakdown is already shown on the draft page itself
// (ESPN/Yahoo/Sleeper all show a "QB 0/2 · RB 2/2 · ..." filter row), so it
// was pure redundant clutter once no longer needed for debugging.

// Small inline red medical-cross, per direct request — next to any player
// whose injury-risk discount is CURRENTLY applied. `p.injuryDiscount` is
// already toggle-correct by the time it reaches here: applyFactorToggles
// (wired into background.js's ensurePricing) zeroes it out whenever a
// matched team has the injury-discount toggle off, so this reflects what's
// actually affecting the number on screen right now, not just raw data
// that may not be in play. Plain inline SVG (not an emoji) so the color is
// controllable — reuses the same red already used for the ESPN badge.
function injuryFlagHtml(injuryDiscount) {
  if (!(injuryDiscount > 0)) return '';
  return `<svg class="injury-flag" width="10" height="10" viewBox="0 0 24 24" fill="#ff6b6b" role="img" aria-label="Injury-risk discount applied"><title>Injury-risk discount applied</title><path d="M10 2h4v6h6v4h-6v6h-4v-6H4V8h6z"/></svg>`;
}

// Shared row template for any player-ranking list (Best All, Best Fit, and
// now Position) — pulled out once three call sites needed the identical
// markup instead of copy-pasting it a third time.
function renderPlayerRows(list) {
  return list
    .map(
      (p, i) => `<div class="snake-rec-row">
        <span class="snake-rec-rank">${i + 1}</span>
        <span class="snake-rec-name">${escapeHtml(p.name)}${injuryFlagHtml(p.injuryDiscount)}</span>
        <span class="snake-rec-meta">${escapeHtml(p.team || '')} · <span class="${p.isLastInTier ? 'tier-cliff' : ''}" title="${p.isLastInTier ? 'Last player left in this tier' : `Tier ${p.tier}`}">${escapeHtml(p.position || '')}${p.tier ?? ''}</span></span>
        ${p.isRun ? `<span class="run-flag" title="Run on ${escapeHtml(p.position || '')}: 3 of the last 5 picks were at this position">🔥</span>` : ''}
        <span class="snake-rec-par">${p.par.toFixed(1)} PAR</span>
      </div>`,
    )
    .join('');
}

// Headline "who do I pick" section, per direct request — most drafters
// just want the decisive answer, not to synthesize it themselves from the
// ranked list below (still there, in the tabs below this). Built as a
// distinct card (own background/border, real padding on every side) so it
// reads as one deliberate component, not more text crammed between the
// badge and the tabs — real feedback: the first version felt "crowded and
// messy" sitting flush against both neighbors. Top pick gets its own row
// with a divider under it; "Alt 1"/"Alt 2" (not "Next RB"/"Best WR" as the
// PRIMARY label) makes it unambiguous these are alternatives, not more
// ranked-list noise — the position context still shows, just as a small
// sublabel. altSamePosition/altNextPosition are already null-safe from
// pickHeadlineRecommendation (engine/liveDraftState.js) — an alt cell is
// simply omitted when there's no honest alternate to show.
function renderHeadlineHtml(headline) {
  if (!headline || !headline.top) return '';
  const top = headline.top;

  const altCellHtml = (n, sublabel, p) =>
    p
      ? `<div class="snake-headline-alt">
           <div class="snake-headline-alt-label">Alt ${n} <span class="snake-headline-alt-sublabel">${escapeHtml(sublabel)}</span></div>
           <div class="snake-headline-alt-name">${escapeHtml(p.name)}${injuryFlagHtml(p.injuryDiscount)}</div>
           <div class="snake-headline-alt-meta">${escapeHtml(p.team || '')} · <span class="${p.isLastInTier ? 'tier-cliff' : ''}" title="${p.isLastInTier ? 'Last player left in this tier' : `Tier ${p.tier}`}">${escapeHtml(p.position || '')}${p.tier ?? ''}</span>${p.isRun ? ` <span class="run-flag" title="Run on ${escapeHtml(p.position || '')}: 3 of the last 5 picks were at this position">🔥</span>` : ''}</div>
           <div class="snake-headline-alt-par">${p.par.toFixed(1)} PAR</div>
         </div>`
      : '';

  return `<div class="snake-headline">
    <div class="snake-headline-label">Pick</div>
    <div class="snake-headline-top">
      <div class="snake-headline-top-info">
        <div class="snake-headline-name">${escapeHtml(top.name)}${injuryFlagHtml(top.injuryDiscount)}</div>
        <div class="snake-headline-meta">${escapeHtml(top.team || '')} · <span class="${top.isLastInTier ? 'tier-cliff' : ''}" title="${top.isLastInTier ? 'Last player left in this tier' : `Tier ${top.tier}`}">${escapeHtml(top.position || '')}${top.tier ?? ''}</span>${top.isRun ? ` <span class="run-flag" title="Run on ${escapeHtml(top.position || '')}: 3 of the last 5 picks were at this position">🔥</span>` : ''}</div>
      </div>
      <div class="snake-headline-par">${top.par.toFixed(1)} PAR</div>
    </div>
    <div class="snake-headline-divider"></div>
    <div class="snake-headline-alts">
      ${altCellHtml(1, `Next ${headline.altSamePosition?.position || ''}`, headline.altSamePosition)}
      ${altCellHtml(2, `Best ${headline.altNextPosition?.position || ''}`, headline.altNextPosition)}
    </div>
  </div>`;
}

function renderSnakeNomineeCard(platform, nominee, badge, onClock) {
  // No specific "active" nominee to show here for snake (there's no single
  // player up for bid the way there is in auction — see the tabbed list
  // below instead) — real feedback from testing: a static "Best available"
  // header text here read as a third, conflicting label once the tabs
  // themselves said "Best Available"/"Best Fit". Just omit the header
  // entirely rather than replace it with another label that'll go stale.
  const headerHtml = nominee.playerName
    ? `<div class="nominee-body" style="align-items: flex-start;">
         <div>
           <div class="nominee-player-name">${escapeHtml(nominee.playerName)}</div>
           <div class="nominee-player-meta">${escapeHtml(nominee.team || '')} · ${escapeHtml(nominee.position || '')}</div>
         </div>
       </div>`
    : '';

  const activeTab = snakeListTab[platform] || 'fit';

  let rows;
  let emptyText;
  let extraHeaderHtml = '';
  if (activeTab === 'rank') {
    const rankMode = snakeRankMode[platform] || 'full';
    const metric = rankMode === 'starters' ? 'starterPAR' : 'totalPAR';
    const ranking = (nominee.teamRanking || []).slice().sort((a, b) => b[metric] - a[metric]);
    rows = ranking
      .map(
        (t, i) => `<div class="snake-rec-row${t.isOwn ? ' snake-rank-own' : ''}">
          <span class="snake-rec-rank">${i + 1}</span>
          <span class="snake-rec-name snake-rank-name">${escapeHtml(t.teamName)}${t.isOwn ? ' <span class="snake-rank-you">(you)</span>' : ''}</span>
          <span class="snake-rec-par">${t[metric].toFixed(1)} PAR</span>
        </div>`,
      )
      .join('');
    emptyText = 'No picks yet.';
    extraHeaderHtml = `<div class="snake-rank-mode-tabs">
      <button type="button" class="snake-rank-mode-tab${rankMode === 'full' ? ' active' : ''}" data-platform="${platform}" data-rank-mode="full">Full Team</button>
      <button type="button" class="snake-rank-mode-tab${rankMode === 'starters' ? ' active' : ''}" data-platform="${platform}" data-rank-mode="starters">Starters Only</button>
    </div>`;
  } else if (activeTab === 'position') {
    const activePos = snakePositionSubTab[platform] || POSITION_SUB_TABS[0];
    const list = nominee.positionLists?.[activePos] || [];
    rows = renderPlayerRows(list);
    emptyText = 'No undrafted players left at this position.';
    extraHeaderHtml = `<div class="snake-position-sub-tabs">
      ${POSITION_SUB_TABS.map(
        (pos) =>
          `<button type="button" class="snake-position-sub-tab${pos === activePos ? ' active' : ''}" data-platform="${platform}" data-position-sub-tab="${pos}">${pos}</button>`,
      ).join('')}
    </div>`;
  } else {
    const list = (activeTab === 'available' ? nominee.bestAvailableList : nominee.recommendationList) || [];
    rows = renderPlayerRows(list);
    emptyText = activeTab === 'available' ? 'No undrafted players left.' : 'No open roster slots left to fill.';
  }

  const infoOpen = Boolean(snakeInfoOpen[platform]);
  const tabsHtml = `<div class="snake-rec-tabs">
    <button type="button" class="snake-rec-tab${activeTab === 'available' ? ' active' : ''}" data-platform="${platform}" data-tab="available">Best All</button>
    <button type="button" class="snake-rec-tab${activeTab === 'fit' ? ' active' : ''}" data-platform="${platform}" data-tab="fit">Best Fit</button>
    <button type="button" class="snake-rec-tab${activeTab === 'position' ? ' active' : ''}" data-platform="${platform}" data-tab="position">Position</button>
    <button type="button" class="snake-rec-tab${activeTab === 'rank' ? ' active' : ''}" data-platform="${platform}" data-tab="rank">Draft Rank</button>
    <button type="button" class="snake-rec-info-btn" data-info-toggle="${platform}" aria-label="What's the difference?" title="What's the difference?">ⓘ</button>
  </div>
  ${infoOpen ? `<div class="snake-rec-info">${escapeHtml(SNAKE_TAB_EXPLANATION[activeTab])}</div>` : ''}
  ${extraHeaderHtml}`;

  return `<div class="nominee-card">
    <div class="nominee-top">${badge}${onClock}</div>
    ${headerHtml}
    ${renderHeadlineHtml(nominee.headline)}
    ${tabsHtml}
    <div class="snake-rec-list">${rows || `<div class="snake-rec-empty">${emptyText}</div>`}</div>
  </div>`;
}

// Gauge from $1 to the (already margined) recommended max — fill width is
// the live price's position in that range, clamped to 100% once price
// exceeds max (an overflowing bar would just look broken, and "100%,
// red" already communicates "past the ceiling" on its own). No price yet
// (a fresh nomination) reads as 0% filled, matching computeBidVerdict's
// own "no price yet -> bid" read.
function renderBidRangeBar(currentPrice, maxBid, verdict) {
  if (!(maxBid > 0)) return '';
  const price = currentPrice ?? 0;
  const pct = maxBid > 1 ? Math.min(100, Math.max(0, ((price - 1) / (maxBid - 1)) * 100)) : price > 0 ? 100 : 0;
  // Right label used to just repeat "$${maxBid} max" — the same number
  // already shown big and green right above this bar (real feedback: shown
  // twice for no reason). Room left before the recommended ceiling is
  // actually new information instead.
  const room = maxBid - price;
  return `<div class="bid-range">
    <div class="bid-range-track">
      <div class="bid-range-fill${verdict ? ` bid-range-fill-${verdict}` : ''}" style="width:${pct}%;"></div>
    </div>
    <div class="bid-range-labels"><span>$1</span><span>$${room} left to max</span></div>
  </div>`;
}

// Auction's own view, mirroring snake's layout order per direct request:
// the current-nomination card is the single most important thing on
// screen, so it sits ALWAYS VISIBLE at the top (exactly like snake's
// headline card) — not one of the tabs, never hidden behind a tab click.
// Below it, "Results" (a running ledger of every completed sale vs. what
// that player was actually worth) and "Teams" (that same value rolled up
// per team) stay populated whether or not anyone's currently up for bid —
// see buildNomineeSnapshot's draftResults/teamDeltas, computed
// unconditionally now instead of the old "activePlayerId null -> whole
// card gone" behavior.
const auctionViewTab = {};

function renderAuctionPlayersBody(nominee, platform) {
  if (!nominee.playerName) {
    // Same reserved height as the populated card below (see
    // .auction-player-card's min-height) — real feedback: between a sale
    // and the next nomination, this used to collapse to one short line and
    // the whole card (tabs, results list) visibly jumped up, then jumped
    // back down again once someone was nominated. Centering "Awaiting
    // nomination" in that same reserved space instead keeps everything
    // below it perfectly still.
    return `<div class="nominee-body auction-player-card-empty"><div class="snake-rec-empty">Awaiting nomination.</div></div>`;
  }

  const rec = nominee.recommendation;
  // Verdict label — background.js's computeBidVerdict already compares the
  // live price against this (already margined, see applyValueMargin)
  // maxBid; this just maps its 3 states to a small colored badge. Reuses
  // the existing value/budget green/gold plus a new red for "pass" —
  // same red as the injury flag and ESPN's badge, not a new hex.
  const VERDICT_LABEL = { bid: 'Bid', hold: 'Hold', pass: 'Pass' };
  let recHtml;
  let bidRangeBarHtml = '';
  if (!rec) {
    recHtml = `<div class="nominee-rec-label">Recommended max</div><div class="nominee-rec no-open-slot">pending…</div>`;
  } else {
    const verdict = nominee.bidVerdict;
    // Real feedback: a budget-limited $0/Pass used to show ONLY "$0" — true,
    // but useless on its own since it hides what the player's actually
    // worth (why you'd want to know that even on a pass: judging whether
    // it's worth outbidding your own budget discipline here). Fair value
    // (rec.benchValue, same number the Results/Players tabs already use)
    // shown as a small subtext specifically when budget is the binding
    // constraint — the un-budget-limited case's $ already IS that number.
    const fairValueHtml =
      rec.bindingConstraint === 'budget' ? `<div class="nominee-rec-fairvalue">Fair value: $${rec.benchValue}</div>` : '';
    recHtml = `<div class="nominee-rec-label">Recommended max${rec.bindingConstraint === 'budget' ? ' (budget-limited)' : ''}</div>
      <div class="nominee-rec ${rec.bindingConstraint === 'budget' ? 'budget' : 'value'}">$${rec.maxBid}</div>
      ${fairValueHtml}
      ${verdict && VERDICT_LABEL[verdict] ? `<div class="verdict-badge verdict-${verdict}">${VERDICT_LABEL[verdict]}</div>` : ''}`;
    // Full-width (doesn't fit in the narrow right-aligned numbers column
    // above), per direct request — a gauge showing where the live price
    // sits in the $1-to-max range, tracking live as bidding rises. No new
    // computation needed: this card already re-renders on every bid
    // update, same as the verdict badge right above it, so the bar just
    // reflects nominee.currentPrice fresh each time too.
    bidRangeBarHtml = renderBidRangeBar(nominee.currentPrice, rec.maxBid, verdict);
  }

  const priceHtml = nominee.currentPrice !== null && nominee.currentPrice !== undefined ? `<div class="nominee-price">Current bid <strong>$${nominee.currentPrice}</strong></div>` : '';

  return `<div class="nominee-body">
      <div>
        <div class="nominee-player-name">${escapeHtml(nominee.playerName)}${injuryFlagHtml(nominee.factors?.injuryDiscount)}</div>
        <div class="nominee-player-meta">${escapeHtml(nominee.team || '')} · <span class="${nominee.isLastInTier ? 'tier-cliff' : ''}" title="${nominee.isLastInTier ? 'Last player left in this tier' : ''}">${escapeHtml(nominee.position || '')}</span>${nominee.isRun ? ` <span class="run-flag" title="Run on ${escapeHtml(nominee.position || '')}: 3 of the last 5 picks were at this position">🔥</span>` : ''}</div>
        <div class="nominee-proj">Our projection: ${nominee.ourProjectedPoints ?? '—'} pts${nominee.theirProjectedPoints != null ? ` <span class="nominee-proj-theirs">(FantasyPros: ${nominee.theirProjectedPoints} pts)</span>` : ''}</div>
      </div>
      <div class="nominee-numbers">
        ${priceHtml}
        ${recHtml}
      </div>
    </div>
    ${bidRangeBarHtml}
    ${renderFactors(nominee.factors, rec, platform)}`;
}

function renderAuctionResultsRow(r) {
  const sign = r.value > 0 ? '+' : '';
  const valueClass = r.value > 0 ? 'value-good' : r.value < 0 ? 'value-bad' : '';
  return `<div class="auction-results-row${r.isOwn ? ' snake-rank-own' : ''}">
    <span class="auction-results-player">${escapeHtml(r.playerName)} <span class="auction-results-pos">${escapeHtml(r.position || '')}</span></span>
    <span class="auction-results-team">${escapeHtml(r.teamName || '—')}</span>
    <span class="auction-results-price">$${r.price}</span>
    <span class="auction-results-rec">$${r.recommendedValue}</span>
    <span class="auction-results-value ${valueClass}">${sign}$${Math.abs(r.value)}</span>
  </div>`;
}

function renderAuctionResultsTable(results) {
  if (!results || !results.length) {
    return `<div class="snake-rec-list"><div class="snake-rec-empty">No sales yet.</div></div>`;
  }
  const rows = results
    .slice()
    .reverse() // most recent sale first
    .map(renderAuctionResultsRow)
    .join('');
  return `<div class="auction-results-list">
    <div class="auction-results-row auction-results-header">
      <span>Player</span><span>Team</span><span>Price</span><span>Rec</span><span>Value</span>
    </div>
    ${rows}
  </div>`;
}

function renderAuctionTeamsTable(teamDeltas) {
  if (!teamDeltas || !teamDeltas.length) {
    return `<div class="snake-rec-list"><div class="snake-rec-empty">No sales yet.</div></div>`;
  }
  const rows = teamDeltas
    .map((t) => {
      const sign = t.totalValue > 0 ? '+' : '';
      const valueClass = t.totalValue > 0 ? 'value-good' : t.totalValue < 0 ? 'value-bad' : '';
      return `<div class="snake-rec-row${t.isOwn ? ' snake-rank-own' : ''}">
        <span class="snake-rec-name snake-rank-name">${escapeHtml(t.teamName || 'Unknown team')}${t.isOwn ? ' <span class="snake-rank-you">(you)</span>' : ''}</span>
        <span style="opacity:0.6; font-size: 11px;">${t.picks} pick${t.picks === 1 ? '' : 's'}</span>
        <span class="auction-results-value ${valueClass}">${sign}$${Math.abs(t.totalValue)}</span>
      </div>`;
    })
    .join('');
  return `<div class="snake-rec-list">${rows}</div>`;
}

// "Players" tab, per direct request — a place to just look at player
// values regardless of the current nomination, with an "All" view plus
// each position, same idea as snake's Position tab. $value is fairPrice —
// the same static, buyer-independent number the Results tab compares
// sales against (see buildAuctionPlayersList's comment).
const auctionPositionSubTab = {};
const AUCTION_POSITION_TABS = ['ALL', ...POSITION_SUB_TABS];

function renderAuctionPlayerListRow(p) {
  return `<div class="snake-rec-row">
    <span class="snake-rec-name">${escapeHtml(p.name)}${injuryFlagHtml(p.injuryDiscount)}</span>
    <span class="snake-rec-meta">${escapeHtml(p.team || '')} · ${escapeHtml(p.position || '')}</span>
    <span class="snake-rec-par">$${p.value}</span>
  </div>`;
}

function renderAuctionPlayersListTab(auctionPlayersList, platform) {
  const activePos = auctionPositionSubTab[platform] || 'ALL';
  const list = (activePos === 'ALL' ? auctionPlayersList?.all : auctionPlayersList?.byPosition?.[activePos]) || [];
  const subTabsHtml = `<div class="snake-position-sub-tabs">
    ${AUCTION_POSITION_TABS.map(
      (pos) =>
        `<button type="button" class="snake-position-sub-tab${pos === activePos ? ' active' : ''}" data-platform="${platform}" data-auction-position-sub-tab="${pos}">${pos === 'ALL' ? 'All' : pos}</button>`,
    ).join('')}
  </div>`;
  const rows = list.map(renderAuctionPlayerListRow).join('');
  return `${subTabsHtml}<div class="snake-rec-list">${rows || `<div class="snake-rec-empty">No undrafted players left${activePos === 'ALL' ? '' : ' at this position'}.</div>`}</div>`;
}

function renderAuctionNomineeCard(platform, nominee, badge, onClock) {
  const activeTab = auctionViewTab[platform] || 'results';
  const tabsHtml = `<div class="snake-rec-tabs">
    <button type="button" class="snake-rec-tab${activeTab === 'players' ? ' active' : ''}" data-platform="${platform}" data-auction-tab="players">Players</button>
    <button type="button" class="snake-rec-tab${activeTab === 'results' ? ' active' : ''}" data-platform="${platform}" data-auction-tab="results">Results</button>
    <button type="button" class="snake-rec-tab${activeTab === 'teams' ? ' active' : ''}" data-platform="${platform}" data-auction-tab="teams">Teams</button>
  </div>`;

  let bodyHtml;
  if (activeTab === 'players') {
    bodyHtml = renderAuctionPlayersListTab(nominee.auctionPlayersList, platform);
  } else if (activeTab === 'teams') {
    bodyHtml = renderAuctionTeamsTable(nominee.teamDeltas);
  } else {
    bodyHtml = renderAuctionResultsTable(nominee.draftResults);
  }

  return `<div class="nominee-card" data-platform="${platform}">
    <div class="nominee-top">${badge}${onClock}</div>
    <div class="auction-player-card">${renderAuctionPlayersBody(nominee, platform)}</div>
    ${tabsHtml}
    ${bodyHtml}
  </div>`;
}

function renderNomineeCard(platform, nominee) {
  const badge = `<span class="badge ${platform}">${platform}</span>`;
  const onClock = nominee.teamName ? `<span class="team-on-clock">${escapeHtml(nominee.teamName)}</span>` : '';

  if (nominee.recommendationList) {
    return renderSnakeNomineeCard(platform, nominee, badge, onClock);
  }

  return renderAuctionNomineeCard(platform, nominee, badge, onClock);
}

const PLATFORM_ORDER = ['espn', 'yahoo', 'sleeper'];
function renderNominees() {
  const platforms = PLATFORM_ORDER.filter((p) => nominees[p]).concat(Object.keys(nominees).filter((p) => nominees[p] && !PLATFORM_ORDER.includes(p)));
  nomineeCardsEl.innerHTML = platforms.map((p) => renderNomineeCard(p, nominees[p])).join('');
  nomineeEmptyEl.style.display = platforms.length ? 'none' : 'block';
}

// Delegated (not a per-card listener) because nomineeCardsEl's innerHTML is
// fully replaced on every renderNominees() call — a listener attached
// directly to a tab (or info) button would be destroyed on the very next
// update.
nomineeCardsEl.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    snakeListTab[tabBtn.dataset.platform] = tabBtn.dataset.tab;
    renderNominees();
    return;
  }
  const infoBtn = e.target.closest('[data-info-toggle]');
  if (infoBtn) {
    const platform = infoBtn.dataset.infoToggle;
    snakeInfoOpen[platform] = !snakeInfoOpen[platform];
    renderNominees();
    return;
  }
  const rankModeBtn = e.target.closest('[data-rank-mode]');
  if (rankModeBtn) {
    snakeRankMode[rankModeBtn.dataset.platform] = rankModeBtn.dataset.rankMode;
    renderNominees();
    return;
  }
  const positionSubTabBtn = e.target.closest('[data-position-sub-tab]');
  if (positionSubTabBtn) {
    snakePositionSubTab[positionSubTabBtn.dataset.platform] = positionSubTabBtn.dataset.positionSubTab;
    renderNominees();
    return;
  }
  const auctionTabBtn = e.target.closest('[data-auction-tab]');
  if (auctionTabBtn) {
    auctionViewTab[auctionTabBtn.dataset.platform] = auctionTabBtn.dataset.auctionTab;
    renderNominees();
    return;
  }
  const auctionPositionSubTabBtn = e.target.closest('[data-auction-position-sub-tab]');
  if (auctionPositionSubTabBtn) {
    auctionPositionSubTab[auctionPositionSubTabBtn.dataset.platform] = auctionPositionSubTabBtn.dataset.auctionPositionSubTab;
    renderNominees();
  }
});

// Keeps nomineeFactorsOpen in sync with the native <details> element's own
// open/closed state (the user just clicked its <summary>, no separate
// click handler needed for that part — <details> already toggles itself).
// Capturing phase: a `toggle` event doesn't reliably bubble up to a
// delegated ancestor listener otherwise, so this has to intercept it on
// the way DOWN to the target instead of waiting for it to bubble back up.
nomineeCardsEl.addEventListener(
  'toggle',
  (e) => {
    const details = e.target.closest?.('.nominee-factors');
    if (!details) return;
    const card = details.closest('[data-platform]');
    if (!card) return;
    nomineeFactorsOpen[card.dataset.platform] = details.open;
  },
  true,
);

// 'needs-starting-budget' is a control signal from background.js (fired once
// per draft when it can't infer the real auction budget — capture started
// mid-draft, after the only pre-sale snapshot that would have revealed it —
// see background.js's reresolveTeams()). The raw event feed this used to
// also be filtered out of is gone now (activity log removed), but
// background.js still sends every event over the same 'event'/'init'
// channel, so this check still matters to pick the budget prompt back out.
function isBudgetPrompt(e) {
  return e && e.kind === 'needs-starting-budget';
}

// Named (not inline) so connectPort() above can re-attach it to a fresh
// port on every reconnect, not just the first connection.
function handlePortMessage(msg) {
  if (msg.type === 'init') {
    if ((msg.events || []).some(isBudgetPrompt)) showBudgetPrompt();
    // Lets a freshly-opened/reopened side panel show an already-in-progress
    // nomination immediately instead of waiting for the next wire event —
    // see background.js's onConnect handler. Also what makes a RECONNECT
    // (see connectPort above) a full, correct resync: background.js builds
    // this from its own current state fresh on every new connection.
    Object.assign(nominees, msg.nominees || {});
    renderNominees();
    updateAccountMatchStatus();
  } else if (msg.type === 'event') {
    if (isBudgetPrompt(msg.event)) showBudgetPrompt();
  } else if (msg.type === 'nominee') {
    nominees[msg.platform] = msg.nominee;
    renderNominees();
    updateAccountMatchStatus();
  }
}

connectPort();

function showBudgetPrompt() {
  budgetPromptEl.style.display = 'flex';
}

function hideBudgetPrompt() {
  budgetPromptEl.style.display = 'none';
}

function submitBudget() {
  const value = Number(budgetInputEl.value);
  if (!Number.isFinite(value) || value <= 0) return;
  port.postMessage({ type: 'set-starting-budget', value });
  hideBudgetPrompt();
}

budgetSubmitBtn.addEventListener('click', submitBudget);
budgetInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitBudget();
});

// Roster settings + bench budget % — persisted directly to
// chrome.storage.local (not routed through background.js's port) so
// background.js's chrome.storage.onChanged listener is the single source of
// truth for picking up edits, whether they come from here or any future
// settings surface. benchBudgetShare is stored as a 0-1 fraction (what
// buildLeagueConfig/computeAuctionBaseline expect) but shown in the form as
// a human-friendlier 0-100 percent.
const benchBudgetPctEl = document.getElementById('bench-budget-pct');
// Manual auction-vs-snake toggle — ESPN/Yahoo have no live signal for this
// (see background.js's manualSnakeMode comment), so it's a user setting,
// same persistence pattern as the rest of this panel. Sleeper's own poller
// sets a tab's snake state directly from the draft's real type instead —
// this checkbox doesn't affect Sleeper tabs at all.
const snakeModeEl = document.getElementById('snake-mode');
const flexIncludesTeEl = document.getElementById('flex-includes-te');

function loadRosterSlots() {
  chrome.storage.local
    .get(['rosterSlots', 'benchBudgetShare', 'snakeMode', 'flexIncludesTe'])
    .then(({ rosterSlots, benchBudgetShare, snakeMode, flexIncludesTe }) => {
      const slots = rosterSlots || DEFAULT_ROSTER_SLOTS;
      for (const pos of ROSTER_POSITIONS) {
        const input = document.getElementById(`slot-${pos}`);
        if (input) input.value = slots[pos] ?? DEFAULT_ROSTER_SLOTS[pos];
      }
      benchBudgetPctEl.value = typeof benchBudgetShare === 'number' ? Math.round(benchBudgetShare * 100) : 0;
      snakeModeEl.checked = Boolean(snakeMode);
      // Default true (W/R/T) — matches DEFAULT_FLEX_ELIGIBLE in
      // engine/liveDraftState.js, so an unset value doesn't silently
      // narrow FLEX for anyone who's never touched this setting.
      flexIncludesTeEl.checked = typeof flexIncludesTe === 'boolean' ? flexIncludesTe : true;
    });
}

rosterSaveBtn.addEventListener('click', () => {
  const slots = {};
  for (const pos of ROSTER_POSITIONS) {
    const input = document.getElementById(`slot-${pos}`);
    const value = Number(input.value);
    slots[pos] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_ROSTER_SLOTS[pos];
  }
  const pct = Number(benchBudgetPctEl.value);
  const benchBudgetShare = Number.isFinite(pct) && pct >= 0 ? Math.min(1, pct / 100) : 0;
  const snakeMode = snakeModeEl.checked;
  const flexIncludesTe = flexIncludesTeEl.checked;
  chrome.storage.local.set({ rosterSlots: slots, benchBudgetShare, snakeMode, flexIncludesTe }).then(() => {
    rosterSavedEl.style.display = 'inline';
    setTimeout(() => (rosterSavedEl.style.display = 'none'), 1500);
  });
});

loadRosterSlots();

// Scoring settings — same persistence pattern as roster settings above
// (direct chrome.storage.local, background.js's onChanged listener is the
// single source of truth for picking it up). Real league scoring settings
// differ per league (confirmed via elboberto's LeagueInfo tab — see
// leagueScoring.js) — this is what makes them a live, user-configurable
// setting instead of requiring every user to hand-edit
// data/league-config.json and rerun a Node build script, which isn't usable
// by anyone but a developer editing their own numbers.
function loadScoringRules() {
  chrome.storage.local.get('scoringRules').then(({ scoringRules }) => {
    const rules = scoringRules || DEFAULT_SCORING_RULES;
    for (const field of SCORING_RULE_FIELDS) {
      const input = document.getElementById(`rule-${field}`);
      if (input) input.value = rules[field] ?? DEFAULT_SCORING_RULES[field];
    }
  });
}

scoringSaveBtn.addEventListener('click', () => {
  const rules = {};
  for (const field of SCORING_RULE_FIELDS) {
    const input = document.getElementById(`rule-${field}`);
    const value = Number(input.value);
    rules[field] = Number.isFinite(value) ? value : DEFAULT_SCORING_RULES[field];
  }
  chrome.storage.local.set({ scoringRules: rules }).then(() => {
    scoringSavedEl.style.display = 'inline';
    setTimeout(() => (scoringSavedEl.style.display = 'none'), 1500);
  });
});

loadScoringRules();

renderNominees();

// Account panel — optional login, matches the current draft against the
// user's registered DraftGenius teams (Sleeper only for now — see
// team-match.js). The extension works exactly as before if never used.
const accountLoggedOutEl = document.getElementById('account-logged-out');
const accountLoggedInEl = document.getElementById('account-logged-in');
const accountEmailInput = document.getElementById('account-email');
const accountPasswordInput = document.getElementById('account-password');
const accountLoginBtn = document.getElementById('account-login');
const accountLoginStatusEl = document.getElementById('account-login-status');
const accountEmailDisplayEl = document.getElementById('account-email-display');
const accountLogoutBtn = document.getElementById('account-logout');
const accountMatchStatusEl = document.getElementById('account-match-status');
const accountEffectiveRosterEl = document.getElementById('account-effective-roster');
const accountTeamPickerEl = document.getElementById('account-team-picker');
const accountTeamSelectEl = document.getElementById('account-team-select');
const accountSummaryStatusEl = document.getElementById('account-summary-status');
const accountSettingsConflictEl = document.getElementById('account-settings-conflict');
const accountSettingsConflictTextEl = document.getElementById('account-settings-conflict-text');
const accountSettingsConflictUpdateBtn = document.getElementById('account-settings-conflict-update');
const accountSettingsConflictDismissBtn = document.getElementById('account-settings-conflict-dismiss');

async function refreshAccountUI() {
  const email = await getStoredEmail();
  if (email) {
    accountLoggedOutEl.style.display = 'none';
    accountLoggedInEl.style.display = 'flex';
    accountEmailDisplayEl.textContent = email;
    accountSummaryStatusEl.textContent = email;
  } else {
    accountLoggedOutEl.style.display = 'flex';
    accountLoggedInEl.style.display = 'none';
    accountSummaryStatusEl.textContent = '';
  }
  updateAccountMatchStatus();
}

accountLoginBtn.addEventListener('click', async () => {
  const email = accountEmailInput.value.trim();
  const password = accountPasswordInput.value;
  if (!email || !password) return;
  accountLoginBtn.disabled = true;
  accountLoginStatusEl.textContent = 'Logging in...';
  const result = await login(email, password);
  accountLoginBtn.disabled = false;
  if (!result.ok) {
    accountLoginStatusEl.textContent = result.message;
    return;
  }
  accountLoginStatusEl.textContent = '';
  accountPasswordInput.value = '';
  await refreshAccountUI();
});

accountLogoutBtn.addEventListener('click', async () => {
  await logout();
  await refreshAccountUI();
});

// Real settings actually being applied to pricing/recommendations right
// now for this Sleeper tab — see background.js's buildNomineeSnapshot
// (effectiveRosterSlots) and its three-tier precedence comment in
// ensurePricing. Surfaced HERE (next to match status), not just in the
// separate global "Roster settings" form below, because that form only
// ever shows/edits the generic global chrome.storage value — a REAL,
// confirmed display bug: it kept showing plain defaults (QB1/RB2/WR2/TE1/
// FLEX1/DST1/K1/BENCH6) for a matched Sleeper team whose real league
// settings were something else entirely, with no visible way to tell the
// two apart. This readout is what's actually driving your numbers.
function formatEffectiveRoster(slots) {
  if (!slots) return '';
  return Object.entries(slots)
    .filter(([, count]) => count > 0)
    .map(([pos, count]) => `${pos} ${count}`)
    .join(' · ');
}

const rosterEffectiveBannerEl = document.getElementById('roster-effective-banner');
const scoringEffectiveBannerEl = document.getElementById('scoring-effective-banner');

// Overwrites the manual settings form's VISIBLE input values with this
// draft's real, live-detected numbers whenever one is available — the
// actual root fix for a real, confirmed user report: the banner above
// said one thing ("Currently used for this draft: QB 2 · RB 2 · ...")
// while the form fields directly below it showed a completely different
// set of numbers (the generic manual fallback), even with a disclaimer
// sentence explaining why. That "side by side comparison" was the
// previous fix attempt (see this function's own history) — still
// confusing, because contradicting numbers read as broken regardless of
// the explanation next to them. Showing the SAME numbers in both places
// removes the contradiction outright. This never touches chrome.storage —
// editing these fields and hitting Save still only writes the manual
// fallback value, which stays exactly what's used the moment no real
// league is detected (a different draft, or this one before matching
// resolves) — harmless even when it happens to match what's currently
// live. Skips any field the user has focused right now, so an in-progress
// edit doesn't get silently clobbered by the next nominee update (these
// fire on every pick during a live draft).
function syncFormInputsToEffective(idPrefix, fields, values) {
  if (!values) return;
  for (const field of fields) {
    const input = document.getElementById(`${idPrefix}${field}`);
    if (input && document.activeElement !== input && values[field] !== undefined) {
      input.value = values[field];
    }
  }
}

// Applies (or doesn't) independent of login/match status entirely — even an
// UNMATCHED, not-logged-in Sleeper tab now uses this draft's own
// live-fetched real settings rather than silently falling back to generic
// defaults (see ensurePricing's three-tier precedence). Shown in BOTH the
// Account panel AND directly inside the manual "Roster settings"/"Scoring
// settings" forms themselves, updated on every nominee refresh regardless
// of which view is open — see syncFormInputsToEffective's own comment for
// why the form fields themselves are now overwritten too, not just this
// banner text.
function updateEffectiveRosterDisplays() {
  const sleeperNominee = nominees.sleeper;
  const formatted = sleeperNominee?.effectiveRosterSlots ? formatEffectiveRoster(sleeperNominee.effectiveRosterSlots) : '';
  accountEffectiveRosterEl.textContent = formatted ? `Roster (auto-detected): ${formatted}` : '';
  rosterEffectiveBannerEl.textContent = formatted ? `Currently used for this draft: ${formatted}` : '';
  rosterEffectiveBannerEl.style.display = formatted ? 'block' : 'none';
  syncFormInputsToEffective('slot-', ROSTER_POSITIONS, sleeperNominee?.effectiveRosterSlots);
  if (typeof sleeperNominee?.effectiveFlexIncludesTe === 'boolean' && document.activeElement !== flexIncludesTeEl) {
    flexIncludesTeEl.checked = sleeperNominee.effectiveFlexIncludesTe;
  }

  // Scoring has no compact one-line summary the way roster does (17
  // editable fields vs. 6-7 roster slots) — the banner just states that
  // real settings are in effect; the form fields below it, now synced,
  // are what actually show the numbers.
  const hasEffectiveScoring = Boolean(sleeperNominee?.effectiveScoringRules);
  scoringEffectiveBannerEl.textContent = hasEffectiveScoring
    ? "Currently used for this draft: this league's own detected scoring settings (shown below)."
    : '';
  scoringEffectiveBannerEl.style.display = hasEffectiveScoring ? 'block' : 'none';
  syncFormInputsToEffective('rule-', SCORING_RULE_FIELDS, sleeperNominee?.effectiveScoringRules);

  updateSettingsConflictBanner(sleeperNominee);
}

// Session-only dismiss, keyed to the matched team's name rather than a
// blanket "seen it" flag — dismissing today's stale-settings prompt must
// not silently suppress a genuinely different conflict if the matched
// team changes (a different draft, a different league).
let settingsConflictDismissedFor = null;

function updateSettingsConflictBanner(sleeperNominee) {
  const conflict = sleeperNominee?.settingsConflict;
  const matchedTeamName = sleeperNominee?.matchedTeamName || null;
  if (!conflict || settingsConflictDismissedFor === matchedTeamName) {
    accountSettingsConflictEl.style.display = 'none';
    return;
  }
  const parts = [];
  if (conflict.rosterDiffers) parts.push('roster');
  if (conflict.scoringDiffers) parts.push('scoring');
  accountSettingsConflictTextEl.textContent = `This draft's real ${parts.join(' and ')} settings differ from your saved team. Update it to match?`;
  accountSettingsConflictEl.style.display = 'block';
}

accountSettingsConflictUpdateBtn.addEventListener('click', () => {
  port.postMessage({ type: 'accept-settings-conflict', platform: 'sleeper' });
});

accountSettingsConflictDismissBtn.addEventListener('click', () => {
  settingsConflictDismissedFor = nominees.sleeper?.matchedTeamName || null;
  accountSettingsConflictEl.style.display = 'none';
});

const ACCOUNT_PLATFORM_LABELS = { sleeper: 'Sleeper', espn: 'ESPN', yahoo: 'Yahoo' };
// Sleeper first — it's the only platform with a real auto-match status to
// report (teamMatchStatus); ESPN/Yahoo have none at all (no live
// settings-detection exists there — see settingsConflict.js's own header
// comment), so they always fall through to the picker below rather than
// a status line.
const ACCOUNT_PLATFORM_ORDER = ['sleeper', 'espn', 'yahoo'];

// Reflects the CURRENT tab's match status (if any) — background.js
// includes teamMatchStatus/matchedTeamName on the snake-mode nominee
// snapshot (see buildNomineeSnapshot) for whichever platform is open.
// Only meaningful once logged in. Per direct request: outside a real
// Sleeper auto-match, ALWAYS show an explicit picker rather than silently
// guessing a default team — covers ESPN/Yahoo (which never attempt
// auto-match) the same way it already covered a Sleeper 'no-match'.
async function updateAccountMatchStatus() {
  updateEffectiveRosterDisplays();

  const email = await getStoredEmail();
  if (!email) {
    accountMatchStatusEl.textContent = '';
    accountTeamPickerEl.style.display = 'none';
    return;
  }

  const platform = ACCOUNT_PLATFORM_ORDER.find((p) => nominees[p]);
  if (!platform) {
    accountMatchStatusEl.textContent = 'Open a live draft to match your team.';
    accountTeamPickerEl.style.display = 'none';
    return;
  }

  const nominee = nominees[platform];
  const status = nominee.teamMatchStatus; // real only for Sleeper — undefined for ESPN/Yahoo, or a Sleeper draft still loading

  if (status === 'matched') {
    accountMatchStatusEl.textContent = `Matched: ${nominee.matchedTeamName || 'your team'}`;
    accountTeamPickerEl.style.display = 'none';
    return;
  }
  if (status === 'auth-failed') {
    accountMatchStatusEl.textContent = 'Session expired — log out and back in to re-match.';
    accountTeamPickerEl.style.display = 'none';
    return;
  }
  accountMatchStatusEl.textContent =
    status === 'no-match' ? "Couldn't auto-match this league." : `Select your ${ACCOUNT_PLATFORM_LABELS[platform] || platform} team:`;
  await populateTeamPicker(platform);
}

// Keyed to the platform currently shown — switching from one open draft
// tab's platform to a different one (real, if rare, per this file's own
// "watched an ESPN and a Yahoo draft simultaneously" dev note elsewhere)
// reloads rather than reusing a stale team list from the wrong platform.
let teamPickerPlatform = null;
let teamPickerTeams = [];
async function populateTeamPicker(platform) {
  accountTeamPickerEl.style.display = 'block';
  if (teamPickerPlatform === platform) return;
  teamPickerPlatform = platform;
  teamPickerTeams = [];
  accountTeamSelectEl.innerHTML = '<option value="">Select your team…</option>';
  const { status, teams } = await listTeamsForPlatform(platform);
  if (status !== 'ok' || teamPickerPlatform !== platform) return; // platform changed again while this was in flight
  teamPickerTeams = teams;
  for (const team of teams) {
    const opt = document.createElement('option');
    opt.value = team.id;
    opt.textContent = team.league_name || `${ACCOUNT_PLATFORM_LABELS[platform] || platform} team`;
    accountTeamSelectEl.appendChild(opt);
  }
  const registerOpt = document.createElement('option');
  registerOpt.value = '__register__';
  registerOpt.textContent = 'Not listed — register it on the website...';
  accountTeamSelectEl.appendChild(registerOpt);
}

accountTeamSelectEl.addEventListener('change', () => {
  const platform = teamPickerPlatform || 'sleeper';
  if (accountTeamSelectEl.value === '__register__') {
    chrome.tabs.create({ url: `https://draftgenius.vercel.app/app/league/manual?platform=${platform}` });
    accountTeamSelectEl.value = '';
    return;
  }
  const team = teamPickerTeams.find((t) => t.id === accountTeamSelectEl.value);
  if (!team) return;
  // Session-only, not persisted to chrome.storage — most platforms mint a
  // new external id each season, so a stale cached match next time would
  // be worse than asking again. Same "not tab-scoped, side panel port
  // isn't tied to a specific tab" reasoning as applyManualStartingBudget in
  // background.js — in practice there's only one draft actively missing a
  // match at a time.
  port.postMessage({ type: 'select-team', platform, team });
  accountMatchStatusEl.textContent = `Matched: ${team.league_name || 'your team'}`;
  accountTeamPickerEl.style.display = 'none';
});

refreshAccountUI();
