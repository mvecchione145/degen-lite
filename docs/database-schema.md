# Database Schema

PostgreSQL schema covering users, pool configuration, the schedule and its lines,
wagers, and the balance ledger.

## Entity Relationships

```
users ──< pool_members >── pools
  │                          │
  ├──────────< bets >────────┤
  │              │           │
  │            games         │
  │                          │
  └──< ledger_entries >──────┘
              │
             bets   (STAKE / PAYOUT / REFUND entries reference their bet)

users ──< picks >── games      (legacy pick-based modes)
```

- A user can be a member of many pools; a pool has many members.
- A pool has one commissioner (`pools.commissioner_id → users.id`).
- A bet belongs to one pool, one user, and one game.
- `games` is global and shared across all pools — schedules, lines, and scores
  are ingested once, not per pool.
- Balance is never stored. It is the sum of a member's `ledger_entries`.

## Tables

### `users`

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    can_create_pools BOOLEAN NOT NULL DEFAULT FALSE,
    token_version INT NOT NULL DEFAULT 0,
    avatar_emoji VARCHAR(24),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- `can_create_pools` — opening a pool is granted per account, not assumed.
  Anyone may register and join with an invite code;
  `scripts/grant-pool-creation.sh` flips this. Checked against the row rather
  than the token, so a revoke takes effect on the next request.
- `token_version` — stamped into every JWT and compared on each request.
  Bumping it fails every token issued before now, which is the only way to end a
  session given a signed token is otherwise valid until it expires. Raised by a
  password change and by `/auth/sign-out-everywhere`.
- `avatar_emoji` — one emoji, shown beside the name on every leaderboard. Per
  account rather than per pool membership: it is who you are, not how you play
  in one league. Wide enough for a ZWJ sequence or a flag, which run to several
  code points each. NULL means none picked, and the UI shows nothing rather
  than a placeholder.

### `pools`

`pool_type` is `SPREAD_SHARKS` for wager pools; the three legacy values remain
valid so existing pools keep working. The wager settings below apply to
`SPREAD_SHARKS` pools.

A **NULL limit means "no limit"** — that is how "switchable off" is encoded.
A separate boolean would permit a meaningless state: a disabled toggle sitting
next to a stale number that someone eventually reads without checking the flag.

```sql
CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commissioner_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(100) NOT NULL,
    invite_code VARCHAR(10) UNIQUE NOT NULL,
    pool_type VARCHAR(30) NOT NULL
        CHECK (pool_type IN ('SPREAD_SHARKS', 'PICKEM', 'CONFIDENCE', 'SURVIVOR')),
    use_spreads BOOLEAN NOT NULL DEFAULT FALSE,   -- legacy modes only
    leagues VARCHAR(10)[] NOT NULL DEFAULT ARRAY['NFL']::VARCHAR(10)[],
    season INT NOT NULL,

    starting_balance NUMERIC(14, 2) NOT NULL DEFAULT 20000.00,
    max_bet NUMERIC(14, 2),                       -- per selection; NULL = uncapped
    min_bet NUMERIC(14, 2),                       -- NULL = the 1.00 floor only
    bust_policy VARCHAR(20) NOT NULL DEFAULT 'ELIMINATE'
        CHECK (bust_policy IN ('ELIMINATE', 'TOPUP', 'REBUY')),
    stipend_amount NUMERIC(14, 2),
    rebuy_limit INT,
    ends_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT bust_policy_parameter CHECK (
        (bust_policy <> 'TOPUP' OR stipend_amount IS NOT NULL)
        AND (bust_policy <> 'REBUY' OR rebuy_limit IS NOT NULL)
    )
);
```

### `pool_members`

```sql
CREATE TABLE pool_members (
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_eliminated BOOLEAN NOT NULL DEFAULT FALSE,
    eliminated_week INT,
    rebuys_used INT NOT NULL DEFAULT 0,
    withdrawn_at TIMESTAMP WITH TIME ZONE,   -- removed by the commissioner; NULL = active
    PRIMARY KEY (pool_id, user_id)
);
```

`withdrawn_at` is how a commissioner removes someone, and it is a state rather
than a deletion. `bets` and `ledger_entries` reference `users`, not this table,
so dropping the row would orphan a member's history instead of cascading it —
and that history is other members' context as much as their own. A withdrawn
member keeps their bets, drops out of every standings query, draws no further
stipend, and can place nothing new. Setting the column back to NULL is the whole
of reinstating them, which is only possible because nothing was destroyed.

`is_eliminated` serves both the survivor legacy mode and the Spread Sharks
elimination bust policy.

### `games`

The schedule, its lines, and its results. The primary key is a `VARCHAR` so
provider identifiers can be used directly, which keeps ingestion idempotent.

`kickoff_time` is the lock boundary. `VOID` is a terminal status distinct from
`FINAL`: the game did not officially conclude under its league's rules, so every
bet on it is refunded.

```sql
CREATE TABLE games (
    id VARCHAR(100) PRIMARY KEY,
    season INT NOT NULL,
    week INT NOT NULL,
    home_team VARCHAR(50) NOT NULL,
    away_team VARCHAR(50) NOT NULL,
    kickoff_time TIMESTAMP WITH TIME ZONE NOT NULL,
    spread NUMERIC(4, 1) NOT NULL DEFAULT 0.0,  -- the home team's line
    total NUMERIC(4, 1),                        -- NULL = no total offered
    home_score INT,
    away_score INT,
    status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED'
        CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'FINAL', 'VOID')),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

There are **no price columns**. While every market is priced −110 the price is a
constant, not data.

### `bets`

`line` and `price` are copied onto the bet at placement. That is what makes
settlement reproducible: later line movement, or a change of odds provider,
can never rewrite a result that has already been graded.

```sql
CREATE TABLE bets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    game_id VARCHAR(100) NOT NULL REFERENCES games(id),
    market VARCHAR(10) NOT NULL CHECK (market IN ('SPREAD', 'TOTAL')),
    selection VARCHAR(10) NOT NULL
        CHECK (selection IN ('HOME', 'AWAY', 'OVER', 'UNDER')),
    line NUMERIC(5, 1) NOT NULL,
    price INT NOT NULL,
    stake NUMERIC(14, 2) NOT NULL CHECK (stake >= 1),
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'WON', 'LOST', 'PUSH', 'VOID')),
    net NUMERIC(14, 2),   -- +profit when won, -stake when lost, 0 on push/void
    placed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT selection_matches_market CHECK (
        (market = 'SPREAD' AND selection IN ('HOME', 'AWAY'))
        OR (market = 'TOTAL' AND selection IN ('OVER', 'UNDER'))
    )
);
```

`CHECK (stake >= 1)` is the whole-unit floor, enforced at the storage layer so no
code path can bypass it.

### `ledger_entries`

Append-only. Nothing here is ever updated or deleted, and balance is the sum of a
member's entries — so balance, bet history, and standings reconcile by
construction rather than by discipline.

```sql
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    bet_id UUID REFERENCES bets(id),
    entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN
        ('OPENING', 'STAKE', 'PAYOUT', 'REFUND', 'STIPEND', 'REBUY')),
    amount NUMERIC(14, 2) NOT NULL,   -- negative for STAKE, positive otherwise
    season INT,                       -- set on STIPEND entries
    week INT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

| Entry | When |
| --- | --- |
| `OPENING` | A member joins a pool |
| `STAKE` | A wager is placed (negative) |
| `PAYOUT` | A winning wager settles — stake + profit |
| `REFUND` | A push or a void — stake returned |
| `STIPEND` | The weekly top-up policy grants its allowance |
| `REBUY` | A bust member resets to the starting balance |

All money columns are `NUMERIC(14,2)`, never floating point. Two decimal places
is the whole precision of the system, and exact decimal arithmetic keeps balances
reproducible.

### `pool_events`

Commissioner actions, readable by the whole pool. Append-only, like the ledger.

```sql
CREATE TABLE pool_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id),
    kind VARCHAR(30) NOT NULL
        CHECK (kind IN ('MEMBER_WITHDRAWN', 'MEMBER_REINSTATED', 'BET_VOIDED')),
    target_user_id UUID REFERENCES users(id),
    bet_id UUID REFERENCES bets(id),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

The commissioner is always also a player, so a removal or a void is one
competitor acting on a rival. Recording it where every member can read it is
what keeps that from being a trust problem. `actor_id` references `users` rather
than `pool_members` so the record survives the actor themselves being withdrawn.

### `picks` — legacy

Retained for the pick-based modes, which remain playable.

```sql
CREATE TABLE picks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    game_id VARCHAR(100) NOT NULL REFERENCES games(id),
    selected_team VARCHAR(50) NOT NULL,
    confidence_rank INT,
    tiebreaker_points INT,
    is_correct BOOLEAN,
    settled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (pool_id, user_id, game_id)
);
```

## Functions

Grading and payout arithmetic is defined once in SQL so settlement, seeding, and
any future backfill cannot disagree.

| Function | Purpose |
| --- | --- |
| `grade_bet(market, selection, line, home_score, away_score)` | Returns `WON` / `LOST` / `PUSH`, or NULL with no score |
| `bet_profit(stake, price)` | Profit at American odds, rounded to the cent |
| `grade_pick(...)` | Legacy pick grading |

## Indexes

```sql
CREATE INDEX games_season_week_idx      ON games (season, week);
CREATE INDEX games_kickoff_idx          ON games (kickoff_time);
CREATE INDEX games_status_idx           ON games (status);
CREATE INDEX bets_pool_user_game_idx    ON bets (pool_id, user_id, game_id);
CREATE INDEX bets_game_idx              ON bets (game_id);
CREATE INDEX bets_pending_idx           ON bets (game_id) WHERE status = 'PENDING';
CREATE INDEX ledger_pool_user_idx       ON ledger_entries (pool_id, user_id);
CREATE INDEX pool_members_user_idx      ON pool_members (user_id);
CREATE INDEX pools_invite_code_idx      ON pools (invite_code);
-- plus picks_pool_user_idx, picks_game_idx, picks_unsettled_idx for legacy pools

-- One stipend per member per week, enforced rather than remembered.
CREATE UNIQUE INDEX ledger_stipend_once_idx
    ON ledger_entries (pool_id, user_id, season, week)
    WHERE entry_type = 'STIPEND';
```

`bets_pool_user_game_idx` backs the per-selection exposure check that runs on
every placement. The check narrows further by market and selection, but
`(pool_id, user_id, game_id)` is the selective prefix — one member's bets on one
fixture are few enough that filtering the rest costs nothing.

## Rules Not Enforced by the Schema

These live in application logic — see
[MVP Implementation](mvp.md#rules-enforced-in-the-application):

- **Kickoff lock** — no wager on a game whose `kickoff_time` has passed
- **Balance sufficiency** — a stake may not exceed available balance
- **Per-selection cap** — aggregate stake on one side of one market on one
  game, checked inside the placing transaction
- **Pool minimum bet** — above the schema's 1.00 floor
- **Bust detection** — balance below the minimum *and* no pending bets
- **Rebuy eligibility** — bust, under the pool's limit
- **End date** — no new wagers past it
- Legacy: confidence rank uniqueness, survivor team reuse, one survivor pick
  per week
