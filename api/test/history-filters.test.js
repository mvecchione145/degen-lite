import test from 'node:test';
import assert from 'node:assert/strict';

import { historyWhere } from '../src/services/bets.js';

// historyWhere builds the WHERE for the pool history. It interpolates
// parameter *indices* into SQL, so an off-by-one silently binds a filter to
// the wrong value — these pin the numbering as much as the clauses.

const POOL = '11111111-1111-1111-1111-111111111111';
const ME = '22222222-2222-2222-2222-222222222222';

test('with no filters it scopes to the pool and the reveal rule', () => {
  const { where, params } = historyWhere(POOL, ME, {});
  assert.deepEqual(params, [POOL, ME]);
  assert.match(where, /b\.pool_id = \$1/);
  // Another member's bets stay hidden until their game kicks off.
  assert.match(where, /b\.user_id = \$2 OR g\.kickoff_time <= CURRENT_TIMESTAMP/);
});

test('every filter binds a parameter, numbered in order', () => {
  const { where, params } = historyWhere(POOL, ME, {
    user_id: 'u', league: 'NFL', week: 3, status: 'WON', market: 'SPREAD',
  });
  assert.deepEqual(params, [POOL, ME, 'u', 'NFL', 3, 'WON', 'SPREAD']);
  assert.match(where, /b\.user_id = \$3/);
  assert.match(where, /g\.league = \$4/);
  assert.match(where, /g\.week = \$5/);
  assert.match(where, /b\.status = \$6/);
  assert.match(where, /b\.market = \$7/);
});

test('an absent filter is not applied rather than matching nothing', () => {
  const { where, params } = historyWhere(POOL, ME, { league: undefined, status: null });
  assert.equal(params.length, 2);
  assert.doesNotMatch(where, /g\.league/);
  assert.doesNotMatch(where, /b\.status/);
});

test('the date range applies to kickoff by default', () => {
  const { where, params } = historyWhere(POOL, ME, { from: 'A', to: 'B' });
  assert.match(where, /g\.kickoff_time >= \$3/);
  assert.match(where, /g\.kickoff_time < \$4/);
  assert.deepEqual(params.slice(2), ['A', 'B']);
});

test('date_field=placed moves the range to when the bet was struck', () => {
  const { where } = historyWhere(POOL, ME, { date_field: 'placed', from: 'A' });
  assert.match(where, /b\.placed_at >= \$3/);
  assert.doesNotMatch(where, /kickoff_time >=/);
});

test('the upper bound is exclusive', () => {
  // The client sends the start of the day *after* the one picked, so a range
  // covers whole local days without dropping a late kickoff on the last one.
  const { where } = historyWhere(POOL, ME, { to: 'B' });
  assert.match(where, /g\.kickoff_time < \$3/);
  assert.doesNotMatch(where, /kickoff_time <= \$3/);
});

test('filter values are never interpolated into the SQL', () => {
  const evil = "'; DROP TABLE bets; --";
  const { where, params } = historyWhere(POOL, ME, { user_id: evil });
  assert.doesNotMatch(where, /DROP TABLE/);
  assert.ok(params.includes(evil));
});
