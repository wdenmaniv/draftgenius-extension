// Reads the raw FantasyPros CSVs in data/fantasypros/2026/, converts each
// player's raw stat projection into league-specific fantasy points, and
// writes one combined players.json ready for the scoring engine's
// computeReplacementLevels/computePAR (which expect { id, position,
// adjustedPoints }).
//
// This is a build-time script (Node fs), not extension runtime code — the
// extension loads the resulting static JSON rather than parsing CSVs itself.
// Re-run whenever the source CSVs are refreshed (new FantasyPros export) or
// the scoring rules change.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadFantasyProsCsv } from '../extension/engine/projections/fantasyProsLoader.js';
import { computeLeaguePoints, DEFAULT_SCORING_RULES } from '../extension/engine/projections/leagueScoring.js';
import { applyLayer1Adjustments } from '../extension/engine/projections/layer1Adjustments.js';
import { getHistoricalAdjustments } from '../extension/engine/projections/historicalErrorAdjustments.js';
import { getInjuryAdjustments } from '../extension/engine/projections/injuryAdjustments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../data/fantasypros/2026');
const outPath = path.join(__dirname, '../extension/engine/data/players-2026.json');
const leagueConfigPath = path.join(__dirname, '../data/league-config.json');

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

// data/league-config.json is the editable source of truth for the real
// league's scoring settings (see that file's _comment for why this is a
// separate mechanism from the side panel's live roster/budget settings).
// JSON has no Infinity literal, so pointsAllowedTiers' final catch-all tier
// is written as `"max": null` there and converted back here.
function loadScoringRules() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(leagueConfigPath, 'utf8'));
  } catch {
    return DEFAULT_SCORING_RULES; // file missing/malformed — fall back rather than fail the build
  }
  const rules = { ...DEFAULT_SCORING_RULES, ...raw.scoringRules };
  if (Array.isArray(rules.pointsAllowedTiers)) {
    rules.pointsAllowedTiers = rules.pointsAllowedTiers.map((tier) => ({
      ...tier,
      max: tier.max === null ? Infinity : tier.max,
    }));
  }
  return rules;
}

// Includes position, not just name+team — real bug found live: FantasyPros'
// own 2026 export lists "Connor Heyward, LV" in BOTH rb.csv AND te.csv
// (same name, same — likely wrong, see build()'s own note below — team
// code), which without a position component collided on the exact same id
// ("connor-heyward-lv") for two genuinely different rows. That silently
// broke every consumer keying off id (React's key prop on draftgenius's
// Rankings page, background.js's playerIdentity/parById Maps in the
// extension) — confirmed live via a real React "two children with the same
// key" console error. Position-qualifying the id (e.g.
// "connor-heyward-lv-rb" vs "connor-heyward-lv-te") is guaranteed unique
// for any two rows that are otherwise identical on name+team, without
// needing to guess which row is the "real" one.
function slugify(name, team, position) {
  return `${name}-${team}-${position}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// getAdjustments(stat) -> { errorAdjustment?, injuryDiscount?, matchupAdjustment? }
// Combines historicalErrorAdjustments.js's per-position errorAdjustment
// (real FantasyPros preseason-optimism bias, mean-centered across
// positions — see that file's comment for why centered, not raw) with
// injuryAdjustments.js's per-player injuryDiscount (calibrated from real
// games-played history). matchupAdjustment remains neutral (0) — schedule
// strength data hasn't been pulled; that's still a separate, open task.
function defaultGetAdjustments(stat) {
  return { ...getHistoricalAdjustments(stat), ...getInjuryAdjustments(stat) };
}

function build(rules = DEFAULT_SCORING_RULES, getAdjustments = defaultGetAdjustments) {
  const players = [];
  for (const position of POSITIONS) {
    const csvPath = path.join(dataDir, `${position.toLowerCase()}.csv`);
    const csvText = readFileSync(csvPath, 'utf8');
    const stats = loadFantasyProsCsv(csvText, position);
    for (const stat of stats) {
      const basePoints = computeLeaguePoints(stat, rules);
      const adjustments = getAdjustments(stat);
      const adjustedPoints = applyLayer1Adjustments(basePoints, adjustments);
      players.push({
        id: slugify(stat.name, stat.team, position),
        // Spreads every raw per-category stat field (passYds, rushYds, rec,
        // etc. — whatever computeLeaguePoints reads for this position),
        // including position/name/team which stat already carries under the
        // same field names. This is what lets the extension recompute
        // basePoints live under a user's own scoring rules — see
        // recomputeWithScoringRules in liveDraftState.js — instead of only
        // ever having the single rule set baked in at build time.
        ...stat,
        // errorAdjustment/injuryDiscount are stored as their own fields (not
        // just folded into adjustedPoints) so a live recompute can reapply
        // them on top of a freshly-computed basePoints without needing to
        // redo the calibration itself — neither ratio depends on which
        // scoring rules are in effect.
        errorAdjustment: adjustments.errorAdjustment || 0,
        injuryDiscount: adjustments.injuryDiscount || 0,
        basePoints: Math.round(basePoints * 10) / 10,
        adjustedPoints: Math.round(adjustedPoints * 10) / 10,
        source: 'fantasypros-2026-draft',
      });
    }
  }
  return players;
}

const players = build(loadScoringRules());

// Guards against a repeat of the real Connor Heyward id-collision bug (see
// slugify's own comment) — every downstream consumer keys off `id` (React
// keys on draftgenius's Rankings page, background.js's playerIdentity/
// parById Maps in the extension), so a duplicate silently corrupts both
// rather than failing loudly. Fail the BUILD instead — a bad export should
// never reach a shipped players-2026.json in the first place.
const seenIds = new Map(); // id -> first player's display name, for a useful error message
for (const p of players) {
  if (seenIds.has(p.id)) {
    throw new Error(
      `Duplicate player id "${p.id}": "${seenIds.get(p.id)}" and "${p.name}" (${p.team} ${p.position}) both slugify to the same id. Fix the source FantasyPros CSV or slugify() before regenerating.`,
    );
  }
  seenIds.set(p.id, `${p.name} (${p.team} ${p.position})`);
}

writeFileSync(outPath, JSON.stringify(players, null, 2));
console.log(`Wrote ${players.length} players to ${path.relative(process.cwd(), outPath)}`);
for (const pos of POSITIONS) {
  const count = players.filter((p) => p.position === pos).length;
  console.log(`  ${pos}: ${count}`);
}

// A small SEPARATE metadata file, not a field folded into players-2026.json
// itself — that file is a bare array everywhere it's consumed (React keys,
// background.js's identity Maps), and wrapping it in an object would be a
// breaking change to every existing consumer. Records WHEN this script was
// last run, not FantasyPros' own internal "consensus last updated"
// timestamp (that's a fact from their webpage's header at download time,
// not encoded in the CSV export itself, so claiming to know it precisely
// would be dishonest) — draftgenius's Rankings page reads this to show a
// real "player data last refreshed" note.
const metaPath = path.join(__dirname, '../extension/engine/data/players-2026-meta.json');
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: 'FantasyPros consensus projections (season-long draft rankings)',
    },
    null,
    2,
  ),
);
console.log(`Wrote ${path.relative(process.cwd(), metaPath)}`);
