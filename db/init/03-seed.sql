-- Bootstrap.
--
-- No sports data is created here. Games, spreads, totals, and scores all come
-- from real feeds — the schedule and results from ESPN, the lines from SharpAPI
-- — pulled by the worker on startup. See docs/data-sources.md.
--
-- What remains is the minimum needed to sign in and see the board: one account,
-- no pools. Delete this file to start with nothing at all; the application
-- creates everything else through the API.
--
-- Account: admin / admin@degenlite.com, password `password123`.
--
-- It is granted pool creation here because can_create_pools defaults to false:
-- without this line a freshly seeded database has nobody who can open a pool,
-- and the only way out is running SQL by hand.
--
-- These statements only ever run against an empty data directory — Postgres
-- skips /docker-entrypoint-initdb.d entirely once the volume holds a database.
-- Editing this file therefore does nothing to a running stack until the volume
-- is removed (docker compose down && docker volume rm leaguepicks_pgdata).

INSERT INTO users (username, email, password_hash, can_create_pools) VALUES
    ('admin', 'admin@degenlite.com', crypt('password123', gen_salt('bf')), TRUE);