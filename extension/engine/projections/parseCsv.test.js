import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './parseCsv.js';

test('parses simple quoted fields', () => {
  const rows = parseCsv('"Player","Team","FPTS"\n"Josh Allen","BUF","372.3"');
  assert.deepEqual(rows, [
    ['Player', 'Team', 'FPTS'],
    ['Josh Allen', 'BUF', '372.3'],
  ]);
});

test('handles a comma inside a quoted field', () => {
  const rows = parseCsv('"Team, Inc.","BUF"');
  assert.deepEqual(rows, [['Team, Inc.', 'BUF']]);
});

test('handles an escaped quote inside a quoted field', () => {
  const rows = parseCsv('"Nickname ""The Guy""","BUF"');
  assert.deepEqual(rows, [['Nickname "The Guy"', 'BUF']]);
});

test('skips blank lines', () => {
  const rows = parseCsv('"a","b"\n\n"c","d"');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});
