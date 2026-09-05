// Column layouts confirmed directly from real 2026 season-long ("week=draft")
// CSV exports, downloaded while logged into a free FantasyPros account (the
// anonymous/logged-out view caps every position at 10 players — nowhere near
// enough depth for replacement-level math on RB/WR). Position column order
// is stable; only the stat columns differ by position, which is why this is
// a per-position map rather than a generic name-keyed parse — several
// positions reuse column names (YDS, TDS) for two different stat groups
// (e.g. RB's rushing YDS vs receiving YDS), which would silently collide and
// overwrite if parsed by header name instead of position.
import { parseCsv } from './parseCsv.js';

const COLUMN_MAPS = {
  QB: ['name', 'team', 'passAtt', 'passCmp', 'passYds', 'passTds', 'passInts', 'rushAtt', 'rushYds', 'rushTds', 'fumblesLost', 'fptsSource'],
  RB: ['name', 'team', 'rushAtt', 'rushYds', 'rushTds', 'rec', 'recYds', 'recTds', 'fumblesLost', 'fptsSource'],
  WR: ['name', 'team', 'rec', 'recYds', 'recTds', 'rushAtt', 'rushYds', 'rushTds', 'fumblesLost', 'fptsSource'],
  TE: ['name', 'team', 'rec', 'recYds', 'recTds', 'fumblesLost', 'fptsSource'],
  K: ['name', 'team', 'fg', 'fga', 'xpt', 'fptsSource'],
  DST: ['name', 'team', 'sacks', 'ints', 'fumRec', 'fumForced', 'defTds', 'safeties', 'pointsAllowed', 'yardsAllowed', 'fptsSource'],
};

export function loadFantasyProsCsv(text, position) {
  const keys = COLUMN_MAPS[position];
  if (!keys) throw new Error(`Unknown position for FantasyPros CSV: ${position}`);

  const rows = parseCsv(text);
  const [, ...dataRows] = rows; // drop header row; FantasyPros exports also include a stray blank row, filtered below

  return dataRows
    .filter((r) => r[0] && r[0].trim())
    .map((r) => {
      const stat = { position };
      keys.forEach((key, i) => {
        stat[key] = key === 'name' || key === 'team' ? r[i] : Number(r[i]);
      });
      return stat;
    });
}
