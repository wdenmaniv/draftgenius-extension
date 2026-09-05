import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idFromDefaultName, buildSpendLedger, resolveTeamIds } from './identity.js';

test('idFromDefaultName reads the id straight out of ESPN\'s default team name', () => {
  // Confirmed live: the DOM's "on the clock" team was named "Team 5" at the
  // same moment the WS stream said `NOMINATION 5 ...`.
  assert.equal(idFromDefaultName('Team 5'), 5);
  assert.equal(idFromDefaultName('Team 12'), 12);
});

test('idFromDefaultName returns null for a custom team name', () => {
  assert.equal(idFromDefaultName("Will's Wild Team"), null);
});

test('buildSpendLedger sums price by team across sold events', () => {
  const ledger = buildSpendLedger([
    { teamId: 1, price: 46 },
    { teamId: 2, price: 12 },
    { teamId: 1, price: 8 },
  ]);
  assert.deepEqual(ledger, { 1: 54, 2: 12 });
});

test('resolveTeamIds resolves default-named teams immediately, no ledger needed', () => {
  const resolved = resolveTeamIds({
    ledger: {},
    domTeams: [{ name: 'Team 5', remainingBudget: 200 }],
    startingBudget: 200,
  });
  assert.deepEqual(resolved, { 'Team 5': 5 });
});

test('resolveTeamIds resolves a custom-named team by matching its remaining budget to a unique ledger id', () => {
  const domTeams = [
    { name: "Will's Wild Team", remainingBudget: 154 }, // 200 - 46
    { name: 'Team 5', remainingBudget: 188 }, // 200 - 12
  ];
  const ledger = buildSpendLedger([
    { teamId: 6, price: 46 },
    { teamId: 5, price: 12 },
  ]);

  const resolved = resolveTeamIds({ ledger, domTeams, startingBudget: 200 });
  assert.equal(resolved['Team 5'], 5); // from the default-name rule
  assert.equal(resolved["Will's Wild Team"], 6); // from the unique budget match
});

test('resolveTeamIds leaves a custom-named team unresolved when two ledger ids tie on budget', () => {
  const domTeams = [{ name: 'Ambiguous Team', remainingBudget: 150 }];
  const ledger = buildSpendLedger([
    { teamId: 3, price: 50 },
    { teamId: 4, price: 50 },
  ]);
  const resolved = resolveTeamIds({ ledger, domTeams, startingBudget: 200 });
  assert.equal(resolved['Ambiguous Team'], undefined);
});

test('resolveTeamIds does NOT eliminate-resolve when numTeams is omitted', () => {
  const domTeams = [
    { name: 'Team 5', remainingBudget: 200 },
    { name: 'Mystery Team', remainingBudget: 999 }, // won't match any ledger id
  ];
  const ledger = buildSpendLedger([{ teamId: 1, price: 10 }]);
  const resolved = resolveTeamIds({ ledger, domTeams, startingBudget: 200 });
  assert.equal(resolved['Mystery Team'], undefined);
});

test('resolveTeamIds eliminates the last name to the last unclaimed id even when its budget match fails', () => {
  // Real scenario, live 8-team ESPN draft: capture started mid-draft, so the
  // ledger understates every team's true spend by whatever they'd already
  // paid before capture began. That happened to be $0 for "will's Wild
  // Team" (id 6) so its exact match still worked, but every other team had
  // already spent something pre-capture — "Chad's Competitive Team" (the
  // only other custom name) has $15 left, which doesn't equal
  // 200 - ledger[1]=162=$38. It's still unambiguously id 1: every other id
  // (2-8) was already claimed by a default-named team or by id 6, leaving
  // exactly one id and one name.
  const ledger = { 1: 162, 2: 130, 3: 44, 4: 60, 5: 92, 6: 99, 7: 47, 8: 186 };
  const domTeams = [
    { name: "will's Wild Team", remainingBudget: 101 }, // 200 - 99, matches id 6 exactly
    { name: 'Team 5', remainingBudget: 39 },
    { name: 'Team 4', remainingBudget: 127 },
    { name: 'Team 8', remainingBudget: 14 },
    { name: "Chad's Competitive Team", remainingBudget: 15 }, // does NOT match 200 - 162
    { name: 'Team 2', remainingBudget: 10 },
    { name: 'Team 3', remainingBudget: 66 },
    { name: 'Team 7', remainingBudget: 12 },
  ];

  const resolved = resolveTeamIds({ ledger, domTeams, startingBudget: 200, numTeams: 8 });
  assert.equal(resolved["will's Wild Team"], 6);
  assert.equal(resolved["Chad's Competitive Team"], 1); // via elimination, not budget match
  assert.deepEqual(new Set(Object.values(resolved)), new Set([1, 2, 3, 4, 5, 6, 7, 8]));
});

test('resolveTeamIds carries forward already-resolved mappings across calls and excludes their ids from future matching', () => {
  const domTeams = [
    { name: 'Team A', remainingBudget: 150 },
    { name: 'Team B', remainingBudget: 150 },
  ];
  // Both teams spent 50, so budget alone is ambiguous between ids 1 and 2 —
  // but if Team A was already resolved to id 1 in a prior pass, Team B
  // should NOT be allowed to also claim id 1 even though its budget matches.
  const ledger = buildSpendLedger([
    { teamId: 1, price: 50 },
    { teamId: 2, price: 50 },
  ]);
  const resolved = resolveTeamIds({
    ledger,
    domTeams,
    startingBudget: 200,
    alreadyResolved: { 'Team A': 1 },
  });
  assert.equal(resolved['Team A'], 1);
  assert.equal(resolved['Team B'], 2);
});
