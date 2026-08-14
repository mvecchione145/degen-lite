import test from 'node:test';
import assert from 'node:assert/strict';

import { homeSpread } from '../src/services/ingest.js';

// homeSpread turns ESPN's odds blob into our convention: the spread is always
// the home team's line, negative when the home team is favoured.
//
// Every string below was taken from a live ESPN scoreboard response rather than
// invented, because the failure this guards against is silent — an unparsed
// string returns 0, which is indistinguishable from a genuine pick'em and puts
// a fabricated line in front of members betting real balances.

const odds = (details, overUnder = null) => ({ details, overUnder });

test('reads the home line when the home team is favoured', () => {
  assert.equal(homeSpread(odds('KC -3.5'), 'KC'), -3.5);
  assert.equal(homeSpread(odds('SEA -3.5'), 'SEA'), -3.5);
  assert.equal(homeSpread(odds('USC -38.5'), 'USC'), -38.5);
});

test('negates the line when the away team is favoured', () => {
  // ESPN names the favourite, not the home team, so the sign has to be
  // resolved against the home abbreviation.
  assert.equal(homeSpread(odds('KC -3.5'), 'DEN'), 3.5);
  assert.equal(homeSpread(odds('TA&M -14.5'), 'MOST'), 14.5);
});

test('parses college abbreviations containing punctuation', () => {
  // The reason this test exists. A letters-only pattern drops these three, and
  // Texas A&M alone accounted for 2 of 115 priced games in the first five weeks
  // of the 2026 season — each one posted as a pick'em instead of a blowout.
  assert.equal(homeSpread(odds('TA&M -39.5'), 'TA&M'), -39.5);
  assert.equal(homeSpread(odds('M-OH +3'), 'M-OH'), 3);
  assert.equal(homeSpread(odds('W&M -7'), 'W&M'), -7);
});

test('handles a neutral-site game like any other', () => {
  // Neutral sites still carry a home side in the payload; nothing special.
  assert.equal(homeSpread(odds('TCU -7.5', 47.5), 'TCU'), -7.5);
  assert.equal(homeSpread(odds('TCU -7.5', 47.5), 'UNC'), 7.5);
});

test('treats an unparseable string as no line rather than guessing', () => {
  // 0 is the correct answer for a pick'em, and the safe answer for anything
  // this function cannot read with confidence.
  for (const details of ['EVEN', 'PK', 'OFF', '', 'KC', 'KC -', '-3.5']) {
    assert.equal(homeSpread(odds(details), 'KC'), 0, `expected 0 for ${JSON.stringify(details)}`);
  }
});

test('tolerates a missing or malformed odds object', () => {
  // Not every game is priced, and the scoreboard omits the block entirely.
  assert.equal(homeSpread(undefined, 'KC'), 0);
  assert.equal(homeSpread(null, 'KC'), 0);
  assert.equal(homeSpread({}, 'KC'), 0);
  assert.equal(homeSpread({ details: 42 }, 'KC'), 0);
});

test('does not match an abbreviation longer than any real one', () => {
  // Guards the upper bound: the longest abbreviation across 230 college teams
  // is 4 characters, so a 13-character token is a malformed string, not a team.
  assert.equal(homeSpread(odds('SOMETHINGLONG -3'), 'SOMETHINGLONG'), 0);
});
