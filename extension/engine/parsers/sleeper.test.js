import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSleeperRosterSlots,
  mapSleeperScoringToEngine,
  readSleeperDraftIdFromPath,
  resolveSleeperOwnRosterId,
  newSleeperPicks,
  mapSleeperRosterNames,
  buildSleeperIdentityHint,
} from './sleeper.js';

// Real settings object from GET https://api.sleeper.app/v1/draft/1313664076768870400
// — Will's own live "Seattle Bombers - Dynasty" draft.
const REAL_DRAFT_SETTINGS = {
  teams: 10,
  rounds: 23,
  slots_qb: 2,
  slots_rb: 2,
  slots_wr: 3,
  slots_te: 1,
  slots_flex: 2,
  slots_bn: 10,
  pick_timer: 7200,
  nomination_timer: 60,
};

// Real scoring_settings object from GET https://api.sleeper.app/v1/league/1313664075288285184
const REAL_SCORING_SETTINGS = {
  blk_kick: 0.0,
  def_st_ff: 0.0,
  def_st_fum_rec: 0.0,
  def_st_td: 0.0,
  def_td: 0.0,
  ff: 0.0,
  fgm_0_19: 0.0,
  fgm_20_29: 0.0,
  fgm_30_39: 0.0,
  fgm_40_49: 0.0,
  fgm_50_59: 0.0,
  fgm_60p: 0.0,
  fgmiss: 0.0,
  fum: 0.0,
  fum_lost: -2.0,
  fum_rec: 0.0,
  fum_rec_td: 6.0,
  int: 0.0,
  pass_2pt: 2.0,
  pass_int: -2.0,
  pass_td: 4.0,
  pass_yd: 0.02,
  pts_allow_0: 0.0,
  pts_allow_14_20: 0.0,
  pts_allow_1_6: 0.0,
  pts_allow_21_27: 0.0,
  pts_allow_28_34: 0.0,
  pts_allow_35p: 0.0,
  pts_allow_7_13: 0.0,
  rec: 0.5,
  rec_2pt: 2.0,
  rec_td: 6.0,
  rec_yd: 0.05,
  rush_2pt: 2.0,
  rush_td: 6.0,
  rush_yd: 0.05,
  sack: 0.0,
  safe: 0.0,
  st_ff: 1.0,
  st_fum_rec: 1.0,
  st_td: 6.0,
  xpm: 0.0,
  xpmiss: 0.0,
};

describe('mapSleeperRosterSlots', () => {
  test('maps the confirmed real fields directly', () => {
    const result = mapSleeperRosterSlots(REAL_DRAFT_SETTINGS);
    assert.equal(result.QB, 2);
    assert.equal(result.RB, 2);
    assert.equal(result.WR, 3);
    assert.equal(result.TE, 1);
    assert.equal(result.FLEX, 2);
    assert.equal(result.BENCH, 10);
  });

  test('falls back to 0 for slots_def/slots_k when absent, rather than guessing', () => {
    const result = mapSleeperRosterSlots(REAL_DRAFT_SETTINGS);
    assert.equal(result.DST, 0);
    assert.equal(result.K, 0);
  });

  test('returns null for missing settings rather than throwing', () => {
    assert.equal(mapSleeperRosterSlots(undefined), null);
  });
});

describe('mapSleeperScoringToEngine', () => {
  test('inverts points-per-yard into the engine\'s yards-per-point convention', () => {
    const { scoringRules } = mapSleeperScoringToEngine(REAL_SCORING_SETTINGS);
    assert.equal(scoringRules.passYardsPerPoint, 50); // 1 / 0.02
    assert.equal(scoringRules.rushYardsPerPoint, 20); // 1 / 0.05
    assert.equal(scoringRules.recYardsPerPoint, 20); // 1 / 0.05
  });

  test('maps scalar offense fields directly', () => {
    const { scoringRules } = mapSleeperScoringToEngine(REAL_SCORING_SETTINGS);
    assert.equal(scoringRules.passTd, 4);
    assert.equal(scoringRules.interception, -2);
    assert.equal(scoringRules.rushTd, 6);
    assert.equal(scoringRules.receptionPoints, 0.5);
    assert.equal(scoringRules.recTd, 6);
    assert.equal(scoringRules.fumbleLost, -2);
  });

  test('builds pointsAllowedTiers directly from the pts_allow_X buckets', () => {
    const { scoringRules } = mapSleeperScoringToEngine(REAL_SCORING_SETTINGS);
    assert.deepEqual(scoringRules.pointsAllowedTiers, [
      { max: 0, points: 0 },
      { max: 6, points: 0 },
      { max: 13, points: 0 },
      { max: 20, points: 0 },
      { max: 27, points: 0 },
      { max: 34, points: 0 },
      { max: Infinity, points: 0 },
    ]);
  });

  test('does not warn about field goals when every distance bucket scores the same', () => {
    const { warnings } = mapSleeperScoringToEngine(REAL_SCORING_SETTINGS);
    assert.equal(warnings.some((w) => w.includes('field goals')), false);
  });

  test('warns about field goals when distance buckets actually differ', () => {
    const { warnings } = mapSleeperScoringToEngine({ ...REAL_SCORING_SETTINGS, fgm_50_59: 5 });
    assert.equal(warnings.some((w) => w.includes('field goals')), true);
  });

  test('returns empty rules with a warning rather than throwing when scoring is missing', () => {
    const result = mapSleeperScoringToEngine(undefined);
    assert.deepEqual(result.scoringRules, {});
    assert.equal(result.warnings.length > 0, true);
  });
});

describe('readSleeperDraftIdFromPath', () => {
  test('extracts the draft id from a real confirmed URL path', () => {
    // Confirmed live: https://sleeper.com/draft/nfl/1313664076768870400
    assert.equal(readSleeperDraftIdFromPath('/draft/nfl/1313664076768870400'), '1313664076768870400');
  });

  test('returns null for a non-draft path', () => {
    assert.equal(readSleeperDraftIdFromPath('/fantasy-football'), null);
  });

  test('returns null for an empty/missing path', () => {
    assert.equal(readSleeperDraftIdFromPath(undefined), null);
  });
});

describe('resolveSleeperOwnRosterId', () => {
  // Real draft_order/slot_to_roster_id from Will's own live draft
  // (GET /v1/draft/1313664076768870400), and his real Sleeper user_id —
  // confirmed live: this user_id sits at pick slot 2, which maps to
  // roster_id 8, matching the draft room's own displayed "1.2" position.
  // This function itself takes an already-clean digit string; the raw
  // localStorage.getItem('user_id') value is actually JSON-encoded (a
  // quoted string) — a real bug found live where that quoting was never
  // stripped before reaching here, so lookups against draft_order's bare-
  // digit keys always missed. See dom/sleeper.js's readSleeperUserId for
  // the fix; this test's job is just resolveSleeperOwnRosterId's own
  // lookup logic, given a correctly-unquoted id.
  const REAL_DRAFT_ORDER = {
    '1266526977318203392': 9,
    '1388147317244194816': 8,
    '1388198676932857856': 4,
    '1388594262840471552': 3,
    '1388621890322452480': 10,
    '1390452489643368448': 2,
    '1390839354389196800': 7,
    '1400715041967247360': 1,
    '473555074711285760': 5,
    '863854472621826048': 6,
  };
  const REAL_SLOT_TO_ROSTER_ID = {
    1: 10,
    2: 8,
    3: 6,
    4: 5,
    5: 3,
    6: 2,
    7: 9,
    8: 4,
    9: 1,
    10: 7,
  };
  const draft = { draft_order: REAL_DRAFT_ORDER, slot_to_roster_id: REAL_SLOT_TO_ROSTER_ID };

  test('resolves a real confirmed user_id to its real roster_id', () => {
    assert.equal(resolveSleeperOwnRosterId(draft, '1390452489643368448'), 8);
  });

  test('resolves a different real user_id to its own different roster_id', () => {
    assert.equal(resolveSleeperOwnRosterId(draft, '1400715041967247360'), 10);
  });

  test('returns null for a user_id not in this draft', () => {
    assert.equal(resolveSleeperOwnRosterId(draft, 'not-a-real-user'), null);
  });

  test('returns null when draft or userId is missing, rather than throwing', () => {
    assert.equal(resolveSleeperOwnRosterId(null, '1390452489643368448'), null);
    assert.equal(resolveSleeperOwnRosterId(draft, null), null);
  });
});

describe('mapSleeperRosterNames', () => {
  const rosters = [
    { roster_id: 8, owner_id: 'u1' },
    { roster_id: 10, owner_id: 'u2' },
    { roster_id: 4, owner_id: 'u3' }, // no matching user below
  ];
  const users = [
    { user_id: 'u1', display_name: 'wdenmaniv', metadata: { team_name: 'The Seattle Bombers - Dynasty' } },
    { user_id: 'u2', display_name: 'brucecheddaz' }, // no custom team_name set
  ];

  test('prefers the custom team_name when a user has set one', () => {
    const names = mapSleeperRosterNames(rosters, users);
    assert.equal(names[8], 'The Seattle Bombers - Dynasty');
  });

  test('falls back to display_name when no team_name is set', () => {
    const names = mapSleeperRosterNames(rosters, users);
    assert.equal(names[10], 'brucecheddaz');
  });

  test('falls back to a generic "Team N" label when no user matches the roster', () => {
    const names = mapSleeperRosterNames(rosters, users);
    assert.equal(names[4], 'Team 4');
  });

  test('returns {} rather than throwing when rosters/users are missing', () => {
    assert.deepEqual(mapSleeperRosterNames(null, users), {});
    assert.deepEqual(mapSleeperRosterNames(rosters, undefined), {});
  });
});

describe('newSleeperPicks', () => {
  test('returns only picks not already seen, mapped to the shared event shape', () => {
    const picks = [
      { pick_no: 1, roster_id: 10, player_id: '4429025', metadata: null },
      { pick_no: 2, roster_id: 8, player_id: '4038941', metadata: null },
    ];
    const result = newSleeperPicks(picks, new Set([1]));
    assert.deepEqual(result, [{ pickNo: 2, teamId: 8, playerId: '4038941', identityHint: null }]);
  });

  // Real pick object from GET /v1/draft/1313664076768870400/picks — the
  // metadata field this test exercises is what makeidentityHint depends on.
  test('builds identityHint from a real captured pick object', () => {
    const picks = [
      {
        pick_no: 1,
        roster_id: 10,
        player_id: '9488',
        metadata: {
          first_name: 'Jaxon',
          last_name: 'Smith-Njigba',
          position: 'WR',
          team: 'SEA',
        },
      },
    ];
    const result = newSleeperPicks(picks, new Set());
    assert.deepEqual(result[0].identityHint, { name: 'Jaxon Smith-Njigba', position: 'WR', team: 'SEA' });
  });

  // Regression test for a real, 100%-reproducible bug: Sleeper reports
  // every team defense's position as "DEF" (confirmed live against
  // api.sleeper.app/v1/players/nfl's own real defense entries), but
  // players-2026.json uses "DST" throughout (FantasyPros' own
  // convention). matchPlayer filters by position before comparing names
  // at all, so every single Sleeper defense pick failed to match,
  // unconditionally — not a rare timing issue, every DST pick in every
  // Sleeper draft. Confirmed the real team-defense metadata shape below
  // matches Sleeper's own player database exactly (first_name/last_name
  // are the city/team name, e.g. "San Francisco"/"49ers").
  test('normalizes Sleeper\'s "DEF" position to "DST" (players-2026.json\'s convention) for a real defense pick', () => {
    const picks = [
      {
        pick_no: 1,
        roster_id: 3,
        player_id: 'SF',
        metadata: {
          first_name: 'San Francisco',
          last_name: '49ers',
          position: 'DEF',
          team: 'SF',
        },
      },
    ];
    const result = newSleeperPicks(picks, new Set());
    assert.equal(result[0].identityHint.position, 'DST');
  });

  test('returns an empty array once the picks endpoint has no picks yet (confirmed live: a draft at pick 1 returns [])', () => {
    assert.deepEqual(newSleeperPicks([], new Set()), []);
  });

  test('tolerates a non-array response rather than throwing', () => {
    assert.deepEqual(newSleeperPicks(null, new Set()), []);
  });
});

// Regression coverage for a real, live bug: buildSleeperIdentityHint is
// exported separately (not just inlined into newSleeperPicks) specifically
// so background.js can call it a SECOND time, on a retry pass, for picks
// whose metadata was still null on the poll tick that first saw them —
// confirmed live: Jameson Williams stayed "available" for several picks
// after actually being drafted because that first tick's null metadata
// meant matchPlayer never ran, and the pick was already marked seen. These
// two cases are exactly what that retry pass depends on: null metadata
// (not yet populated by Sleeper) must produce a null hint rather than
// throwing, and populated metadata on a later tick must resolve correctly
// even though the pick itself is "old" by then.
describe('buildSleeperIdentityHint', () => {
  test('returns null when Sleeper has not populated metadata for this pick yet', () => {
    assert.equal(buildSleeperIdentityHint({ pick_no: 5, player_id: '9488', metadata: null }), null);
  });

  test('builds the same identityHint shape newSleeperPicks does, once metadata catches up', () => {
    const pick = {
      pick_no: 5,
      player_id: '9488',
      metadata: { first_name: 'Jaxon', last_name: 'Smith-Njigba', position: 'WR', team: 'SEA' },
    };
    assert.deepEqual(buildSleeperIdentityHint(pick), { name: 'Jaxon Smith-Njigba', position: 'WR', team: 'SEA' });
  });
});
