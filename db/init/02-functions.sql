-- Grading and payout arithmetic, defined once so settlement, seeding, and any
-- future backfill can never disagree about a result.

-- Grades a wager. `line` is the value captured on the bet at placement, not the
-- game's current line. Returns WON / LOST / PUSH, or NULL when the game has no
-- score yet.
--
-- For SPREAD the line is the home team's number, matching games.spread:
-- -3.5 means the home team is favoured by 3.5.
CREATE FUNCTION grade_bet(
    market TEXT,
    selection TEXT,
    line NUMERIC,
    home_score INT,
    away_score INT
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN home_score IS NULL OR away_score IS NULL THEN NULL
        WHEN market = 'SPREAD' THEN
            CASE WHEN selection = 'HOME' THEN
                CASE
                    WHEN home_score + line = away_score THEN 'PUSH'
                    WHEN home_score + line > away_score THEN 'WON'
                    ELSE 'LOST'
                END
            ELSE
                CASE
                    WHEN away_score - line = home_score THEN 'PUSH'
                    WHEN away_score - line > home_score THEN 'WON'
                    ELSE 'LOST'
                END
            END
        WHEN market = 'TOTAL' THEN
            CASE
                WHEN home_score + away_score = line THEN 'PUSH'
                WHEN selection = 'OVER' THEN
                    CASE WHEN home_score + away_score > line THEN 'WON' ELSE 'LOST' END
                ELSE
                    CASE WHEN home_score + away_score < line THEN 'WON' ELSE 'LOST' END
            END
    END
$$;

-- Profit on a winning stake at American odds, rounded to the nearest cent.
-- Postgres ROUND on NUMERIC rounds half away from zero, which is the rule
-- documented in the user story.
CREATE FUNCTION bet_profit(stake NUMERIC, price INT) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT ROUND(
        CASE WHEN price < 0
             THEN stake * 100.0 / abs(price)
             ELSE stake * price / 100.0
        END, 2)
$$;

-- Legacy: grades a pick in one of the pick-based modes. Retained because those
-- modes remain playable, just not offered when creating a pool.
CREATE FUNCTION grade_pick(
    selected_team TEXT,
    home_team TEXT,
    home_score INT,
    away_score INT,
    spread NUMERIC,
    use_spreads BOOLEAN
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN home_score IS NULL OR away_score IS NULL THEN NULL
        WHEN use_spreads THEN
            CASE
                WHEN selected_team = home_team THEN
                    CASE WHEN home_score + spread = away_score THEN NULL
                         ELSE home_score + spread > away_score END
                ELSE
                    CASE WHEN away_score - spread = home_score THEN NULL
                         ELSE away_score - spread > home_score END
            END
        ELSE
            CASE
                WHEN home_score = away_score THEN NULL
                WHEN selected_team = home_team THEN home_score > away_score
                ELSE away_score > home_score
            END
    END
$$;
