// Extension account connection — plain email/password against Supabase's
// GoTrue REST API, no chrome.identity/OAuth dance needed. This is the first
// piece of network/auth code the extension has ever had (confirmed via a
// full-tree grep before this was built — previously zero such code
// existed). Tokens are stored in chrome.storage.local, same trust boundary
// the website's own Supabase JS SDK already uses (localStorage there) —
// readable only within this extension's own sandboxed storage, not by web
// pages or other extensions.
//
// Same "Commercial" Supabase project every other DraftGenius surface talks
// to (draftgenius/.env.local's NEXT_PUBLIC_SUPABASE_URL/ANON_KEY) — the
// publishable key is safe to embed here, same trust level it already has
// bundled into the website's own client-side JS.
const SUPABASE_URL = 'https://qeyxikwruuuhandvkvan.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_HOb68OCF15UpaGKmWuduSQ_ihd2wbh6';

export { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY };

// Exported (not just used internally by login()/ensureFreshAccessToken()
// below) so background.js's onMessageExternal handler — the website ->
// extension auto-login handoff — can write a session using the exact same
// shape/keys, rather than duplicating this storage logic in a second
// place that could drift out of sync.
export async function storeSession({ access_token, refresh_token, expires_in, user }) {
  await chrome.storage.local.set({
    authAccessToken: access_token,
    authRefreshToken: refresh_token,
    authExpiresAt: Date.now() + expires_in * 1000,
    authEmail: user?.email ?? null,
  });
}

// Runs from sidepanel.js (interactive — the panel is open, the user just
// typed credentials). Returns { ok: true } | { ok: false, message }.
export async function login(email, password) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach DraftGenius. Check your connection." };
  }
  if (!res.ok) {
    return { ok: false, message: 'Wrong email or password.' };
  }
  const data = await res.json();
  await storeSession(data);
  return { ok: true };
}

export async function logout() {
  await chrome.storage.local.remove(['authAccessToken', 'authRefreshToken', 'authExpiresAt', 'authEmail']);
}

// Called on-demand right before any authenticated fetch (team-match.js) —
// deliberately NOT a periodic background timer. MV3 service workers unload
// after ~30s idle, so a proactive setInterval-based refresh isn't reliable
// by construction; checking freshness lazily, right when a token is
// actually needed, is the correct pattern here, not just a simpler one.
// Returns the fresh access token, or null if there's no session or refresh
// fails (expired/revoked refresh token — the caller degrades to
// logged-out-equivalent behavior, never a hard failure).
export async function ensureFreshAccessToken() {
  const { authAccessToken, authRefreshToken, authExpiresAt } = await chrome.storage.local.get([
    'authAccessToken',
    'authRefreshToken',
    'authExpiresAt',
  ]);
  if (!authAccessToken || !authRefreshToken) return null;

  const ONE_MINUTE_MS = 60_000;
  if (typeof authExpiresAt === 'number' && Date.now() < authExpiresAt - ONE_MINUTE_MS) {
    return authAccessToken;
  }

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ refresh_token: authRefreshToken }),
    });
  } catch {
    return null; // network hiccup — caller falls back, doesn't retry-loop
  }
  if (!res.ok) {
    // Only a DEFINITIVE "this refresh token is no longer valid" response
    // should wipe the stored session — Supabase's GoTrue returns 400 with
    // invalid_grant specifically when a refresh token is genuinely
    // expired/revoked. A 5xx (Supabase or an intermediate proxy failing
    // during a real connectivity blip) is NOT proof the refresh token
    // itself is bad. Real bug found live: a beta user's brief connectivity
    // issue logged her out of the extension entirely and forced a full
    // relogin, when the actual refresh token sitting in storage was still
    // perfectly valid — the fix is to leave it in place and let the NEXT
    // attempt (whenever a token is next needed) just try again.
    if (res.status >= 400 && res.status < 500) {
      await logout();
    }
    return null;
  }
  const data = await res.json();
  // Supabase ROTATES the refresh token on every use — the old one is
  // invalidated server-side. Always overwrite, never reuse the old value.
  await storeSession(data);
  return data.access_token;
}

export async function getStoredEmail() {
  const { authEmail } = await chrome.storage.local.get(['authEmail']);
  return authEmail ?? null;
}
