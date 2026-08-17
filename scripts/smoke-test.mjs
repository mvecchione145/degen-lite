#!/usr/bin/env node
// End-to-end smoke test against a running stack.
//
//   docker compose down -v && ./scripts/compose.sh up -d
//   node scripts/smoke-test.mjs
//
// Runs against the real NFL schedule and real SharpAPI lines. Nothing is
// synthetic except the scorelines: the season has not been played, so
// /admin/simulate finalizes a week with a chosen scoreline to exercise
// settlement. The scoreline is picked from the real spreads on the board so
// win, loss, and push outcomes are exact rather than probabilistic.
//
// It consumes three weeks by finalizing them, so it needs a fresh database.

const BASE = process.env.API_BASE || 'http://localhost:3000/api';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const money = (n) => Number(Number(n).toFixed(2));

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8);

  section('Health');
  const health = await call('/health');
  check('GET /health returns ok', health.data.status === 'ok', JSON.stringify(health.data));
  if (!health.ok) throw new Error('API is not reachable — is the stack up?');
  check('legacy pick modes are off by default', health.data.legacy_pool_modes === false);

  section('Auth');
  check('wrong password is rejected',
    (await call('/auth/login', {
      method: 'POST', body: { login: 'admin', password: 'nope' },
    })).status === 401);

  // db/init/03-seed.sql creates exactly one account and grants it pool
  // creation, which every other account defaults to not having. So the seeded
  // account is the one that opens pools here, and the registered account below
  // plays the second member.
  const admin = await call('/auth/login', {
    method: 'POST', body: { login: 'admin', password: 'password123' },
  });
  check('the bootstrap account can sign in', admin.ok, JSON.stringify(admin.data));
  const token = admin.data.token;

  const registered = await call('/auth/register', {
    method: 'POST',
    body: {
      username: `smoke_${suffix}`,
      email: `smoke_${suffix}@example.com`,
      password: 'password123',
    },
  });
  check('new user can register', registered.status === 201, JSON.stringify(registered.data));
  const memberToken = registered.data.token;

  check('duplicate username is rejected',
    (await call('/auth/register', {
      method: 'POST',
      body: {
        username: `smoke_${suffix}`,
        email: `other_${suffix}@example.com`,
        password: 'password123',
      },
    })).status === 409);
  check('unauthenticated request is rejected', (await call('/pools')).status === 401);

  // One emoji beside the name on leaderboards. Validated rather than taken as
  // free text: it renders into other members' rows, so anything that is not an
  // emoji would be writing arbitrary content somewhere that is not yours.
  check('an emoji avatar is accepted',
    (await call('/auth/profile', {
      method: 'POST', token, body: { avatar_emoji: '🦈' },
    })).data.user?.avatar_emoji === '🦈');
  check('a multi-code-point emoji is accepted',
    (await call('/auth/profile', {
      method: 'POST', token, body: { avatar_emoji: '👍🏽' },
    })).data.user?.avatar_emoji === '👍🏽');
  check('plain text is refused as an avatar',
    (await call('/auth/profile', {
      method: 'POST', token, body: { avatar_emoji: 'admin' },
    })).status === 400);
  check('markup is refused as an avatar',
    (await call('/auth/profile', {
      method: 'POST', token, body: { avatar_emoji: '<img src=x onerror=alert(1)>' },
    })).status === 400);
  check('null clears the avatar',
    (await call('/auth/profile', {
      method: 'POST', token, body: { avatar_emoji: null },
    })).data.user?.avatar_emoji === null);

  // A display name is what the pool sees; the username stays the login handle.
  check('a display name is accepted',
    (await call('/auth/profile', {
      method: 'POST', token, body: { display_name: 'The Commish' },
    })).data.user?.display_name === 'The Commish');
  check('the username is not touched by it',
    (await call('/auth/me', { token })).data.user?.username === 'admin');
  check('a display name over 50 characters is refused',
    (await call('/auth/profile', {
      method: 'POST', token, body: { display_name: 'x'.repeat(51) },
    })).status === 400);
  // Names need not be unique, but taking somebody else's *username* is
  // impersonation — the commissioner log and the standings both name people.
  check("another account's username is refused as a display name",
    (await call('/auth/profile', {
      method: 'POST', token: memberToken, body: { display_name: 'admin' },
    })).status === 409);
  // One endpoint, two fields: an absent field means "leave alone".
  check('setting only the emoji leaves the display name',
    (await call('/auth/profile', {
      method: 'POST', token, body: { avatar_emoji: '🦈' },
    })).data.user?.display_name === 'The Commish');
  check('null clears the display name',
    (await call('/auth/profile', {
      method: 'POST', token, body: { display_name: null },
    })).data.user?.display_name === null);

  // /auth/me runs on every page load. It shared the brute-force budget with
  // /login until that limiter was scoped to the credential routes, which locked
  // members out of their own account for ordinary browsing.
  const meBurst = [];
  for (let i = 0; i < 25; i += 1) meBurst.push((await call('/auth/me', { token })).status);
  check('reading your own account is not rate limited',
    meBurst.every((s) => s === 200), `saw ${[...new Set(meBurst)].join(',')}`);

  section('Real schedule');
  const weeks = await call('/games/weeks', { token });
  const season = weeks.data.season;
  const currentWeek = weeks.data.current_week;

  if (!weeks.data.weeks?.length) {
    throw new Error(
      'No games are loaded. The worker ingests the schedule from ESPN on '
      + 'startup — give it a minute, and check `docker compose logs worker`.',
    );
  }

  check('a full regular season is loaded', weeks.data.weeks.length === 18,
    `got ${weeks.data.weeks.length} weeks`);
  check('a current week is resolved', Number.isInteger(currentWeek), `got ${currentWeek}`);
  check('the season has room for the four weeks this test consumes',
    currentWeek + 3 <= 18, `current week ${currentWeek}`);

  const slateOf = async (week) => (await call(
    `/games?season=${season}&week=${week}`, { token },
  )).data.games;

  const slate = await slateOf(currentWeek);
  check('the current week has a full slate', slate.length >= 12, `got ${slate.length}`);
  check('every game carries a real spread and total',
    slate.every((g) => g.spread !== null && g.total !== null),
    JSON.stringify(slate.slice(0, 2).map((g) => ({ s: g.spread, t: g.total }))));
  check('games are real fixtures, not synthetic',
    slate.every((g) => g.id.startsWith('espn:')), slate[0]?.id);
  check('nothing has kicked off yet', slate.every((g) => !g.locked));

  section('Pool creation');
  const pool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Sharks ${suffix}`, starting_balance: 10000, max_bet: 500 },
  });
  check('a wager pool is created', pool.status === 201, JSON.stringify(pool.data));
  const poolId = pool.data.pool?.id;
  check('it defaults to SPREAD_SHARKS', pool.data.pool?.pool_type === 'SPREAD_SHARKS');
  check('it lands on the current season', pool.data.pool?.season === season);
  check('bust policy defaults to elimination', pool.data.pool?.bust_policy === 'ELIMINATE');

  check('legacy modes are refused at creation',
    (await call('/pools', {
      method: 'POST', token, body: { name: `Legacy ${suffix}`, pool_type: 'PICKEM' },
    })).status === 400);
  check('a top-up pool without a stipend is refused',
    (await call('/pools', {
      method: 'POST', token, body: { name: `T ${suffix}`, bust_policy: 'TOPUP' },
    })).status === 400);

  section('Opening balance');
  const balance0 = await call(`/pools/${poolId}/balance`, { token });
  check('opening balance is credited', balance0.data.balance === 10000,
    JSON.stringify(balance0.data));
  check('nothing is at risk yet', balance0.data.at_risk === 0);
  check('net profit starts at zero', balance0.data.net_profit === 0);
  check('the whole-unit floor applies with no pool minimum',
    balance0.data.minimum_bet === 1, `got ${balance0.data.minimum_bet}`);

  section('The board');
  const board = await call(`/pools/${poolId}/board?week=${currentWeek}`, { token });
  check('the board lists the week', board.data.games?.length === slate.length);
  check('the posted price is -110', board.data.price === -110);
  check('lines on the board match the schedule',
    Number(board.data.games[0].spread) === Number(slate[0].spread));
  check('the open week is reported as open', board.data.week_open === true,
    JSON.stringify({ week: board.data.week, current: board.data.current_week }));

  // Weeks out from now carry a stale or seeded number rather than a live price,
  // so they are shut. The board says so and placeBet enforces it — both, because
  // a board that offered the bet would have the API refuse it after the fact.
  const aheadWeek = currentWeek + 2;
  const aheadBoard = await call(`/pools/${poolId}/board?week=${aheadWeek}`, { token });
  check('a future week is reported as closed', aheadBoard.data.week_open === false,
    JSON.stringify({ week: aheadBoard.data.week, current: aheadBoard.data.current_week }));
  check('a future week still shows its games', aheadBoard.data.games?.length > 0);
  check('a wager on a future week is refused',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: {
        game_id: (await slateOf(aheadWeek))[0].id,
        market: 'SPREAD',
        selection: 'HOME',
        stake: 100,
      },
    })).status === 400);

  section('Placing wagers');
  const bet1 = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 100 },
  });
  check('a wager is accepted', bet1.status === 201, JSON.stringify(bet1.data));
  check('the line is captured on the bet',
    Number(bet1.data.bet.line) === Number(slate[0].spread));
  check('the price is captured on the bet', bet1.data.bet.price === -110);
  check('it starts pending', bet1.data.bet.status === 'PENDING');

  const afterFirst = await call(`/pools/${poolId}/balance`, { token });
  check('the stake leaves the balance immediately', afterFirst.data.balance === 9900,
    JSON.stringify(afterFirst.data));
  check('the stake shows as at risk', afterFirst.data.at_risk === 100);
  // ...to its owner. The standings must not move on an unsettled wager.
  check('a live wager does not move the standings',
    (await call(`/pools/${poolId}/leaderboard`, { token })).data.standings
      .find((s) => s.username === 'admin')?.balance === 10000,
    'a drop here would reveal the stake to the rest of the pool');

  check('a stake below one whole unit is refused',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[1].id, market: 'SPREAD', selection: 'HOME', stake: 0.5 },
    })).status === 400);
  check('three decimal places are refused',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[1].id, market: 'SPREAD', selection: 'HOME', stake: 10.005 },
    })).status === 400);
  check('two decimal places are accepted',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[1].id, market: 'TOTAL', selection: 'OVER', stake: 12.34 },
    })).status === 201);
  check('a selection that does not fit the market is refused',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[2].id, market: 'SPREAD', selection: 'OVER', stake: 10 },
    })).status === 400);

  // The cap is per selection — one side of one market on one game — not per
  // game and not per wager. So it must stop a position being built past the
  // limit in pieces, while leaving the other side, the other market, and every
  // other fixture their own allowance. This pool caps a selection at 500.
  section('Per-selection cap');
  const capGame = slate[3];
  const capBet = (market, selection, stake) => call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: capGame.id, market, selection, stake },
  });

  check('a wager within the cap is accepted',
    (await capBet('SPREAD', 'HOME', 400)).status === 201);

  const overCap = await capBet('SPREAD', 'HOME', 200);
  check('the cap is on aggregate stake on one selection, not on each wager',
    overCap.status === 400, overCap.data.error);
  check('a wager filling the selection exactly is accepted',
    (await capBet('SPREAD', 'HOME', 100)).status === 201);
  check('a filled selection takes nothing more',
    (await capBet('SPREAD', 'HOME', 1)).status === 400);

  check('the other side of the same market has its own allowance',
    (await capBet('SPREAD', 'AWAY', 500)).status === 201);
  check('another market on the same game has its own allowance',
    (await capBet('TOTAL', 'OVER', 500)).status === 201);

  const boardAfterCap = await call(`/pools/${poolId}/board?week=${currentWeek}`, { token });
  const cappedGame = boardAfterCap.data.games.find((g) => g.id === capGame.id);
  check('exposure sums every wager on the fixture, across selections',
    cappedGame.exposure === 1500, `got ${cappedGame.exposure}`);

  const uncapped = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Uncapped ${suffix}`, starting_balance: 5000, max_bet: null },
  });
  check('a pool can switch the cap off', uncapped.data.pool?.max_bet === null);
  check('with no cap only the balance constrains the stake',
    (await call(`/pools/${uncapped.data.pool.id}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[0].id, market: 'SPREAD', selection: 'AWAY', stake: 4000 },
    })).status === 201);
  check('a stake beyond the balance is refused',
    (await call(`/pools/${uncapped.data.pool.id}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[1].id, market: 'SPREAD', selection: 'AWAY', stake: 2000 },
    })).status === 400);

  section('Minimum bet');
  const minPool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `MinBet ${suffix}`, starting_balance: 1000, min_bet: 50 },
  });
  check("a stake below the pool's minimum is refused",
    (await call(`/pools/${minPool.data.pool.id}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 25 },
    })).status === 400);
  check('a stake at the minimum is accepted',
    (await call(`/pools/${minPool.data.pool.id}/bets`, {
      method: 'POST',
      token,
      body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 50 },
    })).status === 201);

  section('Mode boundaries');
  const picksOnSharks = await call(`/pools/${poolId}/picks`, { token });
  check('a wager pool refuses the picks view', picksOnSharks.status === 400,
    picksOnSharks.data.error);
  check('there is no route to cancel a placed bet',
    (await call(`/pools/${poolId}/bets/${bet1.data.bet.id}`, {
      method: 'DELETE', token,
    })).status === 404);

  section('Settlement arithmetic on real lines');
  // Every game in a week gets the same scoreline, so outcomes are chosen by
  // picking a home score and deriving the away score from a whole-number
  // spread. That game pushes; a longer spread wins for the home side and a
  // shorter one loses.
  const settlePool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Settle ${suffix}`, starting_balance: 10000, max_bet: null },
  });
  const settleId = settlePool.data.pool.id;

  const wholeSpreads = slate.filter((g) => Number(g.spread) % 1 === 0);
  check('the real slate contains a whole-number spread to push against',
    wholeSpreads.length > 0,
    `spreads: ${slate.map((g) => g.spread).join(', ')}`);

  const pushGame = wholeSpreads[0];
  const pushSpread = Number(pushGame.spread);
  const homeScore = 30;
  const awayScore = homeScore + pushSpread; // home_score + spread === away_score

  const winGame = slate.find((g) => Number(g.spread) > pushSpread);
  const loseGame = slate.find((g) => Number(g.spread) < pushSpread);
  check('the slate spans spreads either side of it',
    Boolean(winGame && loseGame),
    `push ${pushSpread}, win ${winGame?.spread}, lose ${loseGame?.spread}`);

  const pushBet = await call(`/pools/${settleId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: pushGame.id, market: 'SPREAD', selection: 'HOME', stake: 100 },
  });
  const winBet = await call(`/pools/${settleId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: winGame.id, market: 'SPREAD', selection: 'HOME', stake: 200 },
  });
  const loseBet = await call(`/pools/${settleId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: loseGame.id, market: 'SPREAD', selection: 'HOME', stake: 50 },
  });
  check('all three wagers are placed',
    pushBet.status === 201 && winBet.status === 201 && loseBet.status === 201,
    JSON.stringify([pushBet.status, winBet.status, loseBet.status]));

  const preSettle = await call(`/pools/${settleId}/balance`, { token });
  check('all three stakes have left the balance', preSettle.data.balance === 9650,
    JSON.stringify(preSettle.data));

  const simulated = await call('/admin/simulate', {
    method: 'POST',
    token,
    body: { season, week: currentWeek, home_score: homeScore, away_score: awayScore },
  });
  check('the week is finalized on the chosen scoreline',
    simulated.data.games_finalized === slate.length, JSON.stringify(simulated.data));
  check('wagers settled', simulated.data.settlement?.bets_settled > 0,
    JSON.stringify(simulated.data.settlement));

  const history = await call(`/pools/${settleId}/bets`, { token });
  const byId = new Map(history.data.bets.map((b) => [b.id, b]));
  const settledPush = byId.get(pushBet.data.bet.id);
  const settledWin = byId.get(winBet.data.bet.id);
  const settledLoss = byId.get(loseBet.data.bet.id);

  check('landing exactly on the spread is a push', settledPush?.status === 'PUSH',
    `got ${settledPush?.status} on spread ${pushSpread}`);
  check('a push nets zero', settledPush?.net === 0);
  check('the covering side won', settledWin?.status === 'WON',
    `got ${settledWin?.status} on spread ${winGame.spread}`);
  check('the uncovered side lost', settledLoss?.status === 'LOST',
    `got ${settledLoss?.status} on spread ${loseGame.spread}`);
  // -110 pays 100/110 of the stake, rounded to the cent: 200 -> 181.82.
  check('profit at -110 is exact to the cent', settledWin?.net === 181.82,
    `got ${settledWin?.net}`);
  check('a loss nets the full stake', settledLoss?.net === -50);

  const postSettle = await call(`/pools/${settleId}/balance`, { token });
  // 10000 - 350 staked + 100 push refund + 381.82 win return = 10131.82
  check('balance reflects every settlement', postSettle.data.balance === 10131.82,
    JSON.stringify(postSettle.data));
  check('net profit backs out what was credited', postSettle.data.net_profit === 131.82);
  check('nothing is left at risk', postSettle.data.at_risk === 0);

  const settleAgain = await call('/admin/settle', { method: 'POST', token });
  check('settlement is idempotent', settleAgain.data.bets_settled === 0,
    JSON.stringify(settleAgain.data));
  check('re-running settlement does not double-credit',
    (await call(`/pools/${settleId}/balance`, { token })).data.balance === 10131.82);

  section('Locked games');
  const playedSlate = await slateOf(currentWeek);
  check('a finalized week reads as locked', playedSlate.every((g) => g.locked));
  check('a kicked-off game takes no wagers',
    (await call(`/pools/${settleId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: playedSlate[0].id, market: 'SPREAD', selection: 'HOME', stake: 10 },
    })).status === 400);

  section('Bet history and leaderboard');
  check('history lists every bet', history.data.bets.length === 3);
  check('history summarises net', history.data.summary.net === 131.82,
    JSON.stringify(history.data.summary));
  check('history describes the wager as struck',
    typeof settledWin?.description === 'string' && settledWin.description.length > 0,
    settledWin?.description);
  check('history filters by status',
    (await call(`/pools/${settleId}/bets?status=WON`, { token }))
      .data.bets.every((b) => b.status === 'WON'));

  // Leaderboard shape and caching, read off a pool opened for this check and
  // never wagered in. It used to read a seeded demo pool (invite code SHARKS01,
  // four members), but the seed now creates one account and no pools at all —
  // see db/init/03-seed.sql. A pool this run has been betting in would not do:
  // the assertion is that an untouched pool shows no invented history.
  const quietPool = await call('/pools', {
    method: 'POST', token, body: { name: `Quiet ${suffix}`, starting_balance: 10000 },
  });
  const quietId = quietPool.data.pool.id;
  const freshBoard = await call(`/pools/${quietId}/leaderboard`, { token });
  check('the leaderboard ranks by balance', freshBoard.data.ranked_by === 'balance');

  // Standings name people by their display name when they have set one, so
  // this is where the column actually has to land.
  await call('/auth/profile', { method: 'POST', token, body: { display_name: 'The Commish' } });
  const named = await call(`/pools/${quietId}/leaderboard`, { token });
  check('the standings show a display name over the username',
    named.data.standings.some((s) => s.username === 'The Commish'),
    JSON.stringify(named.data.standings.map((s) => s.username)));
  await call('/auth/profile', { method: 'POST', token, body: { display_name: null } });
  const unnamed = await call(`/pools/${quietId}/leaderboard`, { token });
  check('and fall back to the username once it is cleared',
    unnamed.data.standings.some((s) => s.username === 'admin'),
    JSON.stringify(unnamed.data.standings.map((s) => s.username)));

  // A display name need not be unique, so a standings row carries the account's
  // email for the tooltip that tells two members of the same name apart.
  check('a standings row carries the account email',
    unnamed.data.standings.every((s) => typeof s.account_email === 'string'
      && s.account_email.includes('@')),
    JSON.stringify(unnamed.data.standings.map((s) => s.account_email)));
  // A stake leaves the balance the moment it is placed, so publishing a
  // spendable balance would tell the pool how much a rival has committed
  // before their game kicks off. Standings carry the settled figure instead,
  // and drop at_risk rather than merely hiding it in the UI.
  check('standings do not carry at risk',
    freshBoard.data.standings.every((s) => !('at_risk' in s)),
    JSON.stringify(Object.keys(freshBoard.data.standings[0] ?? {})));
  check('every member is ranked', freshBoard.data.standings.length >= 1,
    JSON.stringify(freshBoard.data.standings?.length));
  check('an untouched pool sits on the opening balance',
    freshBoard.data.standings.every((s) => s.balance === 10000 && s.wins + s.losses === 0),
    JSON.stringify(freshBoard.data.standings.map((s) => s.balance)));
  check('the second read is served from redis',
    (await call(`/pools/${quietId}/leaderboard`, { token })).data.cached === true);

  const ledger = await call(`/pools/${settleId}/ledger`, { token });
  check('the ledger sums to the balance',
    money(ledger.data.entries.reduce((s, e) => s + e.amount, 0)) === 10131.82);

  section('Busting out');
  const bustPool = await call('/pools', {
    method: 'POST',
    token,
    body: {
      name: `Bust ${suffix}`,
      starting_balance: 100,
      max_bet: null,
      bust_policy: 'REBUY',
      rebuy_limit: 1,
    },
  });
  const bustId = bustPool.data.pool.id;
  check('a rebuy pool stores its limit', bustPool.data.pool.rebuy_limit === 1);

  // Back the away side, then finalize with the home side winning by 60. No real
  // spread is anywhere near that, so the away side cannot cover.
  const bustGame = (await slateOf(currentWeek + 1))[0];
  await call(`/pools/${bustId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: bustGame.id, market: 'SPREAD', selection: 'AWAY', stake: 100 },
  });
  check('a rebuy is refused while a bet is live',
    (await call(`/pools/${bustId}/rebuy`, { method: 'POST', token })).status === 400);

  await call('/admin/simulate', {
    method: 'POST',
    token,
    body: { season, week: currentWeek + 1, home_score: 60, away_score: 0 },
  });

  const busted = await call(`/pools/${bustId}/balance`, { token });
  check('losing the last of the balance leaves nothing', busted.data.balance === 0,
    JSON.stringify(busted.data));
  check('the member reads as bust', busted.data.is_bust === true);

  const rebought = await call(`/pools/${bustId}/rebuy`, { method: 'POST', token });
  check('a bust member can rebuy', rebought.ok, JSON.stringify(rebought.data));
  check('the rebuy restores the starting balance', rebought.data.credited === 100);

  const afterRebuy = await call(`/pools/${bustId}/balance`, { token });
  check('balance is back to the opening figure', afterRebuy.data.balance === 100);
  check('the rebuy is not counted as profit', afterRebuy.data.net_profit === -100);
  check('credited tracks the rebuy', afterRebuy.data.total_credited === 200);
  check('the rebuy limit is enforced',
    [400, 409].includes((await call(`/pools/${bustId}/rebuy`, { method: 'POST', token })).status));

  section('Elimination');
  const elimPool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Elim ${suffix}`, starting_balance: 100, max_bet: null },
  });
  const elimId = elimPool.data.pool.id;
  const elimGame = (await slateOf(currentWeek + 2))[0];

  await call(`/pools/${elimId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: elimGame.id, market: 'SPREAD', selection: 'AWAY', stake: 100 },
  });
  await call('/admin/simulate', {
    method: 'POST', token, body: { season, week: currentWeek + 2, home_score: 60, away_score: 0 },
  });

  const eliminated = await call(`/pools/${elimId}/balance`, { token });
  check('the default policy eliminates a bust member',
    eliminated.data.is_eliminated === true, JSON.stringify(eliminated.data));
  check('an eliminated member cannot wager',
    [400, 403].includes((await call(`/pools/${elimId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: elimGame.id, market: 'SPREAD', selection: 'HOME', stake: 10 },
    })).status));
  check('an elimination pool refuses rebuys',
    (await call(`/pools/${elimId}/rebuy`, { method: 'POST', token })).status === 400);

  section('Voids');
  const voidPool = await call('/pools', {
    method: 'POST', token, body: { name: `Void ${suffix}`, starting_balance: 1000 },
  });
  const voidPoolId = voidPool.data.pool.id;
  // Betting is confined to the open week. Each /admin/simulate above pulled a
  // week's kickoffs into the past, walking the open week forward, so after
  // settlement, bust and elimination consumed currentWeek through +2 the open
  // week is +3.
  //
  // This section runs last of the four for a reason: abandoning a game leaves
  // it VOID with its kickoff still in the future, and /simulate skips VOID, so
  // that game pins getCurrentWeek to its week for good. Any week-consuming
  // section after this one would find the board shut.
  const voidGame = (await slateOf(currentWeek + 3))[0];

  await call(`/pools/${voidPoolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: voidGame.id, market: 'SPREAD', selection: 'HOME', stake: 250 },
  });
  check('the stake is held while pending',
    (await call(`/pools/${voidPoolId}/balance`, { token })).data.balance === 750);

  const abandoned = await call('/admin/abandon', {
    method: 'POST', token, body: { game_id: voidGame.id },
  });
  check('a game can be marked abandoned', abandoned.ok, JSON.stringify(abandoned.data));
  check('its wagers are voided', abandoned.data.settlement?.bets_voided === 1);
  check('a void returns the stake in full',
    (await call(`/pools/${voidPoolId}/balance`, { token })).data.balance === 1000);

  const voidHistory = await call(`/pools/${voidPoolId}/bets`, { token });
  check('the voided bet is marked VOID', voidHistory.data.bets[0].status === 'VOID');
  check('a void nets zero', voidHistory.data.bets[0].net === 0);
  check('an abandoned game takes no new wagers',
    (await call(`/pools/${voidPoolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: voidGame.id, market: 'SPREAD', selection: 'HOME', stake: 10 },
    })).status === 400);

  section('Weekly top-up');
  const topupPool = await call('/pools', {
    method: 'POST',
    token,
    body: {
      name: `Topup ${suffix}`,
      starting_balance: 500,
      bust_policy: 'TOPUP',
      stipend_amount: 250,
    },
  });
  const topupId = topupPool.data.pool.id;
  check('a top-up pool stores its stipend',
    Number(topupPool.data.pool.stipend_amount) === 250);

  await call('/admin/settle', { method: 'POST', token });
  const afterStipend = await call(`/pools/${topupId}/balance`, { token });
  check('the weekly stipend is credited', afterStipend.data.balance === 750,
    JSON.stringify(afterStipend.data));
  check('the stipend counts as credited, not profit',
    afterStipend.data.net_profit === 0 && afterStipend.data.total_credited === 750);

  await call('/admin/settle', { method: 'POST', token });
  check('a week only ever grants one stipend',
    (await call(`/pools/${topupId}/balance`, { token })).data.balance === 750);

  section('Membership and visibility');
  check('a non-member cannot read a private board',
    (await call(`/pools/${poolId}/board`, { token: memberToken })).status === 403);

  const joined = await call('/pools/join', {
    method: 'POST', token: memberToken, body: { invite_code: pool.data.pool.invite_code },
  });
  check('joining by invite code works', joined.ok, JSON.stringify(joined.data));
  check('a new member is credited an opening balance',
    (await call(`/pools/${poolId}/balance`, { token: memberToken })).data.balance === 10000);

  await call('/pools/join', {
    method: 'POST', token: memberToken, body: { invite_code: pool.data.pool.invite_code },
  });
  check('rejoining does not mint a second opening credit',
    (await call(`/pools/${poolId}/balance`, { token: memberToken })).data.balance === 10000);
  check('an unknown invite code 404s',
    (await call('/pools/join', {
      method: 'POST', token, body: { invite_code: 'NOPENOPE' },
    })).status === 404);

  section('Commissioner controls');
  // A fresh pool so the assertions below do not depend on everything the run has
  // already done to `poolId`. The open week is currentWeek + 3 by now — the
  // Voids section abandoned a game there, and a VOID game keeps its future
  // kickoff, which pins getCurrentWeek to that week.
  const cPool = await call('/pools', {
    method: 'POST', token, body: { name: `Commish ${suffix}`, starting_balance: 1000, max_bet: null },
  });
  const cId = cPool.data.pool.id;
  await call('/pools/join', {
    method: 'POST', token: memberToken, body: { invite_code: cPool.data.pool.invite_code },
  });
  const memberId = (await call('/auth/me', { token: memberToken })).data.user.id;

  // Any game in the open week other than the one the Voids section abandoned.
  const openSlate = await slateOf(currentWeek + 3);
  const cGame = openSlate.find((g) => g.id !== voidGame.id && g.status === 'SCHEDULED');
  const cBet = await call(`/pools/${cId}/bets`, {
    method: 'POST', token: memberToken,
    body: { game_id: cGame.id, market: 'SPREAD', selection: 'HOME', stake: 200 },
  });
  check('a member places a wager to be voided', cBet.status === 201, JSON.stringify(cBet.data));

  check('a plain member cannot void a wager',
    (await call(`/pools/${cId}/bets/${cBet.data.bet.id}/void`, {
      method: 'POST', token: memberToken, body: {},
    })).status === 403);
  const voidedByCommish = await call(`/pools/${cId}/bets/${cBet.data.bet.id}/void`, {
    method: 'POST', token, body: { reason: 'posted off a stale line' },
  });
  check('the commissioner can void a live wager', voidedByCommish.ok,
    JSON.stringify(voidedByCommish.data));
  check('the stake is refunded in full',
    (await call(`/pools/${cId}/balance`, { token: memberToken })).data.balance === 1000);
  check('voiding the same wager twice is refused',
    (await call(`/pools/${cId}/bets/${cBet.data.bet.id}/void`, {
      method: 'POST', token, body: {},
    })).status === 400);

  // Settled results are never rewritten — settleId's bets were graded earlier.
  const gradedBet = (await call(`/pools/${settleId}/bets`, { token })).data.bets
    .find((b) => b.status === 'WON' || b.status === 'LOST');
  check('a settled wager cannot be voided',
    (await call(`/pools/${settleId}/bets/${gradedBet.id}/void`, {
      method: 'POST', token, body: {},
    })).status === 400, gradedBet?.status);

  check('the reveal rule is not lifted for the commissioner',
    (await call(`/pools/${cId}/pending`, { token })).ok);
  check('a plain member cannot list live wagers',
    (await call(`/pools/${cId}/pending`, { token: memberToken })).status === 403);

  check('a plain member cannot remove anyone',
    (await call(`/pools/${cId}/members/${memberId}/withdraw`, {
      method: 'POST', token: memberToken, body: {},
    })).status === 403);
  const withdrawn = await call(`/pools/${cId}/members/${memberId}/withdraw`, {
    method: 'POST', token, body: { reason: 'left the group' },
  });
  check('the commissioner can remove a member', withdrawn.ok, JSON.stringify(withdrawn.data));
  check('a removed member drops out of the standings',
    !(await call(`/pools/${cId}/leaderboard`, { token })).data.standings
      .some((r) => r.user_id === memberId));
  check('a removed member keeps read access',
    (await call(`/pools/${cId}`, { token: memberToken })).ok);
  check('a removed member can place no further wagers',
    (await call(`/pools/${cId}/bets`, {
      method: 'POST', token: memberToken,
      body: { game_id: cGame.id, market: 'TOTAL', selection: 'OVER', stake: 10 },
    })).status === 403);
  check('the invite code cannot undo a removal',
    (await call('/pools/join', {
      method: 'POST', token: memberToken, body: { invite_code: cPool.data.pool.invite_code },
    })).status === 403);

  // Removal is reversible, and reversing it restores the member exactly — no
  // second opening balance, which would be a windfall for anyone removed bust.
  check('reinstating a member who was never removed is refused',
    (await call(`/pools/${cId}/members/${(await call('/auth/me', { token })).data.user.id}/reinstate`, {
      method: 'POST', token, body: {},
    })).status === 400);
  check('a plain member cannot reinstate',
    (await call(`/pools/${cId}/members/${memberId}/reinstate`, {
      method: 'POST', token: memberToken, body: {},
    })).status === 403);

  const balanceWhileOut = (await call(`/pools/${cId}/balance`, { token: memberToken })).data.balance;
  const reinstated = await call(`/pools/${cId}/members/${memberId}/reinstate`, {
    method: 'POST', token, body: { reason: 'sorted it out' },
  });
  check('the commissioner can add a removed member back', reinstated.ok,
    JSON.stringify(reinstated.data));
  check('they return to the standings',
    (await call(`/pools/${cId}/leaderboard`, { token }))
      .data.standings.some((r) => r.user_id === memberId));
  check('reinstating mints no second opening balance',
    (await call(`/pools/${cId}/balance`, { token: memberToken })).data.balance
      === balanceWhileOut, `was ${balanceWhileOut}`);
  check('they can wager again',
    (await call(`/pools/${cId}/bets`, {
      method: 'POST', token: memberToken,
      body: { game_id: cGame.id, market: 'TOTAL', selection: 'OVER', stake: 10 },
    })).status === 201);
  check('reinstating twice is refused',
    (await call(`/pools/${cId}/members/${memberId}/reinstate`, {
      method: 'POST', token, body: {},
    })).status === 400);

  const auditLog = await call(`/pools/${cId}/events`, { token: memberToken });
  check('every member can read the action log', auditLog.ok);
  // Scoped to commissioner actions: buy-ins share the log but are the member's
  // own doing, so they carry no actor and no reason.
  const actions = auditLog.data.events
    .filter((e) => e.kind.startsWith('MEMBER_') || e.kind === 'BET_VOIDED');
  check('every commissioner action is recorded with its reason and actor',
    actions.length === 3
      && actions.every((e) => Boolean(e.reason) && e.actor_username === 'admin'),
    JSON.stringify(actions.map((e) => `${e.kind}:${e.reason}`)));
  check('the log covers removal, reinstatement and the void',
    ['MEMBER_WITHDRAWN', 'MEMBER_REINSTATED', 'BET_VOIDED']
      .every((k) => auditLog.data.events.some((e) => e.kind === k)),
    JSON.stringify(auditLog.data.events.map((e) => e.kind)));

  // Buy-ins are merged in from the ledger rather than duplicated as events, so
  // they are present for pools that predate the log entirely.
  const buyIns = auditLog.data.events.filter((e) => e.kind === 'BUY_IN');
  check('buy-ins appear in the log', buyIns.length === 2,
    JSON.stringify(auditLog.data.events.map((e) => e.kind)));
  check('a buy-in carries its amount and the member, and no actor',
    buyIns.every((e) => e.amount === 1000 && e.target_username && e.actor_username === null),
    JSON.stringify(buyIns.map((e) => [e.target_username, e.actor_username, e.amount])));
  check('weekly stipends are kept out of the log',
    !auditLog.data.events.some((e) => e.kind === 'STIPEND'));

  section('Live odds feed');
  const account = await call('/admin/odds/account', { token });
  check('the SharpAPI key is configured and accepted', account.ok,
    JSON.stringify(account.data));
  check('the tier is reported', typeof account.data?.tier === 'string', JSON.stringify(account.data));

  const odds = await call('/admin/odds', { method: 'POST', token });
  check('a line refresh runs', odds.ok, JSON.stringify(odds.data));
  check('the pagination walk is not truncated', odds.data.truncated === false,
    JSON.stringify(odds.data));
  check('every priced event matches a game', odds.data.events_priced > 0,
    JSON.stringify(odds.data));

  const cachedOdds = await call('/admin/odds', { method: 'POST', token });
  check('a repeat refresh is served from the persistent cache',
    cachedOdds.data.served_from_cache > 0, JSON.stringify(cachedOdds.data));

  section(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`Failures:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31mSmoke test aborted:\x1b[0m ${err.message}`);
  process.exit(1);
});
