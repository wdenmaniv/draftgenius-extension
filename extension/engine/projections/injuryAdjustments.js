// Layer 1's injuryDiscount(p) calibration — SPEC.md: "applied only if
// flagged injury-risk (hurt in 2 of last 3 seasons, or one injury with 3+
// month recovery)."
//
// Real games-played data, not guessed. Source: data/injury-history/injury-
// discounts.json, built by scripts/analyze-injury-history.js over the most
// recent 3 years of data/actual-stats/<year>.csv — the real "last 3 seasons"
// window per SPEC.md (currently 2023/2024/2025). That script auto-discovers
// which years are available and takes the most recent 3, so the window
// slides forward on its own as new actual-stats years are added — rerun it
// after dropping in a new year's data/actual-stats/<year>.csv, no manual
// year-list editing needed. (Contrast historicalErrorAdjustments.js's
// errorAdjustment, which is NOT a rolling "last N" window — it uses every
// year it has data for, since more projection-error samples are strictly
// better there and elboberto's projection spreadsheets are the constraint,
// not actuals.)
//
// Per player: a season counts as "hurt" if they played <=13 of 17 games.
// Flagged if (a) they had at least one season with >=14 games (proves a real
// full-time role — otherwise a low-snap bench/rookie season would read as
// "injury" when it's just role), AND (b) either 2+ hurt seasons in the
// window, or one season with <=9 games (proxy for "one injury with 3+ month
// recovery"). Discount = average fraction of games missed across the
// available seasons, scaled so the single worst flagged player lands at
// exactly 25% and every other flagged player is scaled by that same factor
// — a curve, not a hard clip. (An earlier version clipped each player's raw
// average directly at 25%, which meant most flagged players collapsed to
// the identical number since one bad season alone often pushes the raw
// average that high; scaling off the real maximum preserves the ordering
// and spacing between players instead.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, '../../../data/injury-history/injury-discounts.json');

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function normalizeName(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z0-9 ]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((part) => part && !SUFFIXES.has(part))
    .join(' ')
    .trim();
}

let cache = null;
function loadInjuryData() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

export function getInjuryAdjustments(stat) {
  if (stat.position === 'K' || stat.position === 'DST') return {}; // unit/role-based, not individual — injury flagging isn't meaningful here
  const data = loadInjuryData();
  const entry = data[normalizeName(stat.name)];
  if (!entry || !entry.flagged) return {};
  return { injuryDiscount: entry.injuryDiscount };
}
