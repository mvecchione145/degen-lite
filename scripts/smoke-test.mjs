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
      method: 'POST', body: { login: 'alice', password: 'nope' },
    })).status === 401);

  const alice = await call('/auth/login', {
    method: 'POST', body: { login: 'alice', password: 'password123' },
  });
  check('a bootstrap account can sign in', alice.ok, JSON.stringify(alice.data));
  const aliceToken = alice.data.token;

  const registered = await call('/auth/register', {
    method: 'POST',
    body: {
      username: `smoke_${suffix}`,
      email: `smoke_${suffix}@example.com`,
      password: 'password123',
    },
  });
  check('new user can register', registered.status === 201, JSON.stringify(registered.data));
  const token = registered.data.token;

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
  check('the season has room for the three weeks this test consumes',
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
    body: { name: `Sharks ${suffix}`, starting_balance: 10000, max_bet_per_game: 500 },
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

  section('Per-game cap');
  const capGame = slate[3];
  check('a wager within the cap is accepted',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: capGame.id, market: 'SPREAD', selection: 'HOME', stake: 400 },
    })).status === 201);

  const overCap = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: capGame.id, market: 'TOTAL', selection: 'OVER', stake: 200 },
  });
  check('the cap is on total stake per game, not per wager',
    overCap.status === 400, overCap.data.error);
  check('a wager filling the cap exactly is accepted',
    (await call(`/pools/${poolId}/bets`, {
      method: 'POST',
      token,
      body: { game_id: capGame.id, market: 'TOTAL', selection: 'OVER', stake: 100 },
    })).status === 201);

  const boardAfterCap = await call(`/pools/${poolId}/board?week=${currentWeek}`, { token });
  const cappedGame = boardAfterCap.data.games.find((g) => g.id === capGame.id);
  check('exposure is reported per game', cappedGame.exposure === 500);
  check('remaining allowance reaches zero', cappedGame.remaining_allowance === 0);

  const uncapped = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Uncapped ${suffix}`, starting_balance: 5000, max_bet_per_game: null },
  });
  check('a pool can switch the cap off', uncapped.data.pool?.max_bet_per_game === null);
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
    body: { name: `Settle ${suffix}`, starting_balance: 10000, max_bet_per_game: null },
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

  const bootstrapPools = await call('/pools', { token: aliceToken });
  const sharks = bootstrapPools.data.pools.find((p) => p.invite_code === 'SHARKS01');
  check('the bootstrap pool exists', Boolean(sharks));
  const sharkBoard = await call(`/pools/${sharks.id}/leaderboard`, { token: aliceToken });
  check('it ranks by balance', sharkBoard.data.ranked_by === 'balance');
  check('every member is ranked', sharkBoard.data.standings.length === 4);
  check('no fabricated history — everyone is on the opening balance',
    sharkBoard.data.standings.every((s) => s.balance === 10000 && s.wins + s.losses === 0),
    JSON.stringify(sharkBoard.data.standings.map((s) => s.balance)));
  check('the second read is served from redis',
    (await call(`/pools/${sharks.id}/leaderboard`, { token: aliceToken })).data.cached === true);

  const ledger = await call(`/pools/${settleId}/ledger`, { token });
  check('the ledger sums to the balance',
    money(ledger.data.entries.reduce((s, e) => s + e.amount, 0)) === 10131.82);

  section('Voids');
  const voidPool = await call('/pools', {
    method: 'POST', token, body: { name: `Void ${suffix}`, starting_balance: 1000 },
  });
  const voidPoolId = voidPool.data.pool.id;
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

  section('Busting out');
  const bustPool = await call('/pools', {
    method: 'POST',
    token,
    body: {
      name: `Bust ${suffix}`,
      starting_balance: 100,
      max_bet_per_game: null,
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
    body: { name: `Elim ${suffix}`, starting_balance: 100, max_bet_per_game: null },
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
    (await call(`/pools/${poolId}/board`, { token: aliceToken })).status === 403);

  const joined = await call('/pools/join', {
    method: 'POST', token: aliceToken, body: { invite_code: pool.data.pool.invite_code },
  });
  check('joining by invite code works', joined.ok, JSON.stringify(joined.data));
  check('a new member is credited an opening balance',
    (await call(`/pools/${poolId}/balance`, { token: aliceToken })).data.balance === 10000);

  await call('/pools/join', {
    method: 'POST', token: aliceToken, body: { invite_code: pool.data.pool.invite_code },
  });
  check('rejoining does not mint a second opening credit',
    (await call(`/pools/${poolId}/balance`, { token: aliceToken })).data.balance === 10000);
  check('an unknown invite code 404s',
    (await call('/pools/join', {
      method: 'POST', token, body: { invite_code: 'NOPENOPE' },
    })).status === 404);

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
