-- Bootstrap.
--
-- No sports data is created here. Games, spreads, totals, and scores all come
-- from real feeds — the schedule and results from ESPN, the lines from SharpAPI
-- — pulled by the worker on startup. See docs/data-sources.md.
--
-- What remains is the minimum needed to sign in and see the board:
-- four accounts and one empty pool. Delete this file to start with nothing at
-- all; the application creates everything else through the API.
--
-- Accounts: alice / bob / carol / dave, all with password `password123`.

INSERT INTO users (username, email, password_hash) VALUES
    ('alice', 'alice@example.com', crypt('password123', gen_salt('bf'))),
    ('bob',   'bob@example.com',   crypt('password123', gen_salt('bf'))),
    ('carol', 'carol@example.com', crypt('password123', gen_salt('bf'))),
    ('dave',  'dave@example.com',  crypt('password123', gen_salt('bf')));

-- One open pool on the current NFL season. A season runs from its September
-- kickoff into the following January, so anything before March still belongs to
-- the previous year's season. The API derives the season the same way, so the
-- pool and the ingested schedule agree.
INSERT INTO pools (
    commissioner_id, name, invite_code, pool_type, is_public, season,
    starting_balance, max_bet_per_game, bust_policy
)
SELECT u.id, 'Spread Sharks', 'SHARKS01', 'SPREAD_SHARKS', TRUE,
       CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 3
            THEN EXTRACT(YEAR FROM CURRENT_DATE)::INT
            ELSE EXTRACT(YEAR FROM CURRENT_DATE)::INT - 1 END,
       10000.00, 500.00, 'ELIMINATE'
FROM users u WHERE u.username = 'alice';

INSERT INTO pool_members (pool_id, user_id)
SELECT p.id, u.id FROM pools p CROSS JOIN users u;

-- Everyone starts on the pool's opening balance. No wagers are fabricated.
INSERT INTO ledger_entries (pool_id, user_id, entry_type, amount)
SELECT p.id, pm.user_id, 'OPENING', p.starting_balance
FROM pools p
JOIN pool_members pm ON pm.pool_id = p.id
WHERE p.pool_type = 'SPREAD_SHARKS';
