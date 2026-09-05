// Regenerates the Layer 1 injuryDiscount calibration from real games-played
// history — see injuryAdjustments.js for what this feeds and the exact
// flagging test (SPEC.md: "hurt in 2 of last 3 seasons, or one injury with
// 3+ month recovery").
//
// THIS IS THE REPEATABLE PROCESS for rolling the window forward each
// season: once a new year's data/actual-stats/<year>.csv exists (Pro
// Football Reference's per-player season export, same shape as the existing
// years), rerun:
//   node scripts/analyze-injury-history.js
// Unlike analyze-historical-bias.js (which uses every year it has, since
// more projection-error samples are strictly better and there's no
// "last N seasons" constraint), SPEC.md's injury test explicitly means the
// last 3 seasons, not the full history ever collected — so this
// auto-discovers every year with an actual-stats file, sorts them, and
// takes the most recent 3, letting the window slide forward on its own as
// new years are added rather than needing a hardcoded year list edited each
// time.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../extension/engine/projections/parseCsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const GAMES_PER_SEASON = 17;
const ESTABLISHED_THRESHOLD = 14; // >=14 games in some season proves a real full-time role
const MISSED_THRESHOLD = 4; // <=13 games (17-4) counts as a "hurt" season
const MAJOR_THRESHOLD = 8; // <=9 games (17-8) alone is enough, without needing a second hurt season
const MAX_DISCOUNT = 0.25;
const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']); // K/DST are unit-based, not individually injury-flagged

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function normName(name) {
  const cleaned = String(name).toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9 ]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((p) => p && !NAME_SUFFIXES.has(p))
    .join(' ')
    .trim();
}

function discoverWindow() {
  const dir = path.join(ROOT, 'data/actual-stats');
  const years = readdirSync(dir)
    .map((f) => f.match(/^(\d{4})\.csv$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return years.slice(-3); // most recent 3 — SPEC.md's stated window, not "everything we have"
}

function loadCsv(filePath) {
  const [header, ...dataRows] = parseCsv(readFileSync(filePath, 'utf8'));
  return dataRows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function run() {
  const years = discoverWindow();

  const players2026 = JSON.parse(readFileSync(path.join(ROOT, 'extension/engine/data/players-2026.json'), 'utf8'));
  const poolKeys = new Set(players2026.filter((p) => SKILL_POSITIONS.has(p.position)).map((p) => normName(p.name)));

  const history = {}; // normName -> { [year]: gamesPlayed }
  const displayName = {};
  for (const year of years) {
    const rows = loadCsv(path.join(ROOT, `data/actual-stats/${year}.csv`));
    for (const row of rows) {
      if (!SKILL_POSITIONS.has(row.fantasy_pos)) continue;
      const key = normName(row.player);
      if (!poolKeys.has(key)) continue; // scoped to this season's real 2026 draft pool, same as the original methodology
      const g = row.g === undefined || row.g === '' ? null : Number(row.g);
      if (g === null || Number.isNaN(g)) continue;
      (history[key] ??= {})[year] = g;
      displayName[key] = row.player;
    }
  }

  // First pass: flag each player and compute their raw (uncapped) average
  // missed-games fraction. Previously this was clipped directly at
  // MAX_DISCOUNT, which meant any player whose raw average landed at or
  // above 25% collapsed to the identical number — in the real 2026 pool,
  // 51 of 78 flagged players landed on that same clipped value, erasing
  // real differences between e.g. a borderline case and someone with a
  // multi-year pattern. Instead: find the single highest raw average among
  // flagged players and scale everyone's raw average so THAT player lands
  // at exactly MAX_DISCOUNT, applying the same scale factor to every other
  // flagged player. This keeps the cap (nobody exceeds MAX_DISCOUNT) while
  // preserving the real ordering and relative spacing between players
  // instead of flattening the top of the distribution.
  const raw = {};
  let maxAvgMissed = 0;
  for (const [key, seasons] of Object.entries(history)) {
    const gamesList = Object.values(seasons);
    const established = gamesList.some((g) => g >= ESTABLISHED_THRESHOLD);
    const hurtSeasons = gamesList.filter((g) => g <= GAMES_PER_SEASON - MISSED_THRESHOLD).length;
    const majorInjurySeason = gamesList.some((g) => g <= GAMES_PER_SEASON - MAJOR_THRESHOLD);
    const flagged = established && (hurtSeasons >= 2 || majorInjurySeason);
    const missedFractions = gamesList.map((g) => (GAMES_PER_SEASON - g) / GAMES_PER_SEASON);
    const avgMissed = missedFractions.reduce((s, v) => s + v, 0) / missedFractions.length;
    if (flagged && avgMissed > maxAvgMissed) maxAvgMissed = avgMissed;
    raw[key] = { seasons, established, hurtSeasons, majorInjurySeason, flagged, avgMissed };
  }
  // Scale factor maps the single worst raw average onto MAX_DISCOUNT. Guard
  // against maxAvgMissed being 0 (no flagged players at all) to avoid a
  // divide-by-zero producing Infinity/NaN discounts.
  const scale = maxAvgMissed > 0 ? MAX_DISCOUNT / maxAvgMissed : 1;

  const out = {};
  let flaggedCount = 0;
  for (const [key, r] of Object.entries(raw)) {
    const { seasons, established, hurtSeasons, majorInjurySeason, flagged, avgMissed } = r;
    const injuryDiscount = flagged ? Math.round(avgMissed * scale * 10000) / 10000 : 0;
    if (flagged) flaggedCount++;
    out[key] = { name: displayName[key], seasons, established, hurtSeasons, majorInjurySeason, flagged, injuryDiscount };
  }

  console.log(`Years used: ${years.join(', ')}`);
  console.log(`${Object.keys(out).length} 2026-pool skill players with games-played history across ${years.join('/')}`);
  console.log(`${flaggedCount} flagged as injury-risk (${Math.round((flaggedCount / Object.keys(out).length) * 100)}%)`);

  const outDir = path.join(ROOT, 'data/injury-history');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'injury-discounts.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(ROOT, outPath)}`);

  const examples = Object.values(out)
    .filter((v) => v.flagged)
    .sort((a, b) => b.injuryDiscount - a.injuryDiscount)
    .slice(0, 15);
  console.log(`\nTop ${examples.length} flagged players:`);
  for (const v of examples) {
    console.log(`  ${v.name.padEnd(25)} seasons=${JSON.stringify(v.seasons)} discount=${v.injuryDiscount}`);
  }
}

run();
