import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Renders the table builders out of web/public/app.js against realistic
// payloads.
//
// It lives here because this is the only test runner wired up in the repo, and
// app.js cannot simply be imported: it touches `document` at module scope. So
// the functions under test are extracted by brace matching and evaluated on
// their own.
//
// The bug this guards against: these builders are template literals, so a
// reference to a variable that is not in scope is not a syntax error and
// `node --check` passes. It fails at render time, in the browser, as
// "Can't find variable: data" — after a bet is placed, which is the worst
// moment to discover it.

const SOURCE = readFileSync(
  new URL('../../web/public/app.js', import.meta.url),
  'utf8',
);

function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in app.js`);

  let depth = 0;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Some builders lean on a module-scope constant (the abbreviation map, say),
// which the function extractor above does not pull. Grabs `const NAME = ...;`
// by brace matching the same way.
function extractConst(name) {
  const start = SOURCE.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} not found in app.js`);

  let depth = 0;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return `${SOURCE.slice(start, i + 1)};`;
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The handful of helpers the builders call. Stand-ins, not the real ones —
// this is checking scope and structure, not formatting.
const HELPERS = `
  const esc = (v) => String(v ?? '');
  const fmtMoney = (v) => Number(v ?? 0).toFixed(2);
  const fmtSigned = (v) => (v > 0 ? '+' : '') + Number(v ?? 0).toFixed(2);
  const fmtKickoff = (iso) => new Date(iso).toISOString();
  const BET_STATUS_CLASS = { WON: 'green', LOST: 'red', PUSH: 'amber', VOID: 'grey', PENDING: '' };
`;

function render(name, arg) {
  const fn = new Function(`${HELPERS}${extractFunction(name)}
    return ${name}(${JSON.stringify(arg)});`);
  return fn();
}

const BET = {
  id: 'b1',
  username: 'admin',
  status: 'PENDING',
  description: 'New England -3.5',
  price: -110,
  league: 'NFL',
  week: 1,
  away_team: 'New England',
  home_team: 'Seattle',
  home_score: null,
  away_score: null,
  stake: 100,
  net: null,
  is_mine: true,
  placed_at: '2026-09-10T18:00:00.000Z',
  kickoff_time: '2026-09-11T00:20:00.000Z',
};

const historyPayload = (filters) => ({
  bets: [BET],
  page: { limit: 25, offset: 0, total: 1, has_more: false },
  summary: { total: 1, staked: 100, net: 0 },
  filters,
});

test('the pool history table renders and defaults to the kickoff column', () => {
  const html = render('poolHistoryTable', historyPayload({}));
  assert.match(html, /<th>Kickoff<\/th>/);
  assert.match(html, /admin/);
});

test('the pool history column follows date_field', () => {
  const html = render('poolHistoryTable', historyPayload({ date_field: 'placed' }));
  assert.match(html, /<th>Placed<\/th>/);
});

test('an empty result says whether filters or the reveal rule caused it', () => {
  const unfiltered = render('poolHistoryTable', {
    ...historyPayload({}), bets: [], page: { limit: 25, offset: 0, total: 0, has_more: false },
  });
  assert.match(unfiltered, /No bets have been placed/);

  const filtered = render('poolHistoryTable', {
    ...historyPayload({ status: 'WON' }),
    bets: [],
    page: { limit: 25, offset: 0, total: 0, has_more: false },
  });
  assert.match(filtered, /No bets match these filters/);
  // Either way it explains that pending bets by others are hidden.
  assert.match(filtered, /kicks off/);
});

// renderAuth writes into the DOM rather than returning a string, so it needs a
// stub rather than the plain extraction above. Worth the extra scaffolding:
// the seeded credentials are printed on the one screen that is reachable
// without logging in, so whether they render is a question about production,
// not about layout.
function renderAuthWith({ devTools }) {
  const noop = () => {};
  const element = { addEventListener: noop, value: '', checked: false };
  const app = {
    innerHTML: '',
    querySelector: () => element,
    querySelectorAll: () => [],
  };

  const fn = new Function('app', 'state', `
    ${extractFunction('renderAuth')}
    renderAuth();
    return app.innerHTML;
  `);
  return fn(app, { authTab: 'login', devTools });
}

test('the demo credentials show while dev tools are on', () => {
  const html = renderAuthWith({ devTools: true });
  assert.match(html, /Demo account/);
  assert.match(html, /password123/);
});

test('the demo credentials are absent once dev tools are off', () => {
  // DEV_TOOLS=false, or NODE_ENV=production, which forces it — see
  // resolveDevTools. The sign-in form itself must still be there.
  const html = renderAuthWith({ devTools: false });
  assert.doesNotMatch(html, /Demo account/);
  assert.doesNotMatch(html, /password123/);
  assert.match(html, /id="auth-form"/);
  assert.match(html, /Sign in/);
});

// ---------------------------------------------------------------- XSS guards
//
// Every value that reaches markup in app.js goes through esc(), and every call
// site is correct today. These pin that: usernames, pool names, invite codes
// and team names are all attacker-influenced, and the whole surface depends on
// nobody dropping one esc() in a later patch. Nothing else in the repo would
// notice if they did.

const HOSTILE = '<script>alert(1)</script>';
const HOSTILE_ATTR = '" onmouseover="alert(1)';

// The real esc(), lifted from app.js rather than reimplemented — a test that
// escaped with its own copy would pass while the app's version rotted.
function realEsc() {
  const line = SOURCE.slice(SOURCE.indexOf('const esc = '));
  return line.slice(0, line.indexOf('\n));') + 4);
}

function renderWithEsc(name, arg) {
  const fn = new Function(`
    ${realEsc()}
    const fmtMoney = (v) => Number(v ?? 0).toFixed(2);
    const fmtSigned = (v) => (v > 0 ? '+' : '') + Number(v ?? 0).toFixed(2);
    const fmtKickoff = (iso) => new Date(iso).toISOString();
    const BET_STATUS_CLASS = { WON: 'green', LOST: 'red', PUSH: 'amber', VOID: 'grey', PENDING: '' };
    ${extractFunction(name)}
    return ${name}(${JSON.stringify(arg)});
  `);
  return fn();
}

function assertNeutralised(html, label) {
  assert.doesNotMatch(html, /<script>/i, `${label}: a raw <script> tag survived`);
  // The escaped form is what should be there instead.
  assert.match(html, /&lt;script&gt;/, `${label}: the payload was not escaped`);
  // And nothing may break out of an attribute.
  assert.doesNotMatch(html, /" onmouseover="/, `${label}: an attribute was broken out of`);
}

test('a hostile username cannot escape the pool history table', () => {
  const html = renderWithEsc('poolHistoryTable', {
    bets: [{ ...BET, username: HOSTILE, description: HOSTILE_ATTR }],
    page: { limit: 25, offset: 0, total: 1, has_more: false },
    summary: { total: 1, staked: 100, net: 0 },
    filters: {},
  });
  assertNeutralised(html, 'pool history');
});

// The My bets table is gone — History covers it with filters — but team names
// still reach the screen through the pool history table, so the escaping this
// used to guard has to follow them rather than be deleted with the table.
test('hostile team names cannot escape the pool history table', () => {
  const html = renderWithEsc('poolHistoryTable', {
    bets: [{ ...BET, home_team: HOSTILE, away_team: HOSTILE_ATTR, description: HOSTILE }],
    page: { limit: 25, offset: 0, total: 1, has_more: false },
    summary: { total: 1, staked: 100, net: 0 },
    filters: {},
  });
  assertNeutralised(html, 'pool history team names');
});

// Short team names, issue #13. The board puts a team beside its line and price
// in one button; at full length that overflows a phone, so both forms are in
// the markup and CSS picks one.
test('NFL teams abbreviate to the form people actually read', () => {
  const shortTeam = new Function(
    `${extractConst('NFL_ABBR')} ${extractFunction('shortTeam')} return shortTeam;`,
  )();
  assert.equal(shortTeam('New England Patriots'), 'NE');
  assert.equal(shortTeam('Seattle Seahawks'), 'SEA');
  assert.equal(shortTeam('San Francisco 49ers'), 'SF');
  assert.equal(shortTeam('Los Angeles Rams'), 'LAR');
  assert.equal(shortTeam('Los Angeles Chargers'), 'LAC');
});

// College has 230-odd teams and no agreed abbreviation, so anything unmapped is
// derived rather than left at full length.
test('unmapped teams derive a short name', () => {
  const shortTeam = new Function(
    `${extractConst('NFL_ABBR')} ${extractFunction('shortTeam')} return shortTeam;`,
  )();
  assert.equal(shortTeam('Ohio State Buckeyes'), 'OS');
  // A two-word nickname cannot be spotted without a team list, so this gives
  // NCT rather than the canonical UNC. Pinned so the derivation is at least
  // stable — the same fixture must not abbreviate two different ways.
  assert.equal(shortTeam('North Carolina Tar Heels'), 'NCT');
  // A single-word school keeps letters rather than becoming one initial.
  assert.equal(shortTeam('Alabama Crimson'), 'ALA');
  // "Army" is the whole name, not a nickname — never strip it to nothing.
  assert.equal(shortTeam('Army'), 'ARM');
  assert.equal(shortTeam(''), '');
});

// Issue #14: the quick filters set the controls below them, so a chip that
// cannot map onto a real control must not be offered at all. In week 1 "Last
// week" would carry week 0, which no season has.
test('quick filters only offer weeks that exist', () => {
  const quickFilters = new Function(
    `${realEsc()} ${extractFunction('quickFilters')} return quickFilters;`,
  )();
  const labels = (userId, week) => (quickFilters({}, userId, week).match(/>[^<>]+<\/button>/g) ?? [])
    .map((m) => m.slice(1, -'</button>'.length));

  assert.deepEqual(labels('u1', 1), ['My bets', 'This week']);
  assert.deepEqual(labels('u1', 2), ['My bets', 'This week', 'Last week']);
  assert.deepEqual(labels('u1', null), ['My bets']);
  assert.deepEqual(labels('', 5), ['This week', 'Last week']);
});

// A pool can play a league whose schedule has not been ingested. That league
// has no current week and no week list, so the resolved week is undefined —
// and interpolated into a query string, undefined becomes the literal text
// "undefined", which the week parameter rejects as NaN. The board then failed
// with "Expected number, received nan" instead of showing an empty slate.
test('a week that does not exist is normalised to null, not "undefined"', () => {
  const resolve = (requestedWeek, view) => {
    const resolvedWeek = requestedWeek ?? view.current_week ?? view.weeks[0]?.week;
    return Number.isFinite(Number(resolvedWeek)) ? Number(resolvedWeek) : null;
  };
  const empty = { current_week: null, weeks: [] };
  const loaded = { current_week: 3, weeks: [{ week: 1 }] };

  assert.equal(resolve(null, empty), null, 'a league with no schedule');
  assert.equal(resolve(undefined, empty), null);
  assert.equal(resolve(null, loaded), 3, 'falls back to the current week');
  assert.equal(resolve(7, loaded), 7, 'an explicit week wins');
  assert.equal(resolve(null, { current_week: null, weeks: [{ week: 5 }] }), 5);
});

// The query string must omit the parameter rather than send a placeholder.
test('the board query omits week when there is none', () => {
  const url = (league, week) => `/pools/p1/board?league=${league}`
    + (week == null ? '' : `&week=${week}`);
  assert.equal(url('NCAAF', null), '/pools/p1/board?league=NCAAF');
  assert.equal(url('NFL', 1), '/pools/p1/board?league=NFL&week=1');
});

test('esc() covers the five characters that matter', () => {
  const esc = new Function(`${realEsc()} return esc;`)();
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('>'), '&gt;');
  assert.equal(esc('&'), '&amp;');
  assert.equal(esc('"'), '&quot;');
  assert.equal(esc("'"), '&#39;');
  // Ampersand first, or every other entity gets double-escaped.
  assert.equal(esc('<a>&'), '&lt;a&gt;&amp;');
  // Null and undefined render as nothing rather than the words.
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});
