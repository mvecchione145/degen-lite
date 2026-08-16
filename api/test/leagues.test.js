import test from 'node:test';
import assert from 'node:assert/strict';

import { LEAGUES, ingestWeeks, leagueOrThrow } from '../src/leagues.js';

// The league registry is what keeps two very different schedules from being
// hardcoded into the ingester. These assertions pin the facts that were
// measured against ESPN (see docs/data-sources.md) rather than assumed.

test('NFL walks 18 regular weeks and no postseason', () => {
  const weeks = ingestWeeks(LEAGUES.NFL);
  assert.equal(weeks.length, 18);
  assert.deepEqual(weeks[0], { seasontype: 2, week: 1, storeAsWeek: 1 });
  assert.deepEqual(weeks.at(-1), { seasontype: 2, week: 18, storeAsWeek: 18 });
  assert.ok(weeks.every((w) => w.seasontype === 2));
});

test('college walks 16 regular weeks plus a postseason filed as week 17', () => {
  const weeks = ingestWeeks(LEAGUES.NCAAF);
  assert.equal(weeks.length, 17);

  const regular = weeks.filter((w) => w.seasontype === 2);
  assert.equal(regular.length, 16);
  assert.equal(regular.at(-1).week, 16);

  // The whole bowl season lives in ESPN's seasontype=3 week 1. Filing it as
  // week 1 would put 46 bowl games on September's board.
  const post = weeks.at(-1);
  assert.deepEqual(post, { seasontype: 3, week: 1, storeAsWeek: 17 });
});

test('no league stores two slates under the same week', () => {
  for (const league of Object.values(LEAGUES)) {
    const stored = ingestWeeks(league).map((w) => w.storeAsWeek);
    assert.equal(new Set(stored).size, stored.length, `${league.id} has a week collision`);
  }
});

test('college requires the FBS group parameter', () => {
  // Without groups=80 ESPN returns only ranked matchups — 23 events, not 96.
  assert.equal(LEAGUES.NCAAF.espnParams.groups, '80');
  assert.deepEqual(LEAGUES.NFL.espnParams, {});
});

test('the nickname fallback is off for college', () => {
  // 230 teams share ten Bulldogs and nine Wildcats; a last-word match would
  // write another game's spread onto the board.
  assert.equal(LEAGUES.NCAAF.nicknameFallback, false);
  assert.equal(LEAGUES.NFL.nicknameFallback, true);
});

test('college uses a tighter kickoff window than the NFL', () => {
  // A 60-game Saturday has no room for a two-day tolerance.
  assert.ok(LEAGUES.NCAAF.kickoffToleranceHours < LEAGUES.NFL.kickoffToleranceHours);
});

test('SharpAPI slugs are lowercase', () => {
  // An uppercase league parameter returns 200 with zero rows rather than an
  // error, so this is silent when wrong.
  for (const league of Object.values(LEAGUES)) {
    assert.equal(league.sharpLeague, league.sharpLeague.toLowerCase());
  }
});

test('unknown leagues are rejected loudly', () => {
  assert.throws(() => leagueOrThrow('XFL'), /Unknown league/);
  assert.equal(leagueOrThrow('NFL').id, 'NFL');
});

// A pool can play more than one league. Boards are never merged across them —
// the week numbers describe different weekends — so these check the resolver
// that decides which league a request is asking for.

test('a pool falls back to its anchor league when none is requested', async () => {
  const { assertPoolLeague } = await import('../src/services/bets.js');
  assert.equal(assertPoolLeague({ leagues: ['NFL'] }, null), 'NFL');
  assert.equal(assertPoolLeague({ leagues: ['NFL', 'NCAAF'] }, null), 'NFL');
  assert.equal(assertPoolLeague({ leagues: ['NCAAF'] }, undefined), 'NCAAF');
});

test('a pool accepts any league it plays', async () => {
  const { assertPoolLeague } = await import('../src/services/bets.js');
  const pool = { leagues: ['NFL', 'NCAAF'] };
  assert.equal(assertPoolLeague(pool, 'NFL'), 'NFL');
  assert.equal(assertPoolLeague(pool, 'NCAAF'), 'NCAAF');
});

test('a pool refuses a league it does not play', async () => {
  const { assertPoolLeague } = await import('../src/services/bets.js');
  assert.throws(
    () => assertPoolLeague({ leagues: ['NFL'] }, 'NCAAF'),
    /does not play NCAAF/,
  );
});
