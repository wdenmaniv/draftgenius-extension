import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFantasyProsCsv } from './fantasyProsLoader.js';

// Every fixture below is a real row from the actual 2026 season-long
// ("week=draft") CSV exports, not synthesized — including the header and
// the stray blank second row FantasyPros' export actually contains.

test('loads QB rows: passing then rushing stat groups', () => {
  const csv = '"Player","Team","ATT","CMP","YDS","TDS","INTS","ATT","YDS","TDS","FL","FPTS"\n' +
    '" ","","",""\n' +
    '"Josh Allen","BUF","492.3","333.4","3816.9","27.4","11.2","118.1","585.5","11.8","4.1","372.3"';
  const [allen] = loadFantasyProsCsv(csv, 'QB');
  assert.equal(allen.name, 'Josh Allen');
  assert.equal(allen.team, 'BUF');
  assert.equal(allen.passYds, 3816.9);
  assert.equal(allen.passTds, 27.4);
  assert.equal(allen.rushYds, 585.5); // must NOT be confused with passYds despite both columns being named "YDS"
  assert.equal(allen.rushTds, 11.8);
  assert.equal(allen.fumblesLost, 4.1);
});

test('loads RB rows: rushing then receiving stat groups', () => {
  const csv = '"Player","Team","ATT","YDS","TDS","REC","YDS","TDS","FL","FPTS"\n' +
    '" ","","",""\n' +
    '"Jahmyr Gibbs","DET","274.7","1383.0","13.8","70.9","581.1","4.1","1.1","337.3"';
  const [gibbs] = loadFantasyProsCsv(csv, 'RB');
  assert.equal(gibbs.rushYds, 1383.0);
  assert.equal(gibbs.rushTds, 13.8);
  assert.equal(gibbs.rec, 70.9);
  assert.equal(gibbs.recYds, 581.1);
  assert.equal(gibbs.recTds, 4.1);
});

test('loads WR rows: receiving then rushing stat groups (reversed order from RB)', () => {
  const csv = '"Player","Team","REC","YDS","TDS","ATT","YDS","TDS","FL","FPTS"\n' +
    '" ","","",""\n' +
    '"Puka Nacua","LAR","117.0","1539.0","9.0","13.6","85.0","1.4","1.0","281.3"';
  const [nacua] = loadFantasyProsCsv(csv, 'WR');
  assert.equal(nacua.rec, 117.0);
  assert.equal(nacua.recYds, 1539.0);
  assert.equal(nacua.recTds, 9.0);
  assert.equal(nacua.rushYds, 85.0);
});

test('loads K rows', () => {
  const csv = '"Player","Team","FG","FGA","XPT","FPTS"\n"Brandon Aubrey","DAL","35.2","39.9","47.5","153.0"';
  const [aubrey] = loadFantasyProsCsv(csv, 'K');
  assert.equal(aubrey.fg, 35.2);
  assert.equal(aubrey.xpt, 47.5);
});

test('loads DST rows, and skips the empty team-name column', () => {
  const csv = '"Player","Team","SACK","INT","FR","FF","TD","SAFETY","PA","YDS_AGN","FPTS"\n' +
    '"Houston Texans","","49.5","14.8","11.6","18.3","2.8","1.0","322.0","5050.1","121.0"';
  const [texans] = loadFantasyProsCsv(csv, 'DST');
  assert.equal(texans.name, 'Houston Texans');
  assert.equal(texans.sacks, 49.5);
  assert.equal(texans.pointsAllowed, 322.0);
});

test('skips FantasyPros export\'s stray blank row', () => {
  const csv = '"Player","Team","REC","YDS","TDS","FL","FPTS"\n' + '" ","",""\n' + '"Trey McBride","ARI","109.0","1051.6","6.8","0.2","199.9"';
  const rows = loadFantasyProsCsv(csv, 'TE');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Trey McBride');
});
