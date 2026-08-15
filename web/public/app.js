const TOKEN_KEY = 'lp_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  devTools: false,
  legacyModes: false,
  authTab: 'login',
  tab: 'board',
  // Active bet slip: { gameId, market, selection } — a wager is irreversible,
  // so nothing is sent until the member confirms in the slip.
  slip: null,
  slipStake: '',
  // Legacy pick pools only: gameId -> { selected_team, confidence_rank }
  draft: new Map(),
  tiebreaker: '',
  // Visible slice of the week selector: { key, start }. Re-centres on the open
  // week whenever `key` changes; the arrows move `start` on their own.
  weekNav: { key: null, start: 0 },
  // Pool history tab. The pool id rides along so opening a different pool
  // starts at the newest page instead of inheriting the last one's offset.
  history: { poolId: null, offset: 0 },
};

const app = document.getElementById('app');
const topbarActions = document.getElementById('topbar-actions');
const toastEl = document.getElementById('toast');

/* ---------------------------------------------------------------- helpers */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmtKickoff = (iso) => new Date(iso).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const fmtMoney = (value) => Number(value ?? 0).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const fmtSigned = (value) => {
  const n = Number(value ?? 0);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n))}`;
};

function fmtLine(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'PK';
  return n > 0 ? `+${n}` : `${n}`;
}

// Mirrors bet_profit() in SQL: American odds, rounded to the nearest cent.
function previewProfit(stake, price) {
  const raw = price < 0 ? (stake * 100) / Math.abs(price) : (stake * price) / 100;
  return Math.round(raw * 100) / 100;
}

let toastTimer = null;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'toast err' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && state.token) {
    setToken(null);
    location.hash = '#/';
    throw new Error(data.error || 'Session expired, please sign in again');
  }
  if (!res.ok) {
    const detail = data.details?.[0]?.message;
    throw new Error(detail ? `${data.error}: ${detail}` : (data.error || `Request failed (${res.status})`));
  }
  return data;
}

function setToken(token) {
  state.token = token;
  state.user = null;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/* ----------------------------------------------------------------- chrome */

function renderTopbar() {
  topbarActions.innerHTML = state.user
    ? `<span class="muted small">${esc(state.user.username)}</span>
       <button class="ghost" data-action="logout">Sign out</button>`
    : '';
  topbarActions.querySelector('[data-action="logout"]')?.addEventListener('click', () => {
    setToken(null);
    render();
  });
}

/* ------------------------------------------------------------------- auth */

function renderAuth() {
  const isLogin = state.authTab === 'login';
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h1>LeaguePicks</h1>
      <p class="muted small">Season-long sports pools with your friends.</p>
      <div class="tabs" style="margin-top:16px;">
        <button data-tab="login" aria-selected="${isLogin}">Sign in</button>
        <button data-tab="register" aria-selected="${!isLogin}">Create account</button>
      </div>
      <form id="auth-form">
        ${isLogin ? `
          <div class="field">
            <label for="login">Username or email</label>
            <input id="login" name="login" autocomplete="username" required />
          </div>` : `
          <div class="field">
            <label for="username">Username</label>
            <input id="username" name="username" autocomplete="username" required minlength="3" />
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" required />
          </div>`}
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password"
                 autocomplete="${isLogin ? 'current-password' : 'new-password'}"
                 required minlength="${isLogin ? 1 : 8}" />
        </div>
        <button class="primary" type="submit" style="width:100%">
          ${isLogin ? 'Sign in' : 'Create account'}
        </button>
        <p class="error" id="auth-error" hidden></p>
      </form>
      <p class="muted small" style="margin-bottom:0">
        Demo account: <span class="code">admin</span> —
        password <span class="code">password123</span>
      </p>
    </div>`;

  app.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.authTab = btn.dataset.tab;
      renderAuth();
    });
  });

  app.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const errorEl = app.querySelector('#auth-error');
    errorEl.hidden = true;

    try {
      const data = await api(isLogin ? '/auth/login' : '/auth/register', {
        method: 'POST',
        body: Object.fromEntries(form.entries()),
      });
      setToken(data.token);
      state.user = data.user;
      location.hash = '#/pools';
      await render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

/* ------------------------------------------------------------------ pools */

const POOL_LABELS = {
  SPREAD_SHARKS: 'Spread Sharks',
  PICKEM: "Pick'em",
  CONFIDENCE: 'Confidence',
  SURVIVOR: 'Survivor',
};

const isWagerPool = (pool) => pool.pool_type === 'SPREAD_SHARKS';

// Which leagues a pool plays decides which games it can ever show, so they are
// named on the pool rather than left to be inferred from the fixtures.
const LEAGUE_LABELS = { NFL: 'NFL', NCAAF: 'College' };

const leagueBadges = (pool) => (pool.leagues ?? ['NFL'])
  .map((id) => `<span class="badge grey">${esc(LEAGUE_LABELS[id] ?? id)}</span>`)
  .join('');

function poolBadges(pool) {
  return `<span class="badge">${esc(POOL_LABELS[pool.pool_type] ?? pool.pool_type)}</span>
    ${leagueBadges(pool)}
    ${pool.use_spreads && !isWagerPool(pool) ? '<span class="badge grey">Against the spread</span>' : ''}`;
}

async function renderPools() {
  // Every pool is invite-only, so there is nothing to browse — the only ways
  // in are creating one or being given a code.
  const { pools } = await api('/pools');

  app.innerHTML = `
    <div class="row-between" style="margin-bottom:16px;">
      <h1>Your pools</h1>
    </div>

    ${pools.length === 0
      ? '<p class="muted">You have not joined a pool yet. Create one or join with an invite code below.</p>'
      : `<div class="grid" style="margin-bottom:24px;">
          ${pools.map((pool) => `
            <a class="card pool-card" href="#/pools/${esc(pool.id)}">
              <div class="row-between">
                <h3 style="margin:0">${esc(pool.name)}</h3>
                ${isWagerPool(pool)
    ? `<span class="balance-chip">${fmtMoney(pool.balance)}</span>` : ''}
              </div>
              <div class="row" style="margin:8px 0">${poolBadges(pool)}</div>
              <p class="muted small" style="margin:0">
                ${pool.member_count} member${pool.member_count === 1 ? '' : 's'} ·
                season ${pool.season} ·
                commissioner ${esc(pool.commissioner_username)}
                ${pool.is_eliminated ? ' · <span class="badge red">Out</span>' : ''}
              </p>
            </a>`).join('')}
        </div>`}

    <div class="stack">
      <div class="card">
        <h2>Join with an invite code</h2>
        <form id="join-form">
          <div class="field">
            <label for="invite">Invite code</label>
            <input id="invite" name="invite_code" required placeholder="SHARKS01"
                   style="text-transform:uppercase" />
          </div>
          <button class="primary" type="submit">Join pool</button>
          <p class="error" id="join-error" hidden></p>
        </form>
        <p class="muted small" style="margin-bottom:0">
          Pools are private. The only way into one is a code from whoever runs it.
        </p>
      </div>

      <div class="card">
        <h2>Create a pool</h2>
        <form id="create-form">
          <div class="field">
            <label for="pool-name">Pool name</label>
            <input id="pool-name" name="name" required minlength="3" placeholder="Sunday Sharks" />
          </div>
          ${state.legacyModes ? `
            <div class="field">
              <label for="pool-type">Format</label>
              <select id="pool-type" name="pool_type">
                <option value="SPREAD_SHARKS">Spread Sharks (wagering)</option>
                <option value="PICKEM">Pick'em (legacy)</option>
                <option value="CONFIDENCE">Confidence (legacy)</option>
                <option value="SURVIVOR">Survivor (legacy)</option>
              </select>
            </div>` : ''}
          <div class="field">
            <label for="pool-league">Leagues</label>
            <select id="pool-league" name="league">
              <option value="NFL">NFL</option>
              <option value="NCAAF">NCAAF</option>
              <option value="NFL,NCAAF">BOTH</option>
            </select>
            <p class="muted small" style="margin:6px 0 0">
              A pool playing both keeps each league's own week numbering; the
              board shows one at a time.
            </p>
          </div>
          <div class="field">
            <label for="starting-balance">Starting balance</label>
            <input id="starting-balance" name="starting_balance" type="number"
                   min="1" step="0.01" value="20000" required />
          </div>
          <div class="field field-inline">
            <input id="cap-on" name="cap_on" type="checkbox" checked />
            <label for="cap-on" style="margin:0">Cap the size of a single bet</label>
          </div>
          <div class="field" id="cap-field">
            <label for="max-bet">Maximum per bet</label>
            <input id="max-bet" name="max_bet" type="number"
                   min="1" step="1" value="5500" />
            <p class="muted small" style="margin:6px 0 0">
              Applies to each wager on its own. Members can back the same game
              more than once.
            </p>
          </div>
          <div class="field">
            <label for="bust-policy">When a member busts</label>
            <select id="bust-policy" name="bust_policy">
              <option value="ELIMINATE">Eliminate them</option>
              <option value="TOPUP">Weekly top-up</option>
              <option value="REBUY">Allow rebuys</option>
            </select>
          </div>
          <div class="field" id="stipend-field" hidden>
            <label for="stipend">Weekly stipend</label>
            <input id="stipend" name="stipend_amount" type="number" min="1" step="0.01" value="1000" />
          </div>
          <div class="field" id="rebuy-field" hidden>
            <label for="rebuy-limit">Rebuys allowed per season</label>
            <input id="rebuy-limit" name="rebuy_limit" type="number" min="0" max="100" value="1" />
          </div>
          <button class="primary" type="submit">Create pool</button>
          <p class="error" id="create-error" hidden></p>
        </form>
      </div>
    </div>`;

  const form = app.querySelector('#create-form');
  const policy = form.querySelector('#bust-policy');
  const capToggle = form.querySelector('#cap-on');

  const syncSettings = () => {
    form.querySelector('#stipend-field').hidden = policy.value !== 'TOPUP';
    form.querySelector('#rebuy-field').hidden = policy.value !== 'REBUY';
    form.querySelector('#cap-field').hidden = !capToggle.checked;
  };
  policy.addEventListener('change', syncSettings);
  capToggle.addEventListener('change', syncSettings);
  syncSettings();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = app.querySelector('#create-error');
    errorEl.hidden = true;
    try {
      const body = {
        name: form.name.value,
        pool_type: form.pool_type ? form.pool_type.value : 'SPREAD_SHARKS',
        leagues: form.league.value.split(','),
        starting_balance: Number(form.starting_balance.value),
        // An unchecked cap sends null, which the API reads as "no limit".
        max_bet: capToggle.checked ? Number(form.max_bet.value) : null,
        bust_policy: policy.value,
        ...(policy.value === 'TOPUP' ? { stipend_amount: Number(form.stipend_amount.value) } : {}),
        ...(policy.value === 'REBUY' ? { rebuy_limit: Number(form.rebuy_limit.value) } : {}),
      };
      const { pool } = await api('/pools', { method: 'POST', body });
      toast(`Created ${pool.name} — invite code ${pool.invite_code}`);
      location.hash = `#/pools/${pool.id}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  const join = async (code, errorEl) => {
    if (errorEl) errorEl.hidden = true;
    try {
      const { pool } = await api('/pools/join', {
        method: 'POST',
        body: { invite_code: code },
      });
      toast(`Joined ${pool.name}`);
      location.hash = `#/pools/${pool.id}`;
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } else {
        toast(err.message, true);
      }
    }
  };

  app.querySelector('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    join(event.target.invite_code.value, app.querySelector('#join-error'));
  });

  app.querySelectorAll('[data-join]').forEach((btn) => {
    btn.addEventListener('click', () => join(btn.dataset.join, null));
  });
}

/* ---------------------------------------------------------- Spread Sharks */

function balanceStrip(balance, pool) {
  const showCredited = pool.bust_policy !== 'ELIMINATE';
  return `
    <div class="balance-strip">
      <div>
        <span class="label">Balance</span>
        <strong class="figure">${fmtMoney(balance.balance)}</strong>
      </div>
      <div>
        <span class="label">At risk</span>
        <strong class="figure">${fmtMoney(balance.at_risk)}</strong>
      </div>
      <div>
        <span class="label">Net</span>
        <strong class="figure ${balance.net_profit >= 0 ? 'pos' : 'neg'}">
          ${fmtSigned(balance.net_profit)}
        </strong>
      </div>
      ${showCredited ? `
        <div>
          <span class="label">Credited</span>
          <strong class="figure">${fmtMoney(balance.total_credited)}</strong>
        </div>` : ''}
    </div>`;
}

function marketButton(game, market, selection, board) {
  const line = market === 'SPREAD'
    ? (selection === 'HOME' ? game.spread : -game.spread)
    : game.total;
  const label = market === 'SPREAD'
    ? (selection === 'HOME' ? game.home_team : game.away_team)
    : (selection === 'OVER' ? 'Over' : 'Under');
  const display = market === 'SPREAD' ? fmtLine(line) : line;

  const active = state.slip
    && state.slip.gameId === game.id
    && state.slip.market === market
    && state.slip.selection === selection;

  const unavailable = market === 'TOTAL' && game.total === null;
  const disabled = game.locked || unavailable || board.pool_ended
    || board.balance.is_eliminated;

  return `
    <button class="market-btn" type="button" aria-pressed="${Boolean(active)}"
            data-bet="${esc(game.id)}|${market}|${selection}"
            ${disabled ? 'disabled' : ''}>
      <span class="market-name">${esc(label)}</span>
      <span class="market-line">${unavailable ? '—' : esc(display)}</span>
      <span class="market-price">${board.price}</span>
    </button>`;
}

// Everything about the slip that depends on what has been typed into the stake
// field. Kept separate from betSlip so keystrokes never re-render the <input>
// itself — replacing it would drop focus and reset the caret to the far left.
function slipStakeState(game, board) {
  const stake = Number(state.slipStake);
  const valid = state.slipStake !== '' && Number.isFinite(stake)
    && stake >= board.balance.minimum_bet;
  const maxBet = board.balance.max_bet;
  return {
    stake,
    valid,
    maxBet,
    profit: valid ? previewProfit(stake, board.price) : 0,
    // Per wager, not per game — nothing already staked on this fixture counts
    // against it.
    overMax: valid && maxBet !== null && stake > maxBet,
    overBalance: valid && stake > board.balance.balance,
  };
}

function slipPayout(game, board) {
  const { stake, valid, profit } = slipStakeState(game, board);
  return `
    <span class="label">To win</span>
    <strong>${valid ? fmtMoney(profit) : '—'}</strong>
    <span class="muted small">returns ${valid ? fmtMoney(stake + profit) : '—'}</span>`;
}

function slipFoot(game, board) {
  const {
    stake, valid, profit, maxBet, overMax, overBalance,
  } = slipStakeState(game, board);
  return `
    ${overBalance ? '<p class="error">That is more than your balance.</p>' : ''}
    ${overMax ? `<p class="error">This pool caps a single bet at ${fmtMoney(maxBet)}.</p>` : ''}
    <button class="primary slip-confirm" data-slip-confirm
            ${!valid || overBalance || overMax ? 'disabled' : ''}>
      ${valid
    ? `Confirm — risk ${fmtMoney(stake)} to win ${fmtMoney(profit)}`
    : `Enter a stake of at least ${fmtMoney(board.balance.minimum_bet)}`}
    </button>
    <p class="muted small" style="margin:8px 0 0">
      A placed bet cannot be cancelled or edited.
    </p>`;
}

function betSlip(game, board) {
  const { market, selection } = state.slip;
  const line = market === 'SPREAD'
    ? (selection === 'HOME' ? game.spread : -game.spread)
    : game.total;
  const label = market === 'SPREAD'
    ? `${selection === 'HOME' ? game.home_team : game.away_team} ${fmtLine(line)}`
    : `${selection === 'OVER' ? 'Over' : 'Under'} ${game.total}`;

  return `
    <div class="slip">
      <div class="slip-head">
        <div>
          <strong>${esc(label)}</strong>
          <span class="muted small">at ${board.price}</span>
        </div>
        <button class="link" data-slip-close>Cancel</button>
      </div>
      <div class="slip-body">
        <div>
          <label for="slip-stake">Stake</label>
          <input id="slip-stake" type="number" step="1" inputmode="numeric"
                 min="${board.balance.minimum_bet}" value="${esc(state.slipStake)}"
                 placeholder="${fmtMoney(board.balance.minimum_bet)}" autofocus />
        </div>
        <div class="slip-payout" id="slip-payout">${slipPayout(game, board)}</div>
      </div>
      <div id="slip-foot">${slipFoot(game, board)}</div>
    </div>`;
}

const BET_STATUS_CLASS = {
  WON: 'green', LOST: 'red', PUSH: 'amber', VOID: 'grey', PENDING: '',
};

function betChip(bet) {
  const label = bet.market === 'TOTAL'
    ? `${bet.selection === 'OVER' ? 'O' : 'U'} ${bet.line}`
    : `${bet.selection === 'HOME' ? 'H' : 'A'} ${fmtLine(bet.line)}`;
  return `<span class="bet-chip">
      <span class="badge ${BET_STATUS_CLASS[bet.status]}">${bet.status}</span>
      ${esc(label)} · ${fmtMoney(bet.stake)}
      ${bet.net !== null && bet.net !== undefined && bet.status !== 'PENDING'
    ? `· <span class="${bet.net >= 0 ? 'pos' : 'neg'}">${fmtSigned(bet.net)}</span>` : ''}
    </span>`;
}

function boardGame(game, board) {
  const scored = game.home_score !== null && game.home_score !== undefined;
  const slipHere = state.slip?.gameId === game.id;

  return `
    <div class="game${game.locked ? ' locked' : ''}">
      <div class="game-meta">
        <span>${esc(game.away_team)} @ ${esc(game.home_team)}</span>
        <span>
          ${scored ? `${game.away_score} – ${game.home_score} · ` : ''}
          ${game.status === 'VOID' ? '<span class="badge red">Void</span>'
    : game.locked ? `<span class="badge grey">${game.status === 'FINAL' ? 'Final' : 'Locked'}</span>`
      : fmtKickoff(game.kickoff_time)}
        </span>
      </div>

      <div class="market-row">
        <span class="market-label">Spread</span>
        ${marketButton(game, 'SPREAD', 'AWAY', board)}
        ${marketButton(game, 'SPREAD', 'HOME', board)}
      </div>
      <div class="market-row">
        <span class="market-label">Total</span>
        ${marketButton(game, 'TOTAL', 'OVER', board)}
        ${marketButton(game, 'TOTAL', 'UNDER', board)}
      </div>

      ${slipHere ? betSlip(game, board) : ''}

      ${game.my_bets.length > 0 ? `
        <div class="bet-chips">
          ${game.my_bets.map(betChip).join('')}
          ${game.exposure > 0 && !game.locked
    ? `<span class="muted small">${fmtMoney(game.exposure)} on this game</span>` : ''}
        </div>` : ''}

      ${game.other_bets.length > 0 ? `
        <div class="others">Pool: ${game.other_bets.map((b) => `${esc(b.username)} ${
  b.market === 'TOTAL'
    ? `${b.selection === 'OVER' ? 'O' : 'U'} ${b.line}`
    : `${b.selection === 'HOME' ? 'H' : 'A'} ${fmtLine(b.line)}`} ${fmtMoney(b.stake)}`).join(' · ')}</div>` : ''}
    </div>`;
}

function betHistoryTable(history) {
  if (history.bets.length === 0) {
    return '<p class="muted">No bets yet. Place one from the board.</p>';
  }
  const s = history.summary;
  return `
    <p class="muted small" style="margin-top:0">
      ${s.total} bets · ${s.won}W ${s.lost}L ${s.pushed}P${s.voided ? ` ${s.voided}V` : ''} ·
      staked ${fmtMoney(s.staked)} ·
      net <span class="${s.net >= 0 ? 'pos' : 'neg'}">${fmtSigned(s.net)}</span>
    </p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Status</th><th>Wager</th><th>Game</th>
            <th class="num">Stake</th><th class="num">Net</th><th>Placed</th>
          </tr>
        </thead>
        <tbody>
          ${history.bets.map((bet) => `
            <tr>
              <td><span class="badge ${BET_STATUS_CLASS[bet.status]}">${bet.status}</span></td>
              <td>${esc(bet.description)} <span class="muted small">${bet.price}</span></td>
              <td class="muted small">
                W${bet.week} · ${esc(bet.away_team)} @ ${esc(bet.home_team)}
                ${bet.home_score !== null ? ` (${bet.away_score}–${bet.home_score})` : ''}
              </td>
              <td class="num">${fmtMoney(bet.stake)}</td>
              <td class="num ${bet.net > 0 ? 'pos' : bet.net < 0 ? 'neg' : ''}">
                ${bet.net === null ? '—' : fmtSigned(bet.net)}
              </td>
              <td class="muted small">${fmtKickoff(bet.placed_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function wagerLeaderboard(leaderboard, pool, currentUserId) {
  const showCredited = pool.bust_policy !== 'ELIMINATE';
  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="num" style="width:48px">#</th>
            <th>Member</th>
            <th class="num">Balance</th>
            <th class="num">At risk</th>
            <th class="num">Net</th>
            ${showCredited ? '<th class="num">Credited</th>' : ''}
            <th class="num">W</th><th class="num">L</th><th class="num">P</th>
          </tr>
        </thead>
        <tbody>
          ${leaderboard.standings.map((row) => `
            <tr class="${row.user_id === currentUserId ? 'me' : ''}">
              <td class="num">${row.rank}</td>
              <td class="${row.is_eliminated ? 'eliminated' : ''}">
                ${esc(row.username)}
                ${row.is_eliminated ? '<span class="badge red">Bust</span>' : ''}
                ${row.rebuys_used > 0 ? `<span class="badge grey">${row.rebuys_used}× rebuy</span>` : ''}
              </td>
              <td class="num">${fmtMoney(row.balance)}</td>
              <td class="num muted">${fmtMoney(row.at_risk)}</td>
              <td class="num ${row.net_profit >= 0 ? 'pos' : 'neg'}">${fmtSigned(row.net_profit)}</td>
              ${showCredited ? `<td class="num muted">${fmtMoney(row.total_credited)}</td>` : ''}
              <td class="num">${row.wins}</td>
              <td class="num">${row.losses}</td>
              <td class="num">${row.pushes}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="muted small">
      Ranked by balance. Updated ${new Date(leaderboard.computed_at).toLocaleTimeString()}
      ${leaderboard.cached ? '· from cache' : '· freshly computed'}
    </p>`;
}

/* -------------------------------------------------------- pool bet history */

const HISTORY_PAGE_SIZE = 25;

function poolHistoryTable(data) {
  const { bets, page, summary } = data;

  if (page.total === 0) {
    return `<p class="muted">No bets have been placed in this pool yet.</p>
      <p class="muted small">Bets on games that have not kicked off stay private
        to whoever placed them, so this fills in as the week plays out.</p>`;
  }

  const first = page.offset + 1;
  const last = page.offset + bets.length;

  return `
    <p class="muted small" style="margin-top:0">
      ${page.total} bets · staked ${fmtMoney(summary.staked)} ·
      net <span class="${summary.net >= 0 ? 'pos' : 'neg'}">${fmtSigned(summary.net)}</span>
    </p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Member</th><th>Status</th><th>Wager</th><th>Game</th>
            <th class="num">Stake</th><th class="num">Net</th><th>Placed</th>
          </tr>
        </thead>
        <tbody>
          ${bets.map((bet) => `
            <tr class="${bet.is_mine ? 'me' : ''}">
              <td>${esc(bet.username)}</td>
              <td><span class="badge ${BET_STATUS_CLASS[bet.status]}">${bet.status}</span></td>
              <td>${esc(bet.description)} <span class="muted small">${bet.price}</span></td>
              <td class="muted small">
                W${bet.week} · ${esc(bet.away_team)} @ ${esc(bet.home_team)}
                ${bet.home_score !== null ? ` (${bet.away_score}–${bet.home_score})` : ''}
              </td>
              <td class="num">${fmtMoney(bet.stake)}</td>
              <td class="num ${bet.net > 0 ? 'pos' : bet.net < 0 ? 'neg' : ''}">
                ${bet.net === null ? '—' : fmtSigned(bet.net)}
              </td>
              <td class="muted small">${fmtKickoff(bet.placed_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="pager">
      <span class="muted small">Showing ${first}–${last} of ${page.total}</span>
      <span class="row">
        <button data-history-page="${Math.max(0, page.offset - page.limit)}"
                ${page.offset === 0 ? 'disabled' : ''}>← Newer</button>
        <button data-history-page="${page.offset + page.limit}"
                ${page.has_more ? '' : 'disabled'}>Older →</button>
      </span>
    </div>`;
}

/* --------------------------------------------------------------- week nav */

// A single-league pool keeps its short URL; a multi-league pool needs the
// league in the path because the week number alone is ambiguous between them.
function boardHash(poolId, leagues, league, week) {
  const path = leagues.length > 1 ? `${poolId}/${league}` : `${poolId}`;
  return week == null ? `#/pools/${path}` : `#/pools/${path}/${week}`;
}

// Weeks shown either side of the open week before the arrows are needed.
const WEEK_NAV_RADIUS = 3;
const WEEK_NAV_SIZE = WEEK_NAV_RADIUS * 2 + 1;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Resolves (and re-centres, when the open week changed) the visible slice.
function weekWindow(weeks, week, poolId, league = '') {
  const max = Math.max(0, weeks.length - WEEK_NAV_SIZE);
  const key = `${poolId}:${league}:${week}`;
  if (state.weekNav.key !== key) {
    const selected = Math.max(0, weeks.findIndex((w) => w.week === week));
    state.weekNav = { key, start: clamp(selected - WEEK_NAV_RADIUS, 0, max) };
  }
  const start = clamp(state.weekNav.start, 0, max);
  state.weekNav.start = start;
  return { start, end: start + WEEK_NAV_SIZE, atStart: start === 0, atEnd: start === max };
}

function weekNav(weeks, week, poolId, league = '') {
  const { start, end, atStart, atEnd } = weekWindow(weeks, week, poolId, league);
  return `
    <div class="week-nav">
      <button class="week-shift" data-week-shift="-1" aria-label="Earlier weeks"
              ${atStart ? 'disabled' : ''}>‹</button>
      ${weeks.slice(start, end).map((w) => `
        <button data-week="${w.week}" aria-current="${w.week === week}">
          W${w.week}${w.final_count === w.game_count ? ' ✓' : ''}
        </button>`).join('')}
      <button class="week-shift" data-week-shift="1" aria-label="Later weeks"
              ${atEnd ? 'disabled' : ''}>›</button>
    </div>`;
}

// Arrows only slide the window, so they repaint the nav in place instead of
// re-rendering the whole pool view.
function wireWeekNav(weeks, week, poolId, league, onSelect) {
  const host = app.querySelector('[data-week-nav]');
  if (!host) return;

  host.querySelectorAll('[data-week]').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(Number(btn.dataset.week)));
  });

  host.querySelectorAll('[data-week-shift]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.weekNav.start += Number(btn.dataset.weekShift);
      host.innerHTML = weekNav(weeks, week, poolId, league);
      wireWeekNav(weeks, week, poolId, league, onSelect);
    });
  });
}

async function renderSharksPool(detail, week) {
  const poolId = detail.pool.id;
  const league = detail.league;
  const leagues = detail.pool.leagues ?? ['NFL'];
  const [board, history, leaderboard] = await Promise.all([
    api(`/pools/${poolId}/board?league=${league}&week=${week}`),
    api(`/pools/${poolId}/bets`),
    api(`/pools/${poolId}/leaderboard`),
  ]);

  const { balance, pool } = board;
  const canRebuy = balance.is_bust && pool.bust_policy === 'REBUY'
    && balance.rebuys_used < (pool.rebuy_limit ?? 0);

  const paintBoard = () => {
    app.querySelector('#board').innerHTML = board.games
      .map((game) => boardGame(game, board)).join('');
    wireBoard();
    app.querySelector('#slip-stake')?.focus();
  };

  function wireBoard() {
    app.querySelectorAll('[data-bet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [gameId, market, selection] = btn.dataset.bet.split('|');
        const same = state.slip?.gameId === gameId
          && state.slip?.market === market
          && state.slip?.selection === selection;
        state.slip = same ? null : { gameId, market, selection };
        state.slipStake = '';
        paintBoard();
      });
    });

    app.querySelector('[data-slip-close]')?.addEventListener('click', () => {
      state.slip = null;
      state.slipStake = '';
      paintBoard();
    });

    const stakeInput = app.querySelector('#slip-stake');
    stakeInput?.addEventListener('input', (event) => {
      state.slipStake = event.target.value;
      // Repaint only the parts that depend on the stake. The <input> itself is
      // left alone, so focus and the caret stay exactly where the user put them
      // (number inputs don't support selectionStart, so it can't be restored).
      const game = board.games.find((g) => g.id === state.slip.gameId);
      app.querySelector('#slip-payout').innerHTML = slipPayout(game, board);
      app.querySelector('#slip-foot').innerHTML = slipFoot(game, board);
      wireConfirm();
    });

    wireConfirm();
  }

  function wireConfirm() {
    app.querySelector('[data-slip-confirm]')?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        const { bet } = await api(`/pools/${poolId}/bets`, {
          method: 'POST',
          body: {
            game_id: state.slip.gameId,
            market: state.slip.market,
            selection: state.slip.selection,
            stake: Number(state.slipStake),
          },
        });
        toast(`Bet placed: ${bet.description} for ${fmtMoney(bet.stake)}`);
        state.slip = null;
        state.slipStake = '';
        await render();
      } catch (err) {
        toast(err.message, true);
        event.target.disabled = false;
      }
    });
  }

  app.innerHTML = `
    <p><a href="#/pools">← All pools</a></p>

    <div class="row-between" style="margin-bottom:6px;">
      <h1 style="margin:0">${esc(pool.name)}</h1>
      <span class="muted small">Invite code
        <span class="code">${esc(pool.invite_code)}</span></span>
    </div>
    <div class="row" style="margin-bottom:16px;">
      ${poolBadges(pool)}
      <span class="muted small">Season ${pool.season} ·
        ${detail.members.length} members ·
        commissioner ${esc(pool.commissioner_username)}
        ${pool.max_bet !== null
    ? ` · max ${fmtMoney(pool.max_bet)} per bet` : ' · no bet limit'}
        ${pool.ends_at ? ` · ends ${new Date(pool.ends_at).toLocaleDateString()}` : ''}</span>
    </div>

    ${balanceStrip(balance, pool)}

    ${board.pool_ended
    ? '<div class="card notice">This pool has reached its end date. No new bets are accepted.</div>' : ''}
    ${balance.is_eliminated
    ? '<div class="card notice danger"><strong>You are bust.</strong> You have no balance left to wager.</div>' : ''}
    ${canRebuy ? `
      <div class="card notice">
        <div class="row-between">
          <span><strong>You are bust.</strong> This pool allows
            ${pool.rebuy_limit - balance.rebuys_used} more rebuy(s).</span>
          <button class="primary" data-action="rebuy">Rebuy to ${fmtMoney(pool.starting_balance)}</button>
        </div>
      </div>` : ''}

    <div class="tabs">
      <button data-view="board" aria-selected="${state.tab === 'board'}">Board</button>
      <button data-view="bets" aria-selected="${state.tab === 'bets'}">My bets</button>
      <button data-view="history" aria-selected="${state.tab === 'history'}">History</button>
      <button data-view="leaderboard" aria-selected="${state.tab === 'leaderboard'}">Leaderboard</button>
    </div>

    <div class="card" data-panel="board" ${state.tab === 'board' ? '' : 'hidden'}>
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0">Week ${week}</h2>
        ${state.devTools
    ? '<button data-action="simulate" title="Development only: fabricate final scores for this week">Simulate results</button>'
    : ''}
      </div>
      ${leagues.length > 1 ? `
        <div class="league-tabs" role="tablist">
          ${leagues.map((id) => `
            <button role="tab" data-league="${esc(id)}"
                    aria-selected="${id === league}">
              ${esc(LEAGUE_LABELS[id] ?? id)}
            </button>`).join('')}
        </div>
        <p class="muted small" style="margin:0 0 10px">
          Each league keeps its own week numbering — ${esc(LEAGUE_LABELS[league] ?? league)}
          week ${week} here.
        </p>` : ''}
      <div data-week-nav>${weekNav(detail.weeks, week, poolId, league)}</div>
      <div id="board"></div>
    </div>

    <div class="card" data-panel="bets" ${state.tab === 'bets' ? '' : 'hidden'}>
      <h2>Bet history</h2>
      ${betHistoryTable(history)}
    </div>

    <div class="card" data-panel="history" ${state.tab === 'history' ? '' : 'hidden'}>
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0">Pool history</h2>
        <span class="muted small">Every member's bets, newest first</span>
      </div>
      <div id="history-body"><p class="muted">Loading…</p></div>
    </div>

    <div class="card" data-panel="leaderboard" ${state.tab === 'leaderboard' ? '' : 'hidden'}>
      <h2>Leaderboard</h2>
      ${wagerLeaderboard(leaderboard, pool, state.user?.id)}
    </div>`;

  paintBoard();

  // Fetched on demand rather than alongside the board: it is the one panel
  // whose contents are paginated, and most visits never open it.
  async function loadHistory(offset) {
    const body = app.querySelector('#history-body');
    if (!body) return;
    state.history = { poolId, offset };
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api(
        `/pools/${poolId}/history?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`,
      );
      body.innerHTML = poolHistoryTable(data);
      body.querySelectorAll('[data-history-page]').forEach((btn) => {
        btn.addEventListener('click', () => loadHistory(Number(btn.dataset.historyPage)));
      });
    } catch (err) {
      body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  const historyStart = () => (state.history.poolId === poolId ? state.history.offset : 0);

  app.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.view;
      app.querySelectorAll('[data-view]').forEach((b) => {
        b.setAttribute('aria-selected', String(b.dataset.view === state.tab));
      });
      app.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== state.tab;
      });
      // Re-fetched on every open so a settled bet is not shown as pending.
      if (state.tab === 'history') loadHistory(historyStart());
    });
  });

  // The tab survives a repaint, so a bet placed while History was open lands
  // back on History — with an empty panel unless it is filled here too.
  if (state.tab === 'history') loadHistory(historyStart());

  wireWeekNav(detail.weeks, week, poolId, league, (selected) => {
    state.slip = null;
    location.hash = boardHash(poolId, leagues, league, selected);
  });

  // Switching league switches the week set with it: week 2 in one league is a
  // different weekend from week 2 in the other, so the target league's own
  // current week is used rather than carrying this one's number across.
  app.querySelectorAll('[data-league]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.league;
      if (next === league) return;
      state.slip = null;
      const target = detail.by_league?.[next]?.current_week;
      location.hash = boardHash(poolId, leagues, next, target);
    });
  });

  app.querySelector('[data-action="rebuy"]')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const result = await api(`/pools/${poolId}/rebuy`, { method: 'POST' });
      toast(`Rebought for ${fmtMoney(result.credited)}`);
      await render();
    } catch (err) {
      toast(err.message, true);
      event.target.disabled = false;
    }
  });

  app.querySelector('[data-action="simulate"]')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const result = await api('/admin/simulate', {
        method: 'POST',
        body: { season: pool.season, week },
      });
      toast(`Finalized ${result.games_finalized} games, settled ${result.settlement.bets_settled} bets`);
      await render();
    } catch (err) {
      toast(err.message, true);
      event.target.disabled = false;
    }
  });
}

/* ------------------------------------------------- legacy pick-based pools */

function gameCard(game, pool, weekView, tiebreakerGameId) {
  const draft = state.draft.get(game.id);
  const selected = draft?.selected_team ?? null;
  const settled = game.status === 'FINAL' && game.home_score !== null;
  const usedTeams = new Set(weekView.used_teams.map((u) => u.team));

  const teamButton = (team, isHome) => {
    const isSelected = selected === team;
    const line = pool.use_spreads ? fmtLine(isHome ? game.spread : -game.spread) : null;
    const score = isHome ? game.home_score : game.away_score;
    const usedElsewhere = pool.pool_type === 'SURVIVOR' && usedTeams.has(team);
    const disabled = game.locked || usedElsewhere;

    let resultClass = '';
    if (settled && isSelected) {
      const pick = game.my_pick;
      if (pick?.is_correct === true) resultClass = ' result-win';
      else if (pick?.is_correct === false) resultClass = ' result-loss';
    }

    const usedWeek = weekView.used_teams.find((u) => u.team === team)?.week;

    return `
      <button class="team-btn${resultClass}" type="button"
              data-game="${esc(game.id)}" data-team="${esc(team)}"
              aria-pressed="${isSelected}" ${disabled ? 'disabled' : ''}
              ${usedElsewhere ? `title="Already used in week ${usedWeek}"` : ''}>
        <span class="team-name">${esc(team)}${settled ? ` · ${score}` : ''}</span>
        <span class="team-line">
          ${isHome ? 'Home' : 'Away'}${line ? ` · ${line}` : ''}${usedElsewhere ? ' · used' : ''}
        </span>
      </button>`;
  };

  const others = game.other_picks.length > 0
    ? `<div class="others">Also picked: ${game.other_picks
      .map((p) => `${esc(p.username)} → ${esc(p.selected_team)}`).join(', ')}</div>`
    : '';

  const rankRow = pool.pool_type === 'CONFIDENCE' && !game.locked
    ? `<div class="rank-row" data-rank-row="${esc(game.id)}">
         <label for="rank-${esc(game.id)}" style="margin:0">Confidence</label>
         <select id="rank-${esc(game.id)}" data-rank="${esc(game.id)}">
           <option value="">—</option>
           ${Array.from({ length: weekView.games.length }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${draft?.confidence_rank === n ? 'selected' : ''}>${n}</option>`)
    .join('')}
         </select>
       </div>`
    : '';

  const lockedRank = pool.pool_type === 'CONFIDENCE' && game.locked && game.my_pick?.confidence_rank
    ? `<div class="others">Your confidence: ${game.my_pick.confidence_rank}</div>`
    : '';

  const tiebreaker = game.id === tiebreakerGameId && !game.locked
    ? `<div class="rank-row">
         <label for="tiebreaker" style="margin:0">Tiebreaker (total points)</label>
         <input id="tiebreaker" type="number" min="0" max="200" style="width:110px"
                value="${esc(state.tiebreaker)}" />
       </div>`
    : '';

  return `
    <div class="game${game.locked ? ' locked' : ''}">
      <div class="game-meta">
        <span>${fmtKickoff(game.kickoff_time)}</span>
        <span>${game.locked
    ? `<span class="badge grey">${game.status === 'FINAL' ? 'Final' : 'Locked'}</span>` : ''}</span>
      </div>
      <div class="teams">
        ${teamButton(game.away_team, false)}
        ${teamButton(game.home_team, true)}
      </div>
      ${rankRow}${lockedRank}${tiebreaker}${others}
    </div>`;
}

function pickLeaderboard(leaderboard, poolType, currentUserId) {
  if (leaderboard.standings.length === 0) return '<p class="muted">No members yet.</p>';
  const pointsHeader = poolType === 'SURVIVOR' ? 'Weeks survived' : 'Points';

  return `
    <table>
      <thead>
        <tr>
          <th class="num" style="width:48px">#</th>
          <th>Member</th>
          <th class="num">${pointsHeader}</th>
          <th class="num">W</th><th class="num">L</th><th class="num">Push</th>
        </tr>
      </thead>
      <tbody>
        ${leaderboard.standings.map((row) => `
          <tr class="${row.user_id === currentUserId ? 'me' : ''}">
            <td class="num">${row.rank}</td>
            <td class="${row.is_eliminated ? 'eliminated' : ''}">
              ${esc(row.username)}
              ${row.is_eliminated
    ? `<span class="badge red">Out W${row.eliminated_week ?? '?'}</span>` : ''}
            </td>
            <td class="num">${row.points}</td>
            <td class="num">${row.wins}</td>
            <td class="num">${row.losses}</td>
            <td class="num">${row.pushes}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted small" style="margin:10px 0 0">
      Updated ${new Date(leaderboard.computed_at).toLocaleTimeString()}
      ${leaderboard.cached ? '· served from cache' : '· freshly computed'}
    </p>`;
}

async function renderPickPool(detail, week) {
  const poolId = detail.pool.id;
  const [weekView, leaderboard] = await Promise.all([
    api(`/pools/${poolId}/week/${week}`),
    api(`/pools/${poolId}/leaderboard`),
  ]);

  state.draft = new Map();
  state.tiebreaker = '';
  for (const game of weekView.games) {
    if (game.my_pick) {
      state.draft.set(game.id, {
        selected_team: game.my_pick.selected_team,
        confidence_rank: game.my_pick.confidence_rank ?? null,
      });
      if (game.my_pick.tiebreaker_points != null) {
        state.tiebreaker = String(game.my_pick.tiebreaker_points);
      }
    }
  }

  const openGames = weekView.games.filter((g) => !g.locked);
  const tiebreakerGameId = detail.pool.pool_type !== 'SURVIVOR' && openGames.length > 0
    ? openGames[openGames.length - 1].id
    : null;

  const paint = () => {
    app.querySelector('#games').innerHTML = weekView.games
      .map((game) => gameCard(game, detail.pool, weekView, tiebreakerGameId)).join('');
    wireGameHandlers();
  };

  function wireGameHandlers() {
    app.querySelectorAll('.team-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { game: gameId, team } = btn.dataset;
        const existing = state.draft.get(gameId);

        if (detail.pool.pool_type === 'SURVIVOR') {
          const wasSelected = existing?.selected_team === team;
          state.draft = new Map();
          if (!wasSelected) state.draft.set(gameId, { selected_team: team, confidence_rank: null });
        } else if (existing?.selected_team === team) {
          state.draft.delete(gameId);
        } else {
          state.draft.set(gameId, {
            selected_team: team,
            confidence_rank: existing?.confidence_rank ?? null,
          });
        }
        paint();
      });
    });

    app.querySelectorAll('[data-rank]').forEach((select) => {
      select.addEventListener('change', () => {
        const gameId = select.dataset.rank;
        const entry = state.draft.get(gameId);
        const rank = select.value ? Number(select.value) : null;
        if (entry) entry.confidence_rank = rank;
        else if (rank) state.draft.set(gameId, { selected_team: null, confidence_rank: rank });
        highlightDuplicateRanks();
      });
    });

    app.querySelector('#tiebreaker')?.addEventListener('input', (event) => {
      state.tiebreaker = event.target.value;
    });

    highlightDuplicateRanks();
  }

  function highlightDuplicateRanks() {
    if (detail.pool.pool_type !== 'CONFIDENCE') return;
    const counts = new Map();
    for (const [, entry] of state.draft) {
      if (entry.confidence_rank) {
        counts.set(entry.confidence_rank, (counts.get(entry.confidence_rank) ?? 0) + 1);
      }
    }
    app.querySelectorAll('[data-rank-row]').forEach((row) => {
      const entry = state.draft.get(row.dataset.rankRow);
      const dup = entry?.confidence_rank && counts.get(entry.confidence_rank) > 1;
      row.classList.toggle('dup', Boolean(dup));
    });
  }

  app.innerHTML = `
    <p><a href="#/pools">← All pools</a></p>

    <div class="row-between" style="margin-bottom:6px;">
      <h1 style="margin:0">${esc(detail.pool.name)}</h1>
      <span class="muted small">Invite code
        <span class="code">${esc(detail.pool.invite_code)}</span></span>
    </div>
    <div class="row" style="margin-bottom:20px;">
      ${poolBadges(detail.pool)}
      <span class="badge grey">Legacy mode</span>
      <span class="muted small">Season ${detail.pool.season} ·
        ${detail.members.length} members ·
        commissioner ${esc(detail.pool.commissioner_username)}</span>
    </div>

    ${detail.membership?.isEliminated
    ? `<div class="card notice danger">
         <strong>You were eliminated in week ${detail.membership.eliminatedWeek}.</strong>
       </div>` : ''}

    <div class="card">
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0">Week ${week} picks</h2>
        ${state.devTools ? '<button data-action="simulate">Simulate results</button>' : ''}
      </div>
      <div data-week-nav>${weekNav(detail.weeks, week, poolId, detail.league)}</div>
      <div id="games"></div>
      ${openGames.length > 0 && !detail.membership?.isEliminated ? `
        <div class="sticky-save">
          <button class="primary" id="save-picks">Save picks</button>
        </div>` : '<p class="muted small">Every game this week is locked.</p>'}
    </div>

    <div class="card">
      <h2>Leaderboard</h2>
      ${pickLeaderboard(leaderboard, detail.pool.pool_type, state.user?.id)}
    </div>`;

  paint();

  wireWeekNav(detail.weeks, week, poolId, detail.league, (selected) => {
    location.hash = `#/pools/${poolId}/${selected}`;
  });

  app.querySelector('[data-action="simulate"]')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const result = await api('/admin/simulate', {
        method: 'POST',
        body: { season: detail.pool.season, week },
      });
      toast(`Finalized ${result.games_finalized} games, graded ${result.settlement.picks_graded} picks`);
      await render();
    } catch (err) {
      toast(err.message, true);
      event.target.disabled = false;
    }
  });

  app.querySelector('#save-picks')?.addEventListener('click', async (event) => {
    const button = event.target;
    const picks = [];

    for (const [gameId, entry] of state.draft) {
      const game = weekView.games.find((g) => g.id === gameId);
      if (!game || game.locked || !entry.selected_team) continue;
      picks.push({
        game_id: gameId,
        selected_team: entry.selected_team,
        ...(detail.pool.pool_type === 'CONFIDENCE'
          ? { confidence_rank: entry.confidence_rank } : {}),
        ...(gameId === tiebreakerGameId && state.tiebreaker !== ''
          ? { tiebreaker_points: Number(state.tiebreaker) } : {}),
      });
    }

    if (picks.length === 0) {
      toast('Pick at least one game first', true);
      return;
    }
    if (detail.pool.pool_type === 'CONFIDENCE' && picks.some((p) => p.confidence_rank == null)) {
      toast('Every pick needs a confidence rank', true);
      return;
    }

    button.disabled = true;
    try {
      const result = await api(`/pools/${poolId}/picks`, {
        method: 'POST', body: { week, picks },
      });
      toast(`Saved ${result.saved} pick${result.saved === 1 ? '' : 's'}`);
      await render();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ pool router */

async function renderPool(poolId, requestedLeague, requestedWeek) {
  const detail = await api(`/pools/${poolId}`);

  // The league decides which weeks exist, so it is resolved first. An unknown
  // one in the URL falls back to the anchor rather than erroring.
  const leagues = detail.pool.leagues ?? ['NFL'];
  const league = leagues.includes(requestedLeague) ? requestedLeague : leagues[0];
  const view = detail.by_league?.[league] ?? {
    current_week: detail.current_week, weeks: detail.weeks,
  };
  const week = requestedWeek ?? view.current_week ?? view.weeks[0]?.week;
  detail.league = league;
  detail.weeks = view.weeks;
  detail.current_week = view.current_week;

  if (isWagerPool(detail.pool)) await renderSharksPool(detail, week);
  else await renderPickPool(detail, week);
}

/* ----------------------------------------------------------------- router */

// #/pools/:id, #/pools/:id/:week, or #/pools/:id/:league/:week. The league
// segment is only present for a pool that plays more than one, so existing
// single-league links keep working.
function parseRoute() {
  const path = (location.hash.replace(/^#/, '') || '/pools').split('/').filter(Boolean);
  if (path[0] === 'pools' && path[1]) {
    const [, poolId, third, fourth] = path;
    const leagueInPath = third && Number.isNaN(Number(third));
    return {
      name: 'pool',
      poolId,
      league: leagueInPath ? third.toUpperCase() : null,
      week: Number(leagueInPath ? fourth : third) || null,
    };
  }
  return { name: 'pools' };
}

async function render() {
  renderTopbar();

  if (!state.token) {
    renderAuth();
    return;
  }

  try {
    if (!state.user) {
      const { user } = await api('/auth/me');
      state.user = user;
      renderTopbar();
    }

    const route = parseRoute();
    app.innerHTML = '<p class="muted">Loading…</p>';

    if (route.name === 'pool') await renderPool(route.poolId, route.league, route.week);
    else await renderPools();
  } catch (err) {
    if (!state.token) {
      renderAuth();
      return;
    }
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2>
      <p class="error">${esc(err.message)}</p>
      <button data-retry class="primary">Retry</button></div>`;
    app.querySelector('[data-retry]').addEventListener('click', render);
  }
}

window.addEventListener('hashchange', render);

api('/health')
  .then((health) => {
    state.devTools = Boolean(health.dev_tools);
    state.legacyModes = Boolean(health.legacy_pool_modes);
  })
  .catch(() => {})
  .finally(render);
