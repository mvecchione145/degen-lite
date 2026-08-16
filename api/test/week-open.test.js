import test from 'node:test';
import assert from 'node:assert/strict';

import { weekIsOpen } from '../src/services/games.js';

// Betting is confined to the current week because a game further out carries a
// stale or seeded number rather than a live price — SharpAPI only prices the
// near slate. placeBet enforces this and getBoard reports it; both read the
// rule from here so the board can never offer a bet the API would refuse.

test('the current week is open', () => {
  assert.equal(weekIsOpen(5, 5), true);
});

test('a future week is closed', () => {
  assert.equal(weekIsOpen(6, 5), false);
  assert.equal(weekIsOpen(18, 5), false);
});

// Past weeks stay open here: their games are individually locked by kickoff
// time, which is the check that actually stops a bet on finished football.
// Closing them by week as well would be a second rule saying the same thing.
test('a past week is left to the per-game kickoff lock', () => {
  assert.equal(weekIsOpen(4, 5), true);
  assert.equal(weekIsOpen(1, 5), true);
});

// A league with no games loaded has no current week. Every board in that state
// is empty, so there is nothing to bet on regardless.
test('an unknown current week does not close the board', () => {
  assert.equal(weekIsOpen(1, null), true);
  assert.equal(weekIsOpen(18, null), true);
});

// The season's last week is the fallback getCurrentWeek returns once every game
// has kicked off, so it must not read as a future week and shut the board.
test('the final week stays open once the season is over', () => {
  assert.equal(weekIsOpen(18, 18), true);
});
