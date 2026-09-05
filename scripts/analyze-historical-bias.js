// Regenerates the Layer 1 errorAdjustment calibration from real
// actual-vs-projected data — see historicalErrorAdjustments.js for what this
// feeds and why it's a standalone reference report, not wired into live
// pricing.
//
// THIS IS THE REPEATABLE PROCESS for adding a future season: drop the new
// year's projected stats into
// data/historical-projections/<year>/{qb,rb,wr,te,k,def}.json (same shape as
// the existing years — elboberto's own draft-prep export, one array of
// per-player objects keyed like "PASSING YDS"/"RUSHING TDS"/"MISC FL") and
// the matching real actual-stats CSVs into data/actual-stats/<year>.csv (+
// -kicking.csv / -defense.csv, Pro Football Reference's export shape), then
// rerun:
//   node scripts/analyze-historical-bias.js
// Years are auto-discovered from disk (any year with BOTH a projections
// directory and actual-stats files) — nothing to hardcode or edit here.
//
// Uses the SAME real scoring formula as the live pipeline
// (leagueScoring.js's computeLeaguePoints) rather than a duplicated copy, so
// this can never silently drift from what build-projections.js actually
// does.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLeaguePoints, DEFAULT_SCORING_RULES } from '../extension/engine/projections/leagueScoring.js';
import { parseCsv } from '../extension/engine/projections/parseCsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const PROJECTION_FILE = { QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', K: 'k', DST: 'def' };
// Filters out deep-bench/waiver-tier rows whose tiny projected-points
// denominator would blow up error_ratio and drown out the real signal.
const MIN_PROJECTED = { QB: 50, RB: 30, WR: 30, TE: 20, K: 20, DST: 20 };

function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/,/g, '')) || 0;
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function normName(name) {
  const cleaned = String(name).toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9 ]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((p) => p && !NAME_SUFFIXES.has(p))
    .join(' ')
    .trim();
}

function discoverYears() {
  const projDir = path.join(ROOT, 'data/historical-projections');
  return readdirSync(projDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map((e) => Number(e.name))
    .filter((year) => existsSync(path.join(ROOT, `data/actual-stats/${year}.csv`)))
    .sort((a, b) => a - b);
}

function loadProjections(year, pos) {
  const filePath = path.join(ROOT, `data/historical-projections/${year}/${PROJECTION_FILE[pos]}.json`);
  const rows = JSON.parse(readFileSync(filePath, 'utf8'));
  return rows
    .filter((row) => row.Player)
    .map((row) => {
      let stat;
      if (pos === 'QB') {
        stat = { position: pos, passYds: num(row['PASSING YDS']), passTds: num(row['PASSING TDS']), passInts: num(row['PASSING INTS']), rushYds: num(row['RUSHING YDS']), rushTds: num(row['RUSHING TDS']), fumblesLost: num(row['MISC FL']) };
      } else if (pos === 'RB' || pos === 'WR') {
        stat = { position: pos, rushYds: num(row['RUSHING YDS']), rushTds: num(row['RUSHING TDS']), rec: num(row['RECEIVING REC']), recYds: num(row['RECEIVING YDS']), recTds: num(row['RECEIVING TDS']), fumblesLost: num(row['MISC FL']) };
      } else if (pos === 'TE') {
        stat = { position: pos, rec: num(row['RECEIVING REC']), recYds: num(row['RECEIVING YDS']), recTds: num(row['RECEIVING TDS']), fumblesLost: num(row['MISC FL']) };
      } else if (pos === 'K') {
        stat = { position: pos, fg: num(row['FG']), xpt: num(row['XPT']) };
      } else {
        stat = { position: pos, sacks: num(row['SACK']), ints: num(row['INT']), fumRec: num(row['FR']), fumForced: num(row['FF']), defTds: num(row['TD']), safeties: num(row['SAFETY']), pointsAllowed: num(row['PA']) };
      }
      return { name: row.Player, team: row.Team || '', stat };
    });
}

function loadCsv(filePath) {
  const [header, ...dataRows] = parseCsv(readFileSync(filePath, 'utf8'));
  return dataRows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function loadActuals(year, pos) {
  if (pos === 'K') {
    return loadCsv(path.join(ROOT, `data/actual-stats/${year}-kicking.csv`)).map((row) => ({
      name: row.player,
      team: row.team,
      stat: { position: pos, fg: num(row.fgm), xpt: num(row.xpm) },
    }));
  }
  if (pos === 'DST') {
    return loadCsv(path.join(ROOT, `data/actual-stats/${year}-defense.csv`)).map((row) => ({
      name: row.team, // DST rows have no separate "player" name — the team IS the unit, matching the projections' Player column (a team name) for this position
      team: row.team,
      stat: { position: pos, sacks: num(row.sacks), ints: num(row.pass_int), fumRec: num(row.fumbles_lost_by_opp), fumForced: 0, defTds: 0, safeties: 0, pointsAllowed: num(row.points_allowed) },
    }));
  }
  return loadCsv(path.join(ROOT, `data/actual-stats/${year}.csv`))
    .filter((row) => row.fantasy_pos === pos)
    .map((row) => ({
      name: row.player,
      team: row.team,
      stat: { position: pos, passYds: num(row.pass_yds), passTds: num(row.pass_td), passInts: num(row.pass_int), rushYds: num(row.rush_yds), rushTds: num(row.rush_td), fumblesLost: num(row.fumbles_lost), rec: num(row.rec), recYds: num(row.rec_yds), recTds: num(row.rec_td) },
    }));
}

function run() {
  const years = discoverYears();
  const results = Object.fromEntries(POSITIONS.map((p) => [p, []]));

  for (const year of years) {
    for (const pos of POSITIONS) {
      const projections = loadProjections(year, pos);
      const actualsByName = new Map();
      for (const a of loadActuals(year, pos)) {
        const key = normName(a.name);
        if (!actualsByName.has(key)) actualsByName.set(key, a);
      }

      let matched = 0;
      let unmatched = 0;
      for (const p of projections) {
        const a = actualsByName.get(normName(p.name));
        if (!a) {
          unmatched++;
          continue;
        }
        const projectedPoints = computeLeaguePoints(p.stat, DEFAULT_SCORING_RULES);
        if (projectedPoints < MIN_PROJECTED[pos]) continue;
        const actualPoints = computeLeaguePoints(a.stat, DEFAULT_SCORING_RULES);
        matched++;
        results[pos].push({
          year,
          name: p.name,
          team: p.team,
          projected: Math.round(projectedPoints * 10) / 10,
          actual: Math.round(actualPoints * 10) / 10,
          errorRatio: (actualPoints - projectedPoints) / projectedPoints,
        });
      }
      console.log(`${year} ${pos}: matched=${matched} unmatched=${unmatched} (of ${projections.length} projected)`);
    }
  }

  const summary = {};
  for (const pos of POSITIONS) {
    const ratios = results[pos].map((r) => r.errorRatio);
    if (ratios.length === 0) continue;
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    summary[pos] = { n: ratios.length, meanErrorRatio: Math.round(mean * 10000) / 10000 };
  }

  // Mean-centered version — see historicalErrorAdjustments.js's comment for
  // why: raw means are ALL negative (preseason-optimism bias at every
  // position), but the pricing engine's dollarPerPAR self-normalizes against
  // the total PAR pool, so a component common to every position has zero
  // effect on any $ recommendation — only the spread BETWEEN positions moves
  // money. Centering makes the displayed adjustedPoints/factor numbers
  // legible (comparable to any other projection source) without changing a
  // single dollar figure the engine outputs.
  const meanOfMeans = Object.values(summary).reduce((s, v) => s + v.meanErrorRatio, 0) / Object.keys(summary).length;
  for (const pos of Object.keys(summary)) {
    summary[pos].centeredErrorRatio = Math.round((summary[pos].meanErrorRatio - meanOfMeans) * 10000) / 10000;
  }

  console.log(`\nYears used: ${years.join(', ')}  (mean of position means: ${(meanOfMeans * 100).toFixed(2)}%)`);
  for (const [pos, s] of Object.entries(summary)) {
    console.log(`${pos}: n=${s.n} raw=${(s.meanErrorRatio * 100).toFixed(1)}%  centered=${(s.centeredErrorRatio * 100).toFixed(1)}%`);
  }

  const outPath = path.join(ROOT, 'data/historical-projections/bias-analysis.json');
  writeFileSync(outPath, JSON.stringify({ years, summary, details: results }, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
}

run();
