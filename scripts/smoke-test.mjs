#!/usr/bin/env node
// End-to-end smoke test against a running stack.
//
//   docker compose up -d && node scripts/smoke-test.mjs
//
// Exercises the whole flow against the live API: auth, pool creation, the
// kickoff lock, wager validation, settlement arithmetic, voids, bust policies,
// and leaderboards.
//
// It needs a freshly seeded database: it consumes weeks 3, 4, and 5 by
// finalizing them with chosen scorelines, which is what makes the settlement
// assertions exact rather than probabilistic. Reset with:
//
//   docker compose down -v && docker compose up -d

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
  const badLogin = await call('/auth/login', {
    method: 'POST', body: { login: 'alice', password: 'wrong-password' },
  });
  check('wrong password is rejected', badLogin.status === 401);

  const alice = await call('/auth/login', {
    method: 'POST', body: { login: 'alice', password: 'password123' },
  });
  check('seeded user alice can sign in', alice.ok, JSON.stringify(alice.data));
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

  const dupe = await call('/auth/register', {
    method: 'POST',
    body: {
      username: `smoke_${suffix}`,
      email: `other_${suffix}@example.com`,
      password: 'password123',
    },
  });
  check('duplicate username is rejected', dupe.status === 409);
  check('unauthenticated request is rejected', (await call('/pools')).status === 401);

  section('Schedule');
  const weeks = await call('/games/weeks', { token });
  const season = weeks.data.season;
  const currentWeek = weeks.data.current_week;
  check('season has 5 seeded weeks', weeks.data.weeks?.length === 5);
  check('current week is open for wagering', currentWeek === 3, `got ${currentWeek}`);

  if (currentWeek !== 3) {
    throw new Error(
      'This test needs a freshly seeded season. Reset with:\n'
      + '  docker compose down -v && docker compose up -d',
    );
  }

  section('Pool creation');
  const pool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Sharks ${suffix}`, starting_balance: 10000, max_bet_per_game: 500 },
  });
  check('a wager pool is created', pool.status === 201, JSON.stringify(pool.data));
  const poolId = pool.data.pool?.id;
  check('it defaults to SPREAD_SHARKS', pool.data.pool?.pool_type === 'SPREAD_SHARKS');
  check('starting balance is stored', Number(pool.data.pool?.starting_balance) === 10000);
  check('bust policy defaults to elimination', pool.data.pool?.bust_policy === 'ELIMINATE');

  const legacy = await call('/pools', {
    method: 'POST', token, body: { name: `Legacy ${suffix}`, pool_type: 'PICKEM' },
  });
  check('legacy modes are refused at creation', legacy.status === 400, legacy.data.error);

  const badTopup = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Topup ${suffix}`, bust_policy: 'TOPUP' },
  });
  check('a top-up pool without a stipend is refused', badTopup.status === 400);

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
  check('the board lists the week', board.data.games?.length === 16);
  check('every game is open', board.data.games.every((g) => !g.locked));
  check('the posted price is -110', board.data.price === -110);
  check('every game has a spread and a total',
    board.data.games.every((g) => g.spread !== null && g.total !== null));
  const slate = board.data.games;

  section('Placing wagers');
  const bet1 = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 100 },
  });
  check('a wager is accepted', bet1.status === 201, JSON.stringify(bet1.data));
  check('the line is captured on the bet',
    Number(bet1.data.bet.line) === Number(slate[0].spread),
    `bet ${bet1.data.bet?.line} vs game ${slate[0].spread}`);
  check('the price is captured on the bet', bet1.data.bet.price === -110);
  check('it starts pending', bet1.data.bet.status === 'PENDING');

  const afterFirst = await call(`/pools/${poolId}/balance`, { token });
  check('the stake leaves the balance immediately', afterFirst.data.balance === 9900,
    JSON.stringify(afterFirst.data));
  check('the stake shows as at risk', afterFirst.data.at_risk === 100);
  check('net profit is still zero while pending', afterFirst.data.net_profit === 0);

  const tooSmall = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[1].id, market: 'SPREAD', selection: 'HOME', stake: 0.5 },
  });
  check('a stake below one whole unit is refused', tooSmall.status === 400, tooSmall.data.error);

  const tooPrecise = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[1].id, market: 'SPREAD', selection: 'HOME', stake: 10.005 },
  });
  check('three decimal places are refused', tooPrecise.status === 400, tooPrecise.data.error);

  const twoDp = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[1].id, market: 'TOTAL', selection: 'OVER', stake: 12.34 },
  });
  check('two decimal places are accepted', twoDp.status === 201, JSON.stringify(twoDp.data));

  const mismatched = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[2].id, market: 'SPREAD', selection: 'OVER', stake: 10 },
  });
  check('a selection that does not fit the market is refused', mismatched.status === 400);

  section('Per-game cap');
  const capGame = slate[3];
  const first400 = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: capGame.id, market: 'SPREAD', selection: 'HOME', stake: 400 },
  });
  check('a wager within the cap is accepted', first400.status === 201);

  const overCap = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: capGame.id, market: 'TOTAL', selection: 'OVER', stake: 200 },
  });
  check('the cap is on total stake per game, not per wager',
    overCap.status === 400, overCap.data.error);

  const upToCap = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: capGame.id, market: 'TOTAL', selection: 'OVER', stake: 100 },
  });
  check('a wager filling the cap exactly is accepted', upToCap.status === 201,
    JSON.stringify(upToCap.data));

  const boardAfterCap = await call(`/pools/${poolId}/board?week=${currentWeek}`, { token });
  const cappedGame = boardAfterCap.data.games.find((g) => g.id === capGame.id);
  check('exposure is reported per game', cappedGame.exposure === 500,
    `got ${cappedGame.exposure}`);
  check('remaining allowance reaches zero', cappedGame.remaining_allowance === 0);

  const uncapped = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Uncapped ${suffix}`, starting_balance: 5000, max_bet_per_game: null },
  });
  check('a pool can switch the cap off', uncapped.data.pool?.max_bet_per_game === null,
    JSON.stringify(uncapped.data.pool));
  const bigBet = await call(`/pools/${uncapped.data.pool.id}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[0].id, market: 'SPREAD', selection: 'AWAY', stake: 4000 },
  });
  check('with no cap only the balance constrains the stake', bigBet.status === 201,
    JSON.stringify(bigBet.data));

  const overBalance = await call(`/pools/${uncapped.data.pool.id}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[1].id, market: 'SPREAD', selection: 'AWAY', stake: 2000 },
  });
  check('a stake beyond the balance is refused', overBalance.status === 400,
    overBalance.data.error);

  section('Minimum bet');
  const minPool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `MinBet ${suffix}`, starting_balance: 1000, min_bet: 50 },
  });
  const minPoolId = minPool.data.pool.id;
  const belowMin = await call(`/pools/${minPoolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 25 },
  });
  check("a stake below the pool's minimum is refused", belowMin.status === 400,
    belowMin.data.error);
  const atMin = await call(`/pools/${minPoolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 50 },
  });
  check('a stake at the minimum is accepted', atMin.status === 201);

  section('Locked games');
  const week1 = await call(`/games?season=${season}&week=1`, { token });
  const lockedBet = await call(`/pools/${poolId}/bets`, {
    method: 'POST',
    token,
    body: {
      game_id: week1.data.games[0].id, market: 'SPREAD', selection: 'HOME', stake: 10,
    },
  });
  check('a kicked-off game takes no wagers', lockedBet.status === 400, lockedBet.data.error);

  const betId = bet1.data.bet.id;
  const cancel = await call(`/pools/${poolId}/bets/${betId}`, { method: 'DELETE', token });
  check('there is no route to cancel a placed bet', cancel.status === 404);

  section('Mode boundaries');
  const picksOnSharks = await call(`/pools/${poolId}/picks`, { token });
  check('a wager pool refuses the picks view', picksOnSharks.status === 400,
    picksOnSharks.data.error);

  const alicePools = await call('/pools', { token: aliceToken });
  const seededPickem = alicePools.data.pools.find((p) => p.invite_code === 'SUNDAY01');
  check('seeded legacy pools still exist', Boolean(seededPickem));
  const betOnLegacy = await call(`/pools/${seededPickem.id}/bets`, {
    method: 'POST',
    token: aliceToken,
    body: { game_id: slate[0].id, market: 'SPREAD', selection: 'HOME', stake: 10 },
  });
  check('a legacy pool refuses wagers', betOnLegacy.status === 400, betOnLegacy.data.error);

  const legacyPicks = await call(`/pools/${seededPickem.id}/picks`, { token: aliceToken });
  check('legacy pools remain playable', legacyPicks.ok, legacyPicks.data.error);

  section('Settlement arithmetic');
  // Pick a scoreline from a game with a whole-number total so a push is
  // guaranteed, then bet each outcome deliberately.
  // Take the highest whole-number total, so the same scoreline that pushes it
  // comfortably clears the lowest total on the slate.
  const wholeTotals = slate
    .filter((g) => Number(g.total) % 1 === 0)
    .sort((a, b) => Number(b.total) - Number(a.total));
  const pushGame = wholeTotals[0];
  check('the seed includes whole-number totals to exercise pushes', Boolean(pushGame));
  const totalPoints = Number(pushGame.total);
  const homeScore = Math.ceil(totalPoints / 2) + 2;
  const awayScore = totalPoints - homeScore;

  const settlePool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Settle ${suffix}`, starting_balance: 10000, max_bet_per_game: null },
  });
  const settleId = settlePool.data.pool.id;

  const pushBet = await call(`/pools/${settleId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: pushGame.id, market: 'TOTAL', selection: 'OVER', stake: 100 },
  });
  check('the push wager is placed', pushBet.status === 201, JSON.stringify(pushBet.data));

  // Every game gets the same scoreline, so a game whose total sits below it
  // must go over, and one above it must stay under.
  const lowTotal = [...slate].sort((a, b) => Number(a.total) - Number(b.total))[0];
  check('a lower total exists to bet over', Number(lowTotal.total) < totalPoints,
    `low ${lowTotal?.total} vs push ${totalPoints}`);
  const winBet = await call(`/pools/${settleId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: lowTotal.id, market: 'TOTAL', selection: 'OVER', stake: 200 },
  });
  const loseBet = await call(`/pools/${settleId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: lowTotal.id, market: 'TOTAL', selection: 'UNDER', stake: 50 },
  });
  check('both sides of one game can be backed', winBet.status === 201 && loseBet.status === 201);

  const preSettle = await call(`/pools/${settleId}/balance`, { token });
  check('all three stakes have left the balance', preSettle.data.balance === 9650,
    JSON.stringify(preSettle.data));

  const simulated = await call('/admin/simulate', {
    method: 'POST',
    token,
    body: { season, week: currentWeek, home_score: homeScore, away_score: awayScore },
  });
  check('the week is finalized on the chosen scoreline',
    simulated.data.games_finalized === 16, JSON.stringify(simulated.data));
  check('wagers settled', simulated.data.settlement?.bets_settled > 0,
    JSON.stringify(simulated.data.settlement));

  const history = await call(`/pools/${settleId}/bets`, { token });
  const byId = new Map(history.data.bets.map((b) => [b.id, b]));
  const settledPush = byId.get(pushBet.data.bet.id);
  const settledWin = byId.get(winBet.data.bet.id);
  const settledLoss = byId.get(loseBet.data.bet.id);

  check('a total landing exactly on the number is a push',
    settledPush?.status === 'PUSH', `got ${settledPush?.status}`);
  check('a push nets zero', settledPush?.net === 0, `got ${settledPush?.net}`);
  check('the winning side won', settledWin?.status === 'WON', `got ${settledWin?.status}`);
  check('the losing side lost', settledLoss?.status === 'LOST', `got ${settledLoss?.status}`);

  // -110 pays 100/110 of the stake, rounded to the cent: 200 -> 181.82.
  check('profit at -110 is exact to the cent', settledWin?.net === 181.82,
    `got ${settledWin?.net}`);
  check('a loss nets the full stake', settledLoss?.net === -50, `got ${settledLoss?.net}`);

  const postSettle = await call(`/pools/${settleId}/balance`, { token });
  // 10000 - 350 staked + 100 push refund + 381.82 win return = 10131.82
  check('balance reflects every settlement', postSettle.data.balance === 10131.82,
    JSON.stringify(postSettle.data));
  check('net profit backs out what was credited', postSettle.data.net_profit === 131.82,
    JSON.stringify(postSettle.data));
  check('nothing is left at risk', postSettle.data.at_risk === 0);

  const settleAgain = await call('/admin/settle', { method: 'POST', token });
  check('settlement is idempotent', settleAgain.data.bets_settled === 0,
    JSON.stringify(settleAgain.data));

  const balanceUnchanged = await call(`/pools/${settleId}/balance`, { token });
  check('re-running settlement does not double-credit',
    balanceUnchanged.data.balance === 10131.82, JSON.stringify(balanceUnchanged.data));

  section('Bet history and leaderboard');
  check('history lists every bet', history.data.bets.length === 3);
  check('history summarises net', history.data.summary.net === 131.82,
    JSON.stringify(history.data.summary));
  check('history describes the wager as struck',
    typeof settledWin?.description === 'string' && settledWin.description.length > 0,
    settledWin?.description);

  const filtered = await call(`/pools/${settleId}/bets?status=WON`, { token });
  check('history filters by status', filtered.data.bets.every((b) => b.status === 'WON'));

  const seededSharks = alicePools.data.pools.find((p) => p.invite_code === 'SHARKS01');
  check('the seeded Spread Sharks pool exists', Boolean(seededSharks));
  const sharkBoard = await call(`/pools/${seededSharks.id}/leaderboard`, { token: aliceToken });
  check('it ranks by balance', sharkBoard.data.ranked_by === 'balance');
  check('every member is ranked', sharkBoard.data.standings.length === 4);
  check('standings are ordered by balance',
    sharkBoard.data.standings.every((s, i, a) => i === 0 || a[i - 1].balance >= s.balance));
  check('seeded members have wagered', sharkBoard.data.standings.some((s) => s.wins + s.losses > 0));
  check('balances have moved off the opening figure',
    sharkBoard.data.standings.some((s) => s.balance !== 10000));
  const cachedBoard = await call(`/pools/${seededSharks.id}/leaderboard`, { token: aliceToken });
  check('the second read is served from redis', cachedBoard.data.cached === true);

  const ledger = await call(`/pools/${settleId}/ledger`, { token });
  const ledgerSum = money(ledger.data.entries.reduce((s, e) => s + e.amount, 0));
  check('the ledger sums to the balance', ledgerSum === 10131.82, `got ${ledgerSum}`);
  check('the ledger opens with a credit',
    ledger.data.entries.some((e) => e.entry_type === 'OPENING' && e.amount === 10000));

  section('Voids');
  const voidPool = await call('/pools', {
    method: 'POST', token, body: { name: `Void ${suffix}`, starting_balance: 1000 },
  });
  const voidPoolId = voidPool.data.pool.id;
  const week5 = await call(`/games?season=${season}&week=5`, { token });
  const voidGame = week5.data.games[0];

  await call(`/pools/${voidPoolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: voidGame.id, market: 'SPREAD', selection: 'HOME', stake: 250 },
  });
  const beforeVoid = await call(`/pools/${voidPoolId}/balance`, { token });
  check('the stake is held while pending', beforeVoid.data.balance === 750);

  const abandoned = await call('/admin/abandon', {
    method: 'POST', token, body: { game_id: voidGame.id },
  });
  check('a game can be marked abandoned', abandoned.ok, JSON.stringify(abandoned.data));
  check('its wagers are voided', abandoned.data.settlement?.bets_voided === 1,
    JSON.stringify(abandoned.data.settlement));

  const afterVoid = await call(`/pools/${voidPoolId}/balance`, { token });
  check('a void returns the stake in full', afterVoid.data.balance === 1000,
    JSON.stringify(afterVoid.data));

  const voidHistory = await call(`/pools/${voidPoolId}/bets`, { token });
  check('the voided bet is marked VOID', voidHistory.data.bets[0].status === 'VOID');
  check('a void nets zero', voidHistory.data.bets[0].net === 0);

  const rebetVoided = await call(`/pools/${voidPoolId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: voidGame.id, market: 'SPREAD', selection: 'HOME', stake: 10 },
  });
  check('an abandoned game takes no new wagers', rebetVoided.status === 400,
    rebetVoided.data.error);

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

  const week4 = await call(`/games?season=${season}&week=4`, { token });
  // Bet the whole balance UNDER a low total, then finalize the week high.
  const lowGame = [...week4.data.games].sort((a, b) => a.total - b.total)[0];
  await call(`/pools/${bustId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: lowGame.id, market: 'TOTAL', selection: 'UNDER', stake: 100 },
  });

  const earlyRebuy = await call(`/pools/${bustId}/rebuy`, { method: 'POST', token });
  check('a rebuy is refused while a bet is live', earlyRebuy.status === 400,
    earlyRebuy.data.error);

  await call('/admin/simulate', {
    method: 'POST',
    token,
    body: { season, week: 4, home_score: 60, away_score: 59 },
  });

  const busted = await call(`/pools/${bustId}/balance`, { token });
  check('losing the last of the balance leaves nothing', busted.data.balance === 0,
    JSON.stringify(busted.data));
  check('the member reads as bust', busted.data.is_bust === true, JSON.stringify(busted.data));

  const rebought = await call(`/pools/${bustId}/rebuy`, { method: 'POST', token });
  check('a bust member can rebuy', rebought.ok, JSON.stringify(rebought.data));
  check('the rebuy restores the starting balance', rebought.data.credited === 100,
    JSON.stringify(rebought.data));

  const afterRebuy = await call(`/pools/${bustId}/balance`, { token });
  check('balance is back to the opening figure', afterRebuy.data.balance === 100);
  check('the rebuy is not counted as profit', afterRebuy.data.net_profit === -100,
    JSON.stringify(afterRebuy.data));
  check('credited tracks the rebuy', afterRebuy.data.total_credited === 200,
    JSON.stringify(afterRebuy.data));

  const secondRebuy = await call(`/pools/${bustId}/rebuy`, { method: 'POST', token });
  check('the rebuy limit is enforced', secondRebuy.status === 400 || secondRebuy.status === 409,
    JSON.stringify(secondRebuy.data));

  section('Elimination');
  const elimPool = await call('/pools', {
    method: 'POST',
    token,
    body: { name: `Elim ${suffix}`, starting_balance: 100, max_bet_per_game: null },
  });
  const elimId = elimPool.data.pool.id;
  const week5b = await call(`/games?season=${season}&week=5`, { token });
  const lowGame5 = [...week5b.data.games]
    .filter((g) => g.status === 'SCHEDULED')
    .sort((a, b) => a.total - b.total)[0];

  await call(`/pools/${elimId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: lowGame5.id, market: 'TOTAL', selection: 'UNDER', stake: 100 },
  });
  await call('/admin/simulate', {
    method: 'POST', token, body: { season, week: 5, home_score: 60, away_score: 59 },
  });

  const eliminated = await call(`/pools/${elimId}/balance`, { token });
  check('the default policy eliminates a bust member',
    eliminated.data.is_eliminated === true, JSON.stringify(eliminated.data));

  const betWhileOut = await call(`/pools/${elimId}/bets`, {
    method: 'POST',
    token,
    body: { game_id: lowGame5.id, market: 'SPREAD', selection: 'HOME', stake: 10 },
  });
  check('an eliminated member cannot wager', betWhileOut.status === 403 || betWhileOut.status === 400,
    betWhileOut.data.error);

  const noRebuyHere = await call(`/pools/${elimId}/rebuy`, { method: 'POST', token });
  check('an elimination pool refuses rebuys', noRebuyHere.status === 400, noRebuyHere.data.error);

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
    afterStipend.data.net_profit === 0 && afterStipend.data.total_credited === 750,
    JSON.stringify(afterStipend.data));

  await call('/admin/settle', { method: 'POST', token });
  const stipendAgain = await call(`/pools/${topupId}/balance`, { token });
  check('a week only ever grants one stipend', stipendAgain.data.balance === 750,
    JSON.stringify(stipendAgain.data));

  section('Membership and visibility');
  const outsider = await call(`/pools/${poolId}/board`, { token: aliceToken });
  check('a non-member cannot read a private board', outsider.status === 403,
    outsider.data.error);

  const joined = await call('/pools/join', {
    method: 'POST', token: aliceToken, body: { invite_code: pool.data.pool.invite_code },
  });
  check('joining by invite code works', joined.ok, JSON.stringify(joined.data));

  const joinerBalance = await call(`/pools/${poolId}/balance`, { token: aliceToken });
  check('a new member is credited an opening balance',
    joinerBalance.data.balance === 10000, JSON.stringify(joinerBalance.data));

  const rejoin = await call('/pools/join', {
    method: 'POST', token: aliceToken, body: { invite_code: pool.data.pool.invite_code },
  });
  check('joining twice is idempotent', rejoin.ok);

  const rejoinBalance = await call(`/pools/${poolId}/balance`, { token: aliceToken });
  check('rejoining does not mint a second opening credit',
    rejoinBalance.data.balance === 10000, JSON.stringify(rejoinBalance.data));

  check('an unknown invite code 404s',
    (await call('/pools/join', { method: 'POST', token, body: { invite_code: 'NOPENOPE' } })).status === 404);

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
