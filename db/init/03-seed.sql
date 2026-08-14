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
    ('admin', 'admin@degenlite.com', crypt('password123', gen_salt('bf')));