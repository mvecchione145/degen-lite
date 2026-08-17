-- LeaguePicks schema.
--
-- Follows docs/database-schema.md. Spread Sharks (wager-based pools) is the
-- active mode; the legacy pick-based modes remain in the schema and stay
-- playable, they are simply not offered at pool creation. See docs/mvp.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- User accounts
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    -- Creating a pool is granted, not assumed: anyone may register and join
    -- with an invite code, but only named accounts can open new pools.
    -- scripts/grant-pool-creation.sh flips this. Note the default means a
    -- fresh database has nobody who can create one until the seed grants it.
    can_create_pools BOOLEAN NOT NULL DEFAULT FALSE,
    -- Stamped into every JWT and compared on each request. Bumping it makes
    -- every token issued before now fail — which is the only way to end a
    -- session, since a signed token is otherwise valid until it expires.
    -- Raised on a password change and by "sign out everywhere".
    token_version INT NOT NULL DEFAULT 0,
    -- One emoji, shown beside the name on leaderboards. Per account rather than
    -- per pool: it is who you are, not how you play in one league. Wide enough
    -- for a ZWJ sequence or a flag, which are several code points each; NULL
    -- means the member has not picked one and the UI shows nothing.
    -- What other members see. NULL means "go by the username", which is what
    -- every account starts as. Not unique: two people may both be Mike, and
    -- forcing a suffix on the second one would be worse than the ambiguity.
    -- Taking a name that is already somebody's *username* is refused, though —
    -- that is impersonation, not a coincidence.
    display_name VARCHAR(50),
    avatar_emoji VARCHAR(24),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pools (leagues)
CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commissioner_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(100) NOT NULL,
    invite_code VARCHAR(10) UNIQUE NOT NULL,
    pool_type VARCHAR(30) NOT NULL
        CHECK (pool_type IN ('SPREAD_SHARKS', 'PICKEM', 'CONFIDENCE', 'SURVIVOR')),
    use_spreads BOOLEAN NOT NULL DEFAULT FALSE,
    -- The leagues this pool plays, one or both. Weeks are never merged across
    -- them: college week 2 and NFL week 2 are different weekends, so the board
    -- shows one league at a time and each keeps its own numbering. The first
    -- entry is the anchor — it decides which week the pool is "on" for weekly
    -- stipends, which are per pool rather than per league.
    leagues VARCHAR(10)[] NOT NULL DEFAULT ARRAY['NFL']::VARCHAR(10)[]
        CHECK (leagues <@ ARRAY['NFL', 'NCAAF']::VARCHAR(10)[]
               AND array_length(leagues, 1) BETWEEN 1 AND 2),
    season INT NOT NULL,

    -- Spread Sharks settings. A NULL limit means "no limit" rather than
    -- carrying a separate on/off flag next to a stale number.
    starting_balance NUMERIC(14, 2) NOT NULL DEFAULT 20000.00
        CHECK (starting_balance > 0),
    -- The most a member may have riding on one selection — one side of one
    -- market on one game. Enforced against the sum of their bets on that
    -- selection, so splitting a wager into pieces cannot buy extra allowance.
    -- A different side, market or game each gets its own.
    max_bet NUMERIC(14, 2)
        CHECK (max_bet IS NULL OR max_bet >= 1),
    min_bet NUMERIC(14, 2)
        CHECK (min_bet IS NULL OR min_bet >= 1),
    bust_policy VARCHAR(20) NOT NULL DEFAULT 'ELIMINATE'
        CHECK (bust_policy IN ('ELIMINATE', 'TOPUP', 'REBUY')),
    stipend_amount NUMERIC(14, 2) CHECK (stipend_amount IS NULL OR stipend_amount > 0),
    rebuy_limit INT CHECK (rebuy_limit IS NULL OR rebuy_limit >= 0),
    ends_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Each bust policy needs its own parameter present.
    CONSTRAINT bust_policy_parameter CHECK (
        (bust_policy <> 'TOPUP' OR stipend_amount IS NOT NULL)
        AND (bust_policy <> 'REBUY' OR rebuy_limit IS NOT NULL)
    )
);

-- Pool memberships
-- `withdrawn_at` is how a commissioner removes someone. It is a state, not a
-- deletion: the member's bets and ledger entries are real history that other
-- members' standings context depends on, and `bets`/`ledger_entries` reference
-- `users` rather than this table, so deleting the row would orphan them rather
-- than cascade. A withdrawn member keeps their history, drops out of standings,
-- and can place nothing further.
CREATE TABLE pool_members (
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_eliminated BOOLEAN NOT NULL DEFAULT FALSE,
    eliminated_week INT,
    rebuys_used INT NOT NULL DEFAULT 0,
    withdrawn_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (pool_id, user_id)
);


-- Season schedule and results, shared across every pool.
--
-- VOID is a terminal state distinct from FINAL: the game did not officially
-- conclude under its league's rules, so every bet on it is refunded.
CREATE TABLE games (
    id VARCHAR(100) PRIMARY KEY,
    -- Which football is this. Weeks only mean something within a league: the
    -- NFL runs 1–18 on Sundays, college runs 1–16 on Saturdays plus a
    -- postseason filed as 17, and the two must never share a board.
    league VARCHAR(10) NOT NULL DEFAULT 'NFL'
        CHECK (league IN ('NFL', 'NCAAF')),
    season INT NOT NULL,
    week INT NOT NULL,
    home_team VARCHAR(50) NOT NULL,
    away_team VARCHAR(50) NOT NULL,
    -- The feed's own abbreviations (NE, SEA, TCU, NCSU). Stored rather than
    -- derived: a full name does not fit a phone, and guessing the short form
    -- from it is wrong often enough to matter — "TCU Horned Frogs" reduces to
    -- TH, and the two Los Angeles teams collide. ESPN publishes the canonical
    -- one per team, so this just keeps what the ingester was already reading.
    home_team_abbr VARCHAR(8),
    away_team_abbr VARCHAR(8),
    kickoff_time TIMESTAMP WITH TIME ZONE NOT NULL,
    -- The home team's line: -3.5 means the home team is favoured by 3.5.
    spread NUMERIC(4, 1) NOT NULL DEFAULT 0.0,
    -- The over/under. NULL means the total market is not offered on this game.
    total NUMERIC(4, 1),
    home_score INT,
    away_score INT,
    status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED'
        CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'FINAL', 'VOID')),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Wagers. The line and price are copied onto the bet at placement so later
-- line movement, or a change of odds provider, can never rewrite a settled
-- result. `price` is American odds and is always -110 today.
CREATE TABLE bets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    game_id VARCHAR(100) NOT NULL REFERENCES games(id),
    market VARCHAR(10) NOT NULL CHECK (market IN ('SPREAD', 'TOTAL')),
    selection VARCHAR(10) NOT NULL
        CHECK (selection IN ('HOME', 'AWAY', 'OVER', 'UNDER')),
    line NUMERIC(5, 1) NOT NULL,
    price INT NOT NULL CHECK (price <= -100 OR price >= 100),
    stake NUMERIC(14, 2) NOT NULL CHECK (stake >= 1),
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'WON', 'LOST', 'PUSH', 'VOID')),
    -- Net result: +profit when won, -stake when lost, 0 on a push or void.
    net NUMERIC(14, 2),
    placed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT selection_matches_market CHECK (
        (market = 'SPREAD' AND selection IN ('HOME', 'AWAY'))
        OR (market = 'TOTAL' AND selection IN ('OVER', 'UNDER'))
    )
);

-- Append-only balance ledger. Balance is the sum of a member's entries, so
-- history and standings reconcile by construction rather than by discipline.
-- Nothing here is ever updated or deleted.
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    bet_id UUID REFERENCES bets(id),
    entry_type VARCHAR(20) NOT NULL
        CHECK (entry_type IN ('OPENING', 'STAKE', 'PAYOUT', 'REFUND', 'STIPEND', 'REBUY')),
    -- Signed: negative for STAKE, positive for everything else.
    amount NUMERIC(14, 2) NOT NULL,
    -- Set on STIPEND entries so a week's grant can only happen once.
    season INT,
    week INT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User picks, for the legacy pick-based modes.
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

-- Every board read is (league, season, week); a season/week index would make
-- two leagues share a scan and then filter half of it away.
-- Commissioner actions, shown to the pool. The commissioner is always also a
-- player, so a removal or a void is a competitor acting on a rival; recording it
-- where everyone can see is what keeps that from being a trust problem.
--
-- Append-only, like the ledger. `actor_id` is not a foreign key to
-- `pool_members` because a commissioner could later be withdrawn themselves and
-- the record must survive that.
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

CREATE INDEX pool_events_pool_idx ON pool_events (pool_id, created_at DESC);


CREATE INDEX games_league_season_week_idx ON games (league, season, week);
CREATE INDEX games_kickoff_idx ON games (kickoff_time);
CREATE INDEX games_status_idx ON games (status);
CREATE INDEX picks_pool_user_idx ON picks (pool_id, user_id);
CREATE INDEX picks_game_idx ON picks (game_id);
CREATE INDEX picks_unsettled_idx ON picks (settled_at) WHERE settled_at IS NULL;
CREATE INDEX pool_members_user_idx ON pool_members (user_id);
CREATE INDEX pools_invite_code_idx ON pools (invite_code);

-- Backs the per-game exposure check on every placement.
CREATE INDEX bets_pool_user_game_idx ON bets (pool_id, user_id, game_id);
-- The pool history reads newest-first within one pool, filtered or not.
CREATE INDEX bets_pool_placed_idx ON bets (pool_id, placed_at DESC);
CREATE INDEX bets_game_idx ON bets (game_id);
CREATE INDEX bets_pending_idx ON bets (game_id) WHERE status = 'PENDING';
CREATE INDEX ledger_pool_user_idx ON ledger_entries (pool_id, user_id);

-- One stipend per member per week, enforced rather than remembered.
CREATE UNIQUE INDEX ledger_stipend_once_idx
    ON ledger_entries (pool_id, user_id, season, week)
    WHERE entry_type = 'STIPEND';
