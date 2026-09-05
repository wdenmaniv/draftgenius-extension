import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { matchPlayer } from './matchPlayer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const players = JSON.parse(readFileSync(path.join(__dirname, '../data/players-2026.json'), 'utf8'));

// Both DOM captures below are real — read live from an actual Yahoo draft
// (Yahoo abbreviates first names to an initial; ESPN doesn't).

test('matches Yahoo\'s abbreviated-first-name format against FantasyPros\' full name', () => {
  const match = matchPlayer({ name: 'D. Maye', team: 'NE', position: 'QB' }, players);
  assert.ok(match);
  assert.equal(match.name, 'Drake Maye');
  assert.equal(match.team, 'NE');
});

test('matches even when there\'s a same-surname player at a different position (Mike Evans WR vs Mitchell Evans TE)', () => {
  const match = matchPlayer({ name: 'M. Evans', team: 'SF', position: 'WR' }, players);
  assert.ok(match);
  assert.equal(match.name, 'Mike Evans');
  assert.equal(match.position, 'WR');
});

test('normalizes a known team-abbreviation mismatch (JAX vs JAC) as a tie-break, not a hard filter', () => {
  const synthetic = [
    { name: 'Sam Surname', team: 'JAC', position: 'RB', id: 'a' },
    { name: 'Sam Surname', team: 'DAL', position: 'RB', id: 'b' },
  ];
  const match = matchPlayer({ name: 'S. Surname', team: 'JAX', position: 'RB' }, synthetic);
  assert.equal(match.id, 'a');
});

test('exact full-name match resolves same-surname/team/initial collisions that the last-name fallback alone cannot — caught live: Bijan Robinson vs. Brian Robinson Jr., both real ATL RBs', () => {
  const bijan = matchPlayer({ name: 'Bijan Robinson', team: 'ATL', position: 'RB' }, players);
  const brian = matchPlayer({ name: 'Brian Robinson Jr.', team: 'ATL', position: 'RB' }, players);
  assert.ok(bijan);
  assert.ok(brian);
  assert.equal(bijan.name, 'Bijan Robinson');
  assert.equal(brian.name, 'Brian Robinson Jr.');
  assert.notEqual(bijan.id, brian.id);
});

test('the same collision is still genuinely unresolvable from Yahoo\'s abbreviated form alone (both start with "B")', () => {
  const match = matchPlayer({ name: 'B. Robinson', team: 'ATL', position: 'RB' }, players);
  assert.equal(match, null);
});

test('returns null (not a guess) when position matches but no surname candidate exists', () => {
  const match = matchPlayer({ name: 'Z. Nobody', team: 'XYZ', position: 'RB' }, players);
  assert.equal(match, null);
});

test('disambiguates same-surname/position/team collisions by first initial when possible', () => {
  const synthetic = [
    { name: 'Adam Jones', team: 'DAL', position: 'WR', id: 'a' },
    { name: 'Bob Jones', team: 'DAL', position: 'WR', id: 'b' },
  ];
  const match = matchPlayer({ name: 'A. Jones', team: 'DAL', position: 'WR' }, synthetic);
  assert.equal(match.id, 'a');
});

test('returns null when a same-surname/position/team collision cannot be disambiguated at all', () => {
  const synthetic = [
    { name: 'Adam Jones', team: 'DAL', position: 'WR', id: 'a' },
    { name: 'Alan Jones', team: 'DAL', position: 'WR', id: 'b' },
  ];
  const match = matchPlayer({ name: 'A. Jones', team: 'DAL', position: 'WR' }, synthetic);
  assert.equal(match, null);
});
