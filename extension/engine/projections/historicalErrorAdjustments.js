// Layer 1 errorAdjustment(pos) calibration — SPEC.md's "2 seasons of
// actual-vs-projected analysis per position" requirement.
//
// Methodology: compares preseason PROJECTED stats (elboberto's own
// draft-prep spreadsheets, themselves FantasyPros-sourced — same
// PASSING/RUSHING/RECEIVING raw-stat shape pulled for 2026) against REAL
// season-end stats from Pro Football Reference, both converted through
// leagueScoring.js's real scoring formula. Per matched player-season,
// error_ratio = (actual - projected) / projected; the mean of that ratio
// across matched player-seasons at a position is what's calibrated here.
// This is a real measurement of FantasyPros' own historical projection
// error (preseason optimism, well documented industry-wide), not guessed or
// analogous — see scripts/analyze-historical-bias.js for the full
// implementation and data/historical-projections/bias-analysis.json for
// per-player detail and n counts.
//
// UPDATING FOR A FUTURE SEASON: drop the new year's projected stats into
// data/historical-projections/<year>/ and actual stats into
// data/actual-stats/<year>*.csv (see analyze-historical-bias.js's header for
// the exact file shapes expected), then run:
//   node scripts/analyze-historical-bias.js
// which regenerates bias-analysis.json — this file reads that JSON at
// import time, so no manual number-editing is needed afterward. Years are
// auto-discovered from disk by that script; nothing here is hardcoded to a
// specific year list.
//
// Raw per-position means are ALL negative (real outcomes underperform
// projections at every position — the well-known preseason-optimism
// pattern). Applied raw, that would make every player's adjustedPoints look
// uniformly lower than any other projection source — but the pricing
// engine's dollarPerPAR is derived by dividing the total budget pool by the
// total PAR pool (see computeAuctionBaseline in scoring.js), so a bias
// component common to every position cancels out exactly and has ZERO
// effect on any actual $ recommendation; only the DIFFERENCE between
// positions' bias rates ever moves money. So the values actually applied
// here are mean-centered (each position's raw bias minus the average bias
// across positions) — same relative story, same $ output as the raw
// numbers would produce, but adjustedPoints stays legible/comparable to
// other projection sources instead of looking uniformly marked down.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biasAnalysisPath = path.join(__dirname, '../../../data/historical-projections/bias-analysis.json');

// centerBiasSummary is exported and pure specifically so this centering
// logic — the actual policy decision, not just data loading — is unit
// testable on its own, independent of whatever bias-analysis.json currently
// contains.
export function centerBiasSummary(summary) {
  const positions = Object.keys(summary);
  if (positions.length === 0) return {};
  const meanOfMeans = positions.reduce((s, pos) => s + summary[pos].meanErrorRatio, 0) / positions.length;
  const centered = {};
  for (const pos of positions) {
    centered[pos] = summary[pos].meanErrorRatio - meanOfMeans;
  }
  return centered;
}

function loadHistoricalErrorAdjustments() {
  try {
    const { summary } = JSON.parse(readFileSync(biasAnalysisPath, 'utf8'));
    return centerBiasSummary(summary);
  } catch {
    // bias-analysis.json missing/malformed — fall back to neutral (0) rather
    // than fail the build; regenerate via scripts/analyze-historical-bias.js.
    return {};
  }
}

export const HISTORICAL_ERROR_ADJUSTMENTS = loadHistoricalErrorAdjustments();

export function getHistoricalAdjustments(stat) {
  const errorAdjustment = HISTORICAL_ERROR_ADJUSTMENTS[stat.position];
  return errorAdjustment === undefined ? {} : { errorAdjustment };
}
