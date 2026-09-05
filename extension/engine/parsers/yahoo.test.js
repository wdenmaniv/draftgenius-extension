import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYahooMessage, parseYahooGrade } from './yahoo.js';

// Every fixture below is a real message captured live from an actual Yahoo
// mock auction draft, not synthesized.

test('parses sold (type 0)', () => {
  const result = parseYahooMessage('0|145|40075|7|RB|1');
  assert.deepEqual(result, {
    type: 'sold',
    pickNumber: 145,
    playerId: '40075',
    teamId: 7,
    position: 'RB',
    price: 1,
  });
});

test('parses nominate-turn (type D)', () => {
  const result = parseYahooMessage('D|145|7|30');
  assert.deepEqual(result, { type: 'nominate-turn', pickNumber: 145, teamId: 7, clockSeconds: 30 });
});

test('parses nomination (type n), and its teamId/playerId/price line up with the sold message for the same pick', () => {
  const nomination = parseYahooMessage('n|7|40075|1|20');
  const sold = parseYahooMessage('0|145|40075|7|RB|1');
  assert.equal(nomination.type, 'nomination');
  assert.equal(nomination.teamId, sold.teamId);
  assert.equal(nomination.playerId, sold.playerId);
  assert.equal(nomination.startingBid, sold.price);
});

test('parses bid (type b)', () => {
  const result = parseYahooMessage('b|1|34036|4|11');
  assert.deepEqual(result, { type: 'bid', teamId: 1, playerId: '34036', amount: 4, clockSeconds: 11 });
});

test('parses clock (type C)', () => {
  assert.deepEqual(parseYahooMessage('C|12'), { type: 'clock', secondsRemaining: 12 });
});

test('parses pick-grade (type G) and its JSON payload', () => {
  const raw =
    'G|[{"pickId":144,"score":89.6,"letterGrade":"A","components":[{"name":"ADP Value","points":15.0,"weight":1.0,"weighted":15.0,"explanation":"Player fell 16 picks past ADP 128 — good value"}],"debug":{"mode":"BLENDED_V3","baseScore":72.0,"totalPoints":17.61,"pickRound":11}}]';
  const result = parseYahooMessage(raw);
  assert.equal(result.type, 'pick-grade');
  assert.equal(result.grades[0].pickId, 144);
  assert.equal(result.grades[0].letterGrade, 'A');
  assert.equal(result.grades[0].components[0].name, 'ADP Value');
});

test('parseYahooGrade returns null instead of throwing on malformed JSON', () => {
  assert.equal(parseYahooGrade('not json'), null);
});

test('unrecognized message types are surfaced, not silently dropped', () => {
  const result = parseYahooMessage('L|4');
  assert.equal(result.type, 'unknown');
  assert.equal(result.raw, 'L|4');
});
