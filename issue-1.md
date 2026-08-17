1. migrate.sh does not add users.token_version, breaking every request on an existing database

Labels: bug, infra

db/init/01-schema.sql:24 adds token_version INT NOT NULL DEFAULT 0, and api/src/auth.js:44 reads it on every authenticated request:

sql
SELECT token_version FROM users WHERE id = $1

scripts/migrate.sh carries forward pool_members.withdrawn_at, pool_events, the pool_events_kind_check constraint, users.avatar_emoji, and the two games abbreviation columns. It does not add token_version, and report() does not check for it.

So on any database created before this change — precisely the case the script exists to handle — requireAuth throws column "token_version" does not exist on the first authenticated call, and the app is unusable until someone adds the column by hand. scripts/change-password.sh:106 fails on the same column.

A fresh volume is unaffected, which is what makes it easy to miss: reset-db.sh and down -v both take the current db/init schema directly.

Suggested fix

Add to the SQL block:

sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

and a matching line in report(). Worth considering a check that fails loudly at API startup when a required column is absent, so this class of miss surfaces as a clear boot error rather than a 500 on every request.
