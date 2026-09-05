import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEspnMessage } from './espn.js';

// Every fixture below is a real message captured live from an actual ESPN
// mock auction draft, not synthesized.

test('parses BID', () => {
  const result = parseEspnMessage('BID 2 4429795 45 25000 10000\n');
  assert.deepEqual(result, {
    type: 'bid',
    teamId: 2,
    playerId: '4429795',
    amount: 45,
  });
});

test('parses CLOCK phase 2 (bid countdown) — the fullest shape', () => {
  const result = parseEspnMessage('CLOCK 2 9499 2 4429795 45\n');
  assert.equal(result.type, 'clock');
  assert.equal(result.phase, 2);
  assert.equal(result.msRemaining, 9499);
  assert.equal(result.teamId, 2);
  assert.equal(result.playerId, '4429795');
  assert.equal(result.currentBid, 45);
});

test('parses CLOCK phase 1 (nomination countdown) — has teamId, no player/bid yet', () => {
  const result = parseEspnMessage('CLOCK 1 24248 1\n');
  assert.deepEqual(result, { type: 'clock', phase: 1, msRemaining: 24248, teamId: 1 });
});

test('parses CLOCK phase 3 — msRemaining only, no team context', () => {
  const result = parseEspnMessage('CLOCK 3 1750\n');
  assert.deepEqual(result, { type: 'clock', phase: 3, msRemaining: 1750 });
});

test('parses CLOCK phase 4 (seen live in a snake draft) — no further tokens at all, msRemaining honestly omitted rather than NaN', () => {
  const result = parseEspnMessage('CLOCK 4\n');
  assert.deepEqual(result, { type: 'clock', phase: 4 });
  assert.ok(!('msRemaining' in result));
});

test('parses NOMINATION', () => {
  const result = parseEspnMessage('NOMINATION 5 25000\n');
  assert.deepEqual(result, { type: 'nomination', teamId: 5, msRemaining: 25000 });
});

test('parses SOLD, and its price matches the winning BID amount from the same auction', () => {
  const bid = parseEspnMessage('BID 1 4429795 46 25000 10000\n');
  const sold = parseEspnMessage('SOLD 1 4429795 2 46 0\n');
  assert.equal(sold.type, 'sold');
  assert.equal(sold.teamId, 1);
  assert.equal(sold.playerId, '4429795');
  assert.equal(sold.nominatingTeamId, 2);
  assert.equal(sold.price, bid.amount);
});

test('parses AUTOSUGGEST', () => {
  assert.deepEqual(parseEspnMessage('AUTOSUGGEST 4430807\n'), { type: 'autosuggest', playerId: '4430807' });
});

test('parses PONG as a heartbeat with no draft-state content', () => {
  assert.deepEqual(parseEspnMessage('PONG PING%201786917110373\n'), { type: 'pong' });
});

// Real messages captured live from an actual ESPN SNAKE mock draft — a
// genuinely different message set from auction, not synthesized or guessed.
test('parses SELECTING (snake draft — teamId on the clock, no bidding)', () => {
  const result = parseEspnMessage('SELECTING 6 30000\n');
  assert.deepEqual(result, { type: 'selecting', teamId: 6, msRemaining: 30000 });
});

test('parses SELECTED (snake draft — pick made, no price)', () => {
  const result = parseEspnMessage('SELECTED 9 4429025 11\n');
  assert.equal(result.type, 'picked');
  assert.equal(result.teamId, 9);
  assert.equal(result.playerId, '4429025');
});

test('parses SELECTED with the occasional trailing GUID-looking token, same as without it', () => {
  const withGuid = parseEspnMessage('SELECTED 5 4038941 1 {02FC685B-B902-4CBF-9D8E-7FF8B2D4D2C8}\n');
  assert.deepEqual(withGuid, { type: 'picked', teamId: 5, playerId: '4038941' });
});

test('unrecognized message types are surfaced, not silently dropped', () => {
  const result = parseEspnMessage('SOMETHING_NEW 1 2 3\n');
  assert.equal(result.type, 'unknown');
  assert.equal(result.raw, 'SOMETHING_NEW 1 2 3\n');
});
