// Plays a full season against mock-espn and checks the chain end to end.
//
// scripts/smoke-test.mjs proves each rule in isolation against a single
// fabricated week. This proves they hold *together*, over eighteen of them:
// lines posted, bets placed and locked at kickoff, scores ingested, wagers
// graded, payouts written, stipends granted, members bust, survivors
// eliminated, and a leaderboard that still reconciles to the ledger at the end.
//
// Nothing here fabricates a result. The season comes from mock-espn through the
// real ingester (docs/mock-season.md) — the same URL building, the same
// toGameRow mapping, the same upsert, the same settlement. What this drives is
// only what a member does: place a bet, make a pick.
//
// Run it through scripts/season-test.sh, which stands the stack up pointed at
// the mock and tears it down afterwards.

const BASE = process.env.API_BASE || 'http://localhost:4111/api';
const MOCK = process.env.MOCK_BASE || 'http://localhost:3111';
const PSQL = process.env.SEASON_TEST_PSQL
  || 'docker compose -p lp-season exec -T db psql -U leaguepicks -d leaguepicks';
const LEAGUE = (process.env.SEASON_TEST_LEAGUE || 'NFL').toUpperCase();
// The whole season by default. Cut it short while iterating on the harness
// itself — the invariants are checked every week, not only at the end.
const LAST_WEEK = Number(process.env.SEASON_TEST_WEEKS || (LEAGUE === 'NFL' ? 18 : 16));

const { execSync } = await import('node:child_process');

/* ------------------------------------------------------------------ plumbing */

const call = async (p, { method = 'GET', body, token } = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// One value out of the database. Used for the invariants that are about what
// the tables agree on rather than what an endpoint reports — a balance the API
// computes and a balance the ledger sums to are two different claims, and it is
// the second one that catches a settlement bug.
const sql = (q) => execSync(
  `${PSQL} -tAc ${JSON.stringify(q.replace(/\s+/g, ' ').trim())}`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return true; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
// Weekly invariants run eighteen times; printing every pass buries the run.
// Only failures are loud, with a per-week summary line.
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* --------------------------------------------------------------- the actors */

const s = Math.random().toString(36).slice(2, 7);
const boss = (await call('/auth/login', {
  method: 'POST', body: { login: 'admin', password: 'password123' },
})).data.token;
if (!boss) {
  console.error('Could not log in as admin — is the stack up?');
  process.exit(1);
}

const reg = async (u) => (await call('/auth/register', {
  method: 'POST', body: { username: u, email: `${u}@ex.com`, password: 'password123' },
})).data.token;

// Strategies, not personalities: each one is a rule the harness can apply
// without knowing the score, so what lands in the ledger is decided by the
// season rather than by the test.
const STRATEGIES = {
  chalk: { kind: 'bet', pick: (g) => ({ market: 'SPREAD', selection: Number(g.spread) < 0 ? 'HOME' : 'AWAY' }) },
  dog: { kind: 'bet', pick: (g) => ({ market: 'SPREAD', selection: Number(g.spread) < 0 ? 'AWAY' : 'HOME' }) },
  over: { kind: 'bet', pick: () => ({ market: 'TOTAL', selection: 'OVER' }) },
  under: { kind: 'bet', pick: () => ({ market: 'TOTAL', selection: 'UNDER' }) },
};

const people = {};
for (const name of ['chalk', 'dog', 'over', 'under', 'homer', 'roadie', 'ghost']) {
  const token = await reg(`${name}_${s}`);
  const id = (await call('/auth/me', { token })).data.user.id;
  people[name] = { token, id, name };
}

section('Pools');
const pools = {};
const makePool = async (key, body) => {
  const r = await call('/pools', {
    method: 'POST', token: boss,
    body: { name: `${key} ${s}`, leagues: [LEAGUE], ...body },
  });
  if (!r.data.pool) {
    console.error(`  could not create ${key}: ${JSON.stringify(r.data)}`);
    process.exit(1);
  }
  pools[key] = { ...r.data.pool, key };
  console.log(`  ${key.padEnd(9)} ${r.data.pool.pool_type} / ${r.data.pool.bust_policy}`);
  return pools[key];
};

// Each pool exists to make one part of the chain observable over a season.
await makePool('wagers', {
  pool_type: 'SPREAD_SHARKS', bust_policy: 'ELIMINATE',
  // Three losing bets deep and a member is out. On the default 20,000 — or
  // even on 3,000 against 250 stakes — eighteen weeks of near-even results
  // never empties an account, and the whole bust path sits unexercised while
  // the run still reports green.
  starting_balance: 750, max_bet: 1000,
});
await makePool('topup', {
  pool_type: 'SPREAD_SHARKS', bust_policy: 'TOPUP',
  starting_balance: 2000, max_bet: 1000, stipend_amount: 500,
});
await makePool('survivor', { pool_type: 'SURVIVOR', bust_policy: 'ELIMINATE' });
await makePool('revival', { pool_type: 'SURVIVOR', bust_policy: 'REBUY', rebuy_limit: 2 });

for (const pool of Object.values(pools)) {
  for (const p of Object.values(people)) {
    await call('/pools/join', { method: 'POST', token: p.token, body: { invite_code: pool.invite_code } });
  }
}
// The commissioner is a member of every pool they create, so the field is one
// larger than the cast this script registers.
const FIELD = Number(sql(
  `SELECT COUNT(*) FROM pool_members WHERE pool_id = '${pools.survivor.id}'`));
console.log(`  ${Object.keys(people).length} joined each — a field of ${FIELD} with the commissioner`);

/* ------------------------------------------------------------ season control */

const mockStatus = async () => (await fetch(`${MOCK}/status`)).json();

const ingestAndSettle = async () => {
  const r = await call('/admin/ingest', {
    method: 'POST', token: boss, body: { league: LEAGUE, force: true },
  });
  return r.data;
};

// A week is done when every one of its games has gone final in our own table —
// which is what settlement keys off, and is a stronger condition than the mock
// having moved on.
const weekIsFinal = (week) => sql(
  `SELECT COUNT(*) FILTER (WHERE status <> 'FINAL') = 0 AND COUNT(*) > 0
     FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON} AND week = ${week}`,
) === 't';

section('Loading the season');
await ingestAndSettle();
const SEASON = Number(sql(`SELECT MAX(season) FROM games WHERE league = '${LEAGUE}'`));
const weeksLoaded = Number(sql(
  `SELECT COUNT(DISTINCT week) FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON}`,
));
const gamesLoaded = Number(sql(
  `SELECT COUNT(*) FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON}`,
));
console.log(`  season ${SEASON}: ${gamesLoaded} games across ${weeksLoaded} weeks`);
ok('the whole season is loaded before week 1', weeksLoaded >= LAST_WEEK,
  `${weeksLoaded} weeks < ${LAST_WEEK}`);
ok('every fixture carries a line and a total', sql(
  `SELECT COUNT(*) FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON}
     AND (spread IS NULL OR total IS NULL)`) === '0');
ok('every fixture carries both abbreviations', sql(
  `SELECT COUNT(*) FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON}
     AND (home_team_abbr IS NULL OR away_team_abbr IS NULL)`) === '0');
// The mock ships TA&M, M-OH and W&M precisely because they once parsed as
// pick'ems. A season where every line is 0 would still pass every other check.
ok('no fixture was posted as a pick\'em', sql(
  `SELECT COUNT(*) FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON}
     AND spread = 0`) === '0');

/* ---------------------------------------------------------------- placement */

// Bets and picks go on the *latest* open fixture of the week. Kickoffs are
// staggered across the first half of a week, so by the time the previous week
// has settled the early games are already locked — taking the last one gives
// the harness the most margin before the slate closes.
//
// A wager pool and a pick pool are read through different endpoints: /board
// refuses a survivor pool outright ("this pool takes picks, not wagers"), so
// asking it for one silently yields no games and the pool sits out the season.
const openBoard = async (poolId, week, token) => {
  const r = await call(`/pools/${poolId}/board?league=${LEAGUE}&week=${week}`, { token });
  if (!r.data.week_open) return [];
  return sortByLatestKickoff(r.data.games ?? []);
};

const openWeek = async (poolId, week, token) => {
  const r = await call(`/pools/${poolId}/week/${week}`, { token });
  return {
    games: sortByLatestKickoff(r.data.games ?? []),
    // Survivor spends a team when it picks it: the same side cannot be taken
    // twice in a season. Ignoring this makes every pick after the first a
    // rejection, and a pool where nobody ever picks eliminates everybody for
    // the wrong reason.
    used: new Set((r.data.used_teams ?? []).map((u) => u.team)),
  };
};

const sortByLatestKickoff = (games) => games
  .filter((g) => new Date(g.kickoff_time) > new Date() && g.status === 'SCHEDULED')
  .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time));

const placed = { bets: 0, picks: 0, refused: 0, skipped: 0 };

async function placeWagers(week) {
  for (const key of ['wagers', 'topup']) {
    const pool = pools[key];
    for (const [name, strategy] of Object.entries(STRATEGIES)) {
      const person = people[name];
      const games = await openBoard(pool.id, week, person.token);
      if (games.length === 0) { placed.skipped += 1; continue; }
      const game = games[0];
      const { market, selection } = strategy.pick(game);
      const r = await call(`/pools/${pool.id}/bets`, {
        method: 'POST', token: person.token,
        body: { game_id: game.id, market, selection, stake: 250 },
      });
      if (r.status === 201 || r.status === 200) placed.bets += 1;
      // A refusal is not automatically a fault: a bust member in the ELIMINATE
      // pool is *supposed* to be turned away, and that is asserted separately.
      else placed.refused += 1;
    }
  }
}

async function placePicks(week) {
  for (const key of ['survivor', 'revival']) {
    const pool = pools[key];
    for (const person of Object.values(people)) {
      // The ghost never picks. Missing a week is a loss in survivor, and a
      // season is the honest place to prove that rule bites every week rather
      // than once.
      if (person.name === 'ghost') continue;
      const { games, used } = await openWeek(pool.id, week, person.token);
      if (games.length === 0) { placed.skipped += 1; continue; }

      // Members are spread across the slate rather than piled onto one
      // fixture. With everyone on the same game the week has only two
      // outcomes, and the whole field is wiped or survives together — which
      // makes "the pool narrows" true by accident in one week and never
      // exercises a season of attrition.
      const seat = Object.keys(people).indexOf(person.name);
      const order = games.map((_, i) => games[(seat + i) % games.length]);

      // Homer takes the home side, everyone else the away side — and only a
      // fixture whose team this member has not already spent, because survivor
      // burns a team for the season once it is picked.
      const side = (g) => (person.name === 'homer' ? g.home_team : g.away_team);
      const game = order.find((g) => !used.has(side(g)));
      if (!game) { placed.skipped += 1; continue; }
      const team = side(game);
      const r = await call(`/pools/${pool.id}/picks`, {
        method: 'POST', token: person.token,
        body: { week, picks: [{ game_id: game.id, selected_team: team }] },
      });
      if (r.status === 200 || r.status === 201) placed.picks += 1;
      else placed.refused += 1;
    }
  }
}

/* --------------------------------------------------------------- invariants */

// Checked after every settlement, not only at the end: a balance that stops
// reconciling at week 6 is far easier to understand than one that is merely
// wrong in week 18.
function weeklyInvariants(week) {
  const before = failures.length;

  // The ledger is the source of truth for a balance. If the two disagree,
  // settlement wrote a payout it did not account for.
  ok(`w${week}: every balance reconciles to its ledger`, sql(
    `SELECT COUNT(*) FROM (
       SELECT pm.pool_id, pm.user_id,
              COALESCE((SELECT SUM(amount) FROM ledger_entries le
                         WHERE le.pool_id = pm.pool_id AND le.user_id = pm.user_id), 0) AS ledger,
              COALESCE((SELECT SUM(stake) FROM bets b
                         WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                           AND b.status = 'PENDING'), 0) AS at_risk
         FROM pool_members pm
      ) t WHERE ledger < 0 OR at_risk < 0`) === '0');

  // Settlement is what clears PENDING. A finished game with a live bet on it
  // means a wager was never graded.
  ok(`w${week}: no wager is left pending on a finished game`, sql(
    `SELECT COUNT(*) FROM bets b JOIN games g ON g.id = b.game_id
      WHERE b.status = 'PENDING' AND g.status IN ('FINAL', 'VOID')`) === '0');

  // The arithmetic, checked against the grade rather than recomputed here: a
  // won bet pays stake x 100/110, a lost one costs the stake, a push is flat.
  ok(`w${week}: every settled wager's net matches its grade`, sql(
    `SELECT COUNT(*) FROM bets
      WHERE status = 'WON'  AND net <> ROUND(stake * 100 / 110, 2)
         OR status = 'LOST' AND net <> -stake
         OR status IN ('PUSH', 'VOID') AND net <> 0`) === '0');

  // A bet's whole life nets out to exactly what it won or lost. Placing it
  // writes -stake as STAKE; settling a winner or a push writes stake + net
  // back, and a loser writes nothing further because the stake already left.
  // Either way the entries against that bet must sum to `net` — which catches
  // a missing payout and a double-credited one with the same statement.
  ok(`w${week}: each wager's ledger entries sum to what it won or lost`, sql(
    `SELECT COUNT(*) FROM bets b WHERE b.status <> 'PENDING'
       AND (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries le
             WHERE le.bet_id = b.id) <> b.net`) === '0');

  // A stake is debited once, when the bet is placed.
  ok(`w${week}: every wager was debited exactly once`, sql(
    `SELECT COUNT(*) FROM bets b
      WHERE (SELECT COUNT(*) FROM ledger_entries le
              WHERE le.bet_id = b.id AND le.entry_type = 'STAKE') <> 1`) === '0');

  // Survivor standing is derived — alive exactly when rebuys cover losses — so
  // it can be recomputed here from picks and checked against what is stored.
  ok(`w${week}: survivor standing matches losses against rebuys`, sql(
    `WITH concluded AS (
        SELECT po.id AS pool_id, g.week
          FROM pools po JOIN games g
            ON g.league = po.leagues[1] AND g.season = po.season
         WHERE po.pool_type = 'SURVIVOR'
         GROUP BY po.id, g.week
        HAVING BOOL_AND(g.status IN ('FINAL', 'VOID'))
     ), losses AS (
        SELECT m.pool_id, m.user_id, COUNT(*) AS n
          FROM pool_members m
          JOIN pools po ON po.id = m.pool_id AND po.pool_type = 'SURVIVOR'
          JOIN concluded c ON c.pool_id = m.pool_id
         WHERE m.withdrawn_at IS NULL
           AND c.week >= COALESCE(m.active_from_week, 1)
           AND NOT EXISTS (
             SELECT 1 FROM picks p JOIN games g ON g.id = p.game_id
              WHERE p.pool_id = m.pool_id AND p.user_id = m.user_id
                AND g.league = po.leagues[1] AND g.season = po.season
                AND g.week = c.week AND p.is_correct IS NOT FALSE)
         GROUP BY m.pool_id, m.user_id
     )
     SELECT COUNT(*) FROM pool_members m
       JOIN pools po ON po.id = m.pool_id AND po.pool_type = 'SURVIVOR'
      WHERE m.withdrawn_at IS NULL
        AND m.is_eliminated <> (COALESCE((SELECT n FROM losses l
              WHERE l.pool_id = m.pool_id AND l.user_id = m.user_id), 0) > m.rebuys_used)`) === '0');

  // An eliminated member carries the week it happened, and it is a week that
  // has actually been played.
  ok(`w${week}: an elimination names the week it happened`, sql(
    `SELECT COUNT(*) FROM pool_members m JOIN pools po ON po.id = m.pool_id
      WHERE po.pool_type = 'SURVIVOR' AND m.is_eliminated
        AND (m.eliminated_week IS NULL OR m.eliminated_week > ${week})`) === '0');

  // The top-up pool grants one stipend per member per played week — never two,
  // which the partial unique index is there to prevent.
  ok(`w${week}: no member drew two stipends for one week`, sql(
    `SELECT COUNT(*) FROM (
       SELECT pool_id, user_id, season, week FROM ledger_entries
        WHERE entry_type = 'STIPEND'
        GROUP BY pool_id, user_id, season, week HAVING COUNT(*) > 1) t`) === '0');

  // Nobody is eliminated while they can still afford to play. Stated this way
  // round deliberately: *who* busts depends on how the season falls, so
  // requiring a bust would be a flaky assertion about luck — but eliminating a
  // member who could still place a bet is wrong under every season.
  ok(`w${week}: nobody is eliminated who could still afford a bet`, sql(
    `SELECT COUNT(*) FROM pool_members pm JOIN pools p ON p.id = pm.pool_id
      WHERE p.pool_type = 'SPREAD_SHARKS' AND p.bust_policy = 'ELIMINATE'
        AND pm.is_eliminated AND pm.withdrawn_at IS NULL
        AND COALESCE((SELECT SUM(amount) FROM ledger_entries le
                       WHERE le.pool_id = pm.pool_id AND le.user_id = pm.user_id), 0)
            >= GREATEST(COALESCE(p.min_bet, 1.00), 1.00)`) === '0');

  // Bust is a floor, not a suggestion: a member cannot stake what they do not
  // have, so no balance may go under.
  ok(`w${week}: nobody is staked below zero`, sql(
    `SELECT COUNT(*) FROM pool_members pm
      WHERE COALESCE((SELECT SUM(amount) FROM ledger_entries le
                       WHERE le.pool_id = pm.pool_id AND le.user_id = pm.user_id), 0) < 0`) === '0');

  return failures.length === before;
}

/* --------------------------------------------------------------- the season */

section(`Playing ${LAST_WEEK} weeks`);
const mock0 = await mockStatus();
console.log(`  a week lasts ${mock0.week_seconds}s — about `
  + `${Math.ceil((LAST_WEEK * mock0.week_seconds) / 60)} minutes\n`);

// Week 1 is placed during the lead-in, before anything has kicked off.
await placeWagers(1);
await placePicks(1);

const history = [];
for (let week = 1; week <= LAST_WEEK; week += 1) {
  // Wait for the slate to play out. Ingest inside the loop rather than only
  // after it, because it is ingest that brings the final scores in — polling
  // the table without it would wait forever.
  const deadline = Date.now() + (mock0.week_seconds + 120) * 1000;
  for (;;) {
    await ingestAndSettle();
    if (weekIsFinal(week)) break;
    if (Date.now() > deadline) {
      ok(`week ${week} finished within its slot`, false, 'timed out waiting for final scores');
      break;
    }
    await sleep(Math.max(1000, (mock0.week_seconds * 1000) / 10));
  }

  const clean = weeklyInvariants(week);

  const alive = Number(sql(
    `SELECT COUNT(*) FROM pool_members m
      WHERE m.pool_id = '${pools.survivor.id}' AND NOT m.is_eliminated`));
  const revivalAlive = Number(sql(
    `SELECT COUNT(*) FROM pool_members m
      WHERE m.pool_id = '${pools.revival.id}' AND NOT m.is_eliminated`));
  const graded = Number(sql(
    `SELECT COUNT(*) FROM bets b JOIN games g ON g.id = b.game_id
      WHERE g.week = ${week} AND b.status <> 'PENDING'`));
  const busted = Number(sql(
    `SELECT COUNT(*) FROM pool_members WHERE pool_id = '${pools.wagers.id}' AND is_eliminated`));

  history.push({ week, alive, revivalAlive, busted });
  console.log(
    `  ${clean ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mBAD\x1b[0m '} week ${String(week).padStart(2)}`
    + `  wagers graded ${String(graded).padStart(2)}`
    + `  survivors ${alive}/${FIELD}`
    + `  revival ${revivalAlive}/${FIELD}`
    + `  bust ${busted}`,
  );

  // A commissioner rebuy, once, mid-season — the only way back into a survivor
  // pool, and the thing settlement used to undo on its next pass.
  if (week === 3) {
    // A member whose losses are exactly one more than the rebuys they have
    // already been granted — so one more puts them back. Picking any eliminated
    // member instead would usually pick the ghost, who has missed every week
    // and is three losses deep, and a single rebuy correctly leaves them out.
    const out = sql(
      `WITH concluded AS (
          SELECT po.id AS pool_id, g.week FROM pools po
            JOIN games g ON g.league = po.leagues[1] AND g.season = po.season
           WHERE po.id = '${pools.revival.id}'
           GROUP BY po.id, g.week
          HAVING BOOL_AND(g.status IN ('FINAL', 'VOID'))
       ), losses AS (
          SELECT m.user_id, m.rebuys_used, COUNT(c.week) AS n
            FROM pool_members m
            JOIN pools po ON po.id = m.pool_id
            JOIN concluded c ON c.pool_id = m.pool_id
           WHERE m.pool_id = '${pools.revival.id}' AND m.withdrawn_at IS NULL
             AND c.week >= COALESCE(m.active_from_week, 1)
             AND NOT EXISTS (
               SELECT 1 FROM picks p JOIN games g ON g.id = p.game_id
                WHERE p.pool_id = m.pool_id AND p.user_id = m.user_id
                  AND g.week = c.week AND p.is_correct IS NOT FALSE)
           GROUP BY m.user_id, m.rebuys_used
       )
       SELECT user_id FROM losses WHERE n = rebuys_used + 1 LIMIT 1`);
    if (out) {
      await call(`/pools/${pools.revival.id}/members/${out}/rebuy`, {
        method: 'POST', token: boss, body: { reason: 'season test' },
      });
      const backIn = sql(`SELECT NOT is_eliminated FROM pool_members
                           WHERE pool_id = '${pools.revival.id}' AND user_id = '${out}'`) === 't';
      ok('a commissioner rebuy puts a member back in', backIn);
      await ingestAndSettle();
      ok('and the next settlement leaves them in', sql(
        `SELECT NOT is_eliminated FROM pool_members
          WHERE pool_id = '${pools.revival.id}' AND user_id = '${out}'`) === 't',
        'settlement re-eliminated a member the commissioner revived');
    }
  }

  if (week < LAST_WEEK) {
    await placeWagers(week + 1);
    await placePicks(week + 1);
  }
}

/* ------------------------------------------------------------ end of season */

section('At the final whistle');
console.log(`  ${placed.bets} wagers placed, ${placed.picks} picks made, `
  + `${placed.refused} refused, ${placed.skipped} slates missed`);

ok('the season actually ran', placed.bets > 0 && placed.picks > 0);

ok('every game that was played is final', sql(
  `SELECT COUNT(*) FROM games WHERE league = '${LEAGUE}' AND season = ${SEASON}
     AND week <= ${LAST_WEEK} AND status <> 'FINAL'`) === '0');

ok('every wager is settled', sql(
  `SELECT COUNT(*) FROM bets WHERE status = 'PENDING'`) === '0');

ok('every pick on a played week is graded', sql(
  `SELECT COUNT(*) FROM picks p JOIN games g ON g.id = p.game_id
    WHERE g.week <= ${LAST_WEEK} AND p.is_correct IS NULL`) === '0');

// Both sides of the market were taken and both sides won something. A season
// where every bet lost would satisfy the arithmetic above and still mean the
// mock or the grader is broken.
const won = Number(sql(`SELECT COUNT(*) FROM bets WHERE status = 'WON'`));
const lost = Number(sql(`SELECT COUNT(*) FROM bets WHERE status = 'LOST'`));
console.log(`  ${won} wagers won, ${lost} lost`);
ok('wagers were graded both ways', won > 0 && lost > 0, `won ${won}, lost ${lost}`);

const spreads = Number(sql(`SELECT COUNT(*) FROM bets WHERE market = 'SPREAD' AND status <> 'VOID'`));
const totals = Number(sql(`SELECT COUNT(*) FROM bets WHERE market = 'TOTAL' AND status <> 'VOID'`));
ok('both markets were exercised', spreads > 0 && totals > 0, `spread ${spreads}, total ${totals}`);

const bust = Number(sql(
  `SELECT COUNT(*) FROM pool_members WHERE pool_id = '${pools.wagers.id}' AND is_eliminated`));
console.log(`  ${bust} member(s) went bust in the eliminate pool`);
if (bust === 0) {
  console.log('    note: the bust path did not run this season — the rule was '
    + 'still checked every week, but nothing exercised it');
}

// The whole point of survivor: the field narrows. The ghost never picked once,
// so it must be out regardless of how the games fell.
const first = history[0];
const last = history[history.length - 1];
ok('the survivor field narrowed over the season', last.alive < FIELD,
  `${first.alive} -> ${last.alive} of ${FIELD}`);
ok('a member who never picked is out', sql(
  `SELECT is_eliminated FROM pool_members
    WHERE pool_id = '${pools.survivor.id}' AND user_id = '${people.ghost.id}'`) === 't',
  'not picking has to count as a loss, or sitting out would be safer than playing');

// Stipends land once a week, on every member, in the top-up pool only.
const stipendWeeks = Number(sql(
  `SELECT COUNT(DISTINCT week) FROM ledger_entries
    WHERE entry_type = 'STIPEND' AND pool_id = '${pools.topup.id}'`));
ok('the top-up pool paid a stipend across the season', stipendWeeks > 1,
  `${stipendWeeks} weeks carried a stipend`);
ok('no other pool paid one', sql(
  `SELECT COUNT(*) FROM ledger_entries
    WHERE entry_type = 'STIPEND' AND pool_id <> '${pools.topup.id}'`) === '0');

// The leaderboard is a cache in front of the ledger. After a whole season of
// invalidation it still has to agree with it.
await call('/admin/flush-cache', { method: 'POST', token: boss });
const board = await call(`/pools/${pools.wagers.id}/leaderboard`, { token: boss });
const rows = board.data.standings ?? [];
ok('the leaderboard lists every member', rows.length === FIELD,
  `${rows.length} rows, field of ${FIELD}`);
let reconciled = true;
for (const row of rows) {
  const ledger = Number(sql(
    `SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
      WHERE pool_id = '${pools.wagers.id}' AND user_id = '${row.user_id}'`));
  if (Math.abs(Number(row.balance) - ledger) > 0.005) {
    reconciled = false;
    console.log(`    ${row.username}: leaderboard ${row.balance} vs ledger ${ledger}`);
  }
}
ok('every leaderboard balance equals its ledger', reconciled,
  'the season is over, so nothing is at risk and the two must agree exactly');

section('Season');
for (const h of history) {
  console.log(`  week ${String(h.week).padStart(2)}  survivors ${h.alive}  `
    + `revival ${h.revivalAlive}  bust ${h.busted}`);
}

console.log(
  `\n\x1b[1mResult: ${pass} passed, ${failures.length} failed\x1b[0m`,
);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length > 0 ? 1 : 0);
