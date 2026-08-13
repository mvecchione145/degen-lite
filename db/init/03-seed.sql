-- Demo data.
--
-- Everything is generated relative to CURRENT_TIMESTAMP at container init, so a
-- freshly created volume always yields the same shape:
--
--   weeks 1-2  in the past, FINAL, with bets and picks already settled
--   week  3    kicks off ~2 days from now, SCHEDULED  -> open for wagering
--   weeks 4-5  further out, SCHEDULED
--
-- Demo accounts: alice / bob / carol / dave, all with password `password123`.

-- Schedule and lines ---------------------------------------------------------
--
-- Lines are synthetic placeholders. They stand in for a sportsbook odds feed,
-- and the API reads them through the provider interface in
-- api/src/services/lines.js so the real feed can replace them without touching
-- bet placement or settlement.
DO $$
DECLARE
    afc TEXT[] := ARRAY[
        'Bills', 'Dolphins', 'Patriots', 'Jets',
        'Ravens', 'Bengals', 'Browns', 'Steelers',
        'Texans', 'Colts', 'Jaguars', 'Titans',
        'Broncos', 'Chiefs', 'Raiders', 'Chargers'
    ];
    nfc TEXT[] := ARRAY[
        'Cowboys', 'Giants', 'Eagles', 'Commanders',
        'Bears', 'Lions', 'Packers', 'Vikings',
        'Falcons', 'Panthers', 'Saints', 'Buccaneers',
        'Cardinals', 'Rams', '49ers', 'Seahawks'
    ];
    v_base TIMESTAMPTZ := date_trunc('hour', CURRENT_TIMESTAMP) + INTERVAL '2 days';
    v_season INT;
    v_week INT;
    v_game INT;
    v_kickoff TIMESTAMPTZ;
    v_spread NUMERIC(4, 1);
    v_total NUMERIC(4, 1);
    v_home_score INT;
    v_away_score INT;
BEGIN
    v_season := EXTRACT(YEAR FROM v_base)::INT;

    FOR v_week IN 1..5 LOOP
        FOR v_game IN 1..16 LOOP
            -- Six early games, six mid-afternoon, four in the evening.
            v_kickoff := v_base
                + ((v_week - 3) * INTERVAL '7 days')
                + (((v_game - 1) / 6) * INTERVAL '3 hours');

            -- Mostly half-point lines so most bets resolve cleanly, with a few
            -- whole numbers so pushes actually occur in the demo data.
            v_spread := ((v_game % 9) - 4)
                + CASE WHEN v_game % 7 = 0 THEN 0.0 ELSE 0.5 END;
            v_total := 41 + ((v_game * 3 + v_week * 5) % 13)
                + CASE WHEN v_game % 4 = 0 THEN 0.0 ELSE 0.5 END;

            IF v_kickoff < CURRENT_TIMESTAMP THEN
                v_home_score := 13 + ((v_week * 7 + v_game * 13) % 22);
                v_away_score := 13 + ((v_week * 11 + v_game * 5) % 22);
                IF v_home_score = v_away_score THEN
                    v_home_score := v_home_score + 3;
                END IF;
            ELSE
                v_home_score := NULL;
                v_away_score := NULL;
            END IF;

            INSERT INTO games (
                id, season, week, home_team, away_team,
                kickoff_time, spread, total, home_score, away_score, status
            ) VALUES (
                format('%s-W%s-G%s', v_season, v_week, v_game),
                v_season,
                v_week,
                afc[v_game],
                nfc[((v_game + v_week - 2) % 16) + 1],
                v_kickoff,
                v_spread,
                v_total,
                v_home_score,
                v_away_score,
                CASE WHEN v_home_score IS NULL THEN 'SCHEDULED' ELSE 'FINAL' END
            );
        END LOOP;
    END LOOP;
END $$;

-- Users ----------------------------------------------------------------------
INSERT INTO users (username, email, password_hash) VALUES
    ('alice', 'alice@example.com', crypt('password123', gen_salt('bf'))),
    ('bob',   'bob@example.com',   crypt('password123', gen_salt('bf'))),
    ('carol', 'carol@example.com', crypt('password123', gen_salt('bf'))),
    ('dave',  'dave@example.com',  crypt('password123', gen_salt('bf')));

-- Pools ----------------------------------------------------------------------
-- One Spread Sharks pool (the active mode) plus one of each legacy mode, which
-- remain playable but are no longer offered at creation.
INSERT INTO pools (
    commissioner_id, name, invite_code, pool_type, use_spreads, is_public, season,
    starting_balance, max_bet_per_game, bust_policy
)
SELECT u.id, p.name, p.invite_code, p.pool_type, p.use_spreads, p.is_public,
       (SELECT MAX(season) FROM games),
       10000.00, 500.00, 'ELIMINATE'
FROM (VALUES
    ('alice', 'Spread Sharks',          'SHARKS01', 'SPREAD_SHARKS', FALSE, TRUE),
    ('alice', 'Sunday Funday Pick''em', 'SUNDAY01', 'PICKEM',        FALSE, TRUE),
    ('bob',   'Office Confidence',      'OFFICE01', 'CONFIDENCE',    FALSE, TRUE),
    ('carol', 'Last One Standing',      'SURVIVE1', 'SURVIVOR',      FALSE, TRUE)
) AS p(commissioner, name, invite_code, pool_type, use_spreads, is_public)
JOIN users u ON u.username = p.commissioner;

-- Everyone joins every demo pool.
INSERT INTO pool_members (pool_id, user_id)
SELECT p.id, u.id FROM pools p CROSS JOIN users u;

-- Opening balances for wager-based pools.
INSERT INTO ledger_entries (pool_id, user_id, entry_type, amount)
SELECT p.id, pm.user_id, 'OPENING', p.starting_balance
FROM pools p
JOIN pool_members pm ON pm.pool_id = p.id
WHERE p.pool_type = 'SPREAD_SHARKS';

-- Settled wagers for the completed weeks ------------------------------------
DO $$
DECLARE
    v_season INT := (SELECT MAX(season) FROM games);
    p RECORD;
    u RECORD;
    g RECORD;
    v_week INT;
    v_slot INT;
    v_game_no INT;
    v_market TEXT;
    v_selection TEXT;
    v_line NUMERIC(5, 1);
    v_stake NUMERIC(14, 2);
    v_result TEXT;
    v_net NUMERIC(14, 2);
    v_bet_id UUID;
BEGIN
    FOR p IN SELECT * FROM pools WHERE pool_type = 'SPREAD_SHARKS' LOOP
        FOR u IN
            SELECT id, username, (row_number() OVER (ORDER BY username))::INT AS n
            FROM users
        LOOP
            FOR v_week IN 1..2 LOOP
                -- Three wagers a week: two spreads and a total, on different
                -- games, varying by member so the standings actually separate.
                FOR v_slot IN 1..3 LOOP
                    v_game_no := u.n + ((v_slot - 1) * 4);

                    SELECT * INTO g FROM games
                    WHERE id = format('%s-W%s-G%s', v_season, v_week, v_game_no);

                    IF v_slot = 3 THEN
                        v_market := 'TOTAL';
                        v_selection := CASE WHEN (u.n + v_week) % 2 = 0
                                            THEN 'OVER' ELSE 'UNDER' END;
                        v_line := g.total;
                        v_stake := 150.00 + (u.n * 10);
                    ELSE
                        v_market := 'SPREAD';
                        v_selection := CASE WHEN (u.n + v_week + v_slot) % 2 = 0
                                            THEN 'HOME' ELSE 'AWAY' END;
                        v_line := g.spread;
                        v_stake := CASE WHEN v_slot = 1
                                        THEN 200.00 + (u.n * 50)
                                        ELSE 100.50 + (u.n * 25) END;
                    END IF;

                    v_result := grade_bet(v_market, v_selection, v_line,
                                          g.home_score, g.away_score);
                    v_net := CASE v_result
                        WHEN 'WON' THEN bet_profit(v_stake, -110)
                        WHEN 'LOST' THEN -v_stake
                        ELSE 0.00
                    END;

                    INSERT INTO bets (
                        pool_id, user_id, game_id, market, selection, line,
                        price, stake, status, net, placed_at, settled_at
                    ) VALUES (
                        p.id, u.id, g.id, v_market, v_selection, v_line,
                        -110, v_stake, v_result, v_net,
                        g.kickoff_time - INTERVAL '1 day',
                        g.kickoff_time + INTERVAL '3 hours'
                    ) RETURNING id INTO v_bet_id;

                    -- The stake leaves the balance at placement.
                    INSERT INTO ledger_entries (
                        pool_id, user_id, bet_id, entry_type, amount, created_at
                    ) VALUES (
                        p.id, u.id, v_bet_id, 'STAKE', -v_stake,
                        g.kickoff_time - INTERVAL '1 day'
                    );

                    IF v_result = 'WON' THEN
                        INSERT INTO ledger_entries (
                            pool_id, user_id, bet_id, entry_type, amount, created_at
                        ) VALUES (
                            p.id, u.id, v_bet_id, 'PAYOUT', v_stake + v_net,
                            g.kickoff_time + INTERVAL '3 hours'
                        );
                    ELSIF v_result = 'PUSH' THEN
                        INSERT INTO ledger_entries (
                            pool_id, user_id, bet_id, entry_type, amount, created_at
                        ) VALUES (
                            p.id, u.id, v_bet_id, 'REFUND', v_stake,
                            g.kickoff_time + INTERVAL '3 hours'
                        );
                    END IF;
                END LOOP;
            END LOOP;
        END LOOP;
    END LOOP;
END $$;

-- Settled picks for the legacy pools ----------------------------------------
DO $$
DECLARE
    v_season INT := (SELECT MAX(season) FROM games);
    p RECORD;
    u RECORD;
    g RECORD;
    v_week INT;
    v_selected TEXT;
    v_rank INT;
    v_tiebreaker INT;
    v_survivor_game INT;
BEGIN
    FOR p IN
        SELECT * FROM pools WHERE pool_type <> 'SPREAD_SHARKS' ORDER BY invite_code
    LOOP
        FOR u IN
            SELECT id, username, (row_number() OVER (ORDER BY username))::INT AS n
            FROM users
        LOOP
            FOR v_week IN 1..2 LOOP
                IF p.pool_type = 'SURVIVOR' THEN
                    v_survivor_game := u.n + ((v_week - 1) * 4);

                    SELECT * INTO g FROM games
                    WHERE id = format('%s-W%s-G%s', v_season, v_week, v_survivor_game);

                    INSERT INTO picks (
                        pool_id, user_id, game_id, selected_team,
                        is_correct, settled_at
                    ) VALUES (
                        p.id, u.id, g.id, g.home_team,
                        grade_pick(g.home_team, g.home_team, g.home_score,
                                   g.away_score, g.spread, p.use_spreads),
                        g.kickoff_time + INTERVAL '3 hours'
                    );
                ELSE
                    FOR g IN
                        SELECT *, split_part(id, '-G', 2)::INT AS game_no
                        FROM games
                        WHERE season = v_season AND week = v_week
                        ORDER BY split_part(id, '-G', 2)::INT
                    LOOP
                        v_selected := CASE
                            WHEN ((u.n * 3) + (g.week * 7)
                                  + (g.game_no * 5)) % 10 < 6
                            THEN g.home_team ELSE g.away_team END;

                        IF p.pool_type = 'CONFIDENCE' THEN
                            v_rank := (((g.game_no - 1) * (2 * u.n + 1)
                                        + v_week) % 16) + 1;
                        ELSE
                            v_rank := NULL;
                        END IF;

                        v_tiebreaker := CASE
                            WHEN g.game_no = 16
                            THEN 38 + ((u.n * 7 + v_week * 3) % 20)
                            ELSE NULL END;

                        INSERT INTO picks (
                            pool_id, user_id, game_id, selected_team,
                            confidence_rank, tiebreaker_points,
                            is_correct, settled_at
                        ) VALUES (
                            p.id, u.id, g.id, v_selected,
                            v_rank, v_tiebreaker,
                            grade_pick(v_selected, g.home_team, g.home_score,
                                       g.away_score, g.spread, p.use_spreads),
                            g.kickoff_time + INTERVAL '3 hours'
                        );
                    END LOOP;
                END IF;
            END LOOP;
        END LOOP;
    END LOOP;
END $$;

-- Apply survivor eliminations from those graded picks.
UPDATE pool_members pm
SET is_eliminated = TRUE,
    eliminated_week = sub.week
FROM (
    SELECT p.pool_id, p.user_id, MIN(g.week) AS week
    FROM picks p
    JOIN games g ON g.id = p.game_id
    JOIN pools po ON po.id = p.pool_id
    WHERE po.pool_type = 'SURVIVOR' AND p.is_correct = FALSE
    GROUP BY p.pool_id, p.user_id
) sub
WHERE pm.pool_id = sub.pool_id AND pm.user_id = sub.user_id;
