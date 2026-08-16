#!/usr/bin/env bash
#
# Add the commissioner-controls tables to an existing database.
#
#   ./scripts/migrate-commissioner-controls.sh          # apply
#   ./scripts/migrate-commissioner-controls.sh --check  # report only
#
# This project ships its schema as db/init/*.sql, which Postgres runs once on
# an empty volume and never again. A database created before commissioner
# controls existed therefore has neither pool_members.withdrawn_at nor the
# pool_events table, and the API will error on every pool read until it does.
#
# A fresh volume needs none of this — scripts/reset-db.sh, or
# `docker compose down -v`, gets the new schema from db/init directly.
#
# Safe to re-run: every statement is IF NOT EXISTS.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/db.sh
. "$(dirname "$0")/lib/db.sh"

usage() {
  sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'
}

CHECK_ONLY=false
case "${1:-}" in
  --check) CHECK_ONLY=true ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) usage >&2; exit 1 ;;
esac

require_db

report() {
  psql_run -tAc "
    SELECT 'pool_members.withdrawn_at: ' || CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pool_members' AND column_name = 'withdrawn_at'
    ) THEN 'present' ELSE 'MISSING' END
    UNION ALL
    SELECT 'pool_events table:         ' || CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'pool_events'
    ) THEN 'present' ELSE 'MISSING' END
    UNION ALL
    SELECT 'reinstate event kind:      ' || CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'pool_events_kind_check'
         AND pg_get_constraintdef(oid) LIKE '%MEMBER_REINSTATED%'
    ) THEN 'present' ELSE 'MISSING' END;"
}

echo "Before:"
report

if [ "$CHECK_ONLY" = true ]; then
  exit 0
fi

psql_run <<'SQL'
BEGIN;

ALTER TABLE pool_members
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS pool_events (
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

CREATE INDEX IF NOT EXISTS pool_events_pool_idx
    ON pool_events (pool_id, created_at DESC);

-- Widen the kind constraint. CREATE TABLE IF NOT EXISTS above is a no-op on a
-- database that ran an earlier version of this script, so the constraint it
-- already has still refuses MEMBER_REINSTATED. Dropping and recreating is the
-- only way to change a CHECK, and is safe to repeat.
ALTER TABLE pool_events DROP CONSTRAINT IF EXISTS pool_events_kind_check;
ALTER TABLE pool_events ADD CONSTRAINT pool_events_kind_check
    CHECK (kind IN ('MEMBER_WITHDRAWN', 'MEMBER_REINSTATED', 'BET_VOIDED'));

COMMIT;
SQL

echo
echo "After:"
report
echo
echo "Done. Restart the api and worker so they pick up the new columns:"
echo "  docker compose up -d api worker"
