#!/usr/bin/env bash
#
# Bring an existing database up to the current schema.
#
#   ./scripts/migrate.sh          # apply
#   ./scripts/migrate.sh --check  # report only, change nothing
#
# This project ships its schema as db/init/*.sql, which Postgres runs once
# against an empty data directory and never again. A database created before a
# column existed therefore never gets it, and the API errors on every read that
# touches it. This script carries the additive changes forward.
#
# A fresh volume needs none of this — scripts/reset-db.sh, or
# `docker compose down -v`, takes the current schema from db/init directly.
#
# Every statement is idempotent, so re-running is safe and is the normal way to
# check a database is current. Add new changes to the SQL block at the bottom
# rather than writing another script.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/db.sh
. "$(dirname "$0")/lib/db.sh"

usage() {
  sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
}

CHECK_ONLY=false
case "${1:-}" in
  --check) CHECK_ONLY=true ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) usage >&2; exit 1 ;;
esac

require_db

# Each line reports one thing the current code needs. Keep the labels aligned
# so a missing item is obvious at a glance.
report() {
  psql_run -tAc "
    SELECT 'pool_members.withdrawn_at : ' || CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pool_members' AND column_name = 'withdrawn_at'
    ) THEN 'present' ELSE 'MISSING' END
    UNION ALL
    SELECT 'pool_events table         : ' || CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'pool_events'
    ) THEN 'present' ELSE 'MISSING' END
    UNION ALL
    SELECT 'pool_events reinstate kind: ' || CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'pool_events_kind_check'
         AND pg_get_constraintdef(oid) LIKE '%MEMBER_REINSTATED%'
    ) THEN 'present' ELSE 'MISSING' END
    UNION ALL
    SELECT 'users.avatar_emoji        : ' || CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'avatar_emoji'
    ) THEN 'present' ELSE 'MISSING' END;"
}

echo "Before:"
report

if [ "$CHECK_ONLY" = true ]; then
  exit 0
fi

psql_run <<'SQL'
BEGIN;

-- Commissioner controls: removing a member is a state, not a deletion.
ALTER TABLE pool_members
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS pool_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id),
    kind VARCHAR(30) NOT NULL,
    target_user_id UUID REFERENCES users(id),
    bet_id UUID REFERENCES bets(id),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pool_events_pool_idx
    ON pool_events (pool_id, created_at DESC);

-- Dropped and recreated rather than added: CREATE TABLE IF NOT EXISTS above is
-- a no-op on a database that already has the table, so a constraint that has
-- since gained a value would otherwise keep refusing it. Changing a CHECK has
-- no in-place form.
ALTER TABLE pool_events DROP CONSTRAINT IF EXISTS pool_events_kind_check;
ALTER TABLE pool_events ADD CONSTRAINT pool_events_kind_check
    CHECK (kind IN ('MEMBER_WITHDRAWN', 'MEMBER_REINSTATED', 'BET_VOIDED'));

-- One emoji beside the name on leaderboards.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_emoji VARCHAR(24);

COMMIT;
SQL

echo
echo "After:"
report
echo
echo "Done. Restart the api and worker so they pick up the new columns:"
echo "  docker compose up -d api worker"
