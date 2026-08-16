#!/usr/bin/env bash
#
# Remove the Postgres volume. Stops there — bringing the stack back up is a
# separate decision, and separate command.
#
#   ./scripts/reset-db.sh              # prompt first, then remove
#   ./scripts/reset-db.sh -y           # no prompt
#   ./scripts/reset-db.sh --all        # also drop the Redis cache and RedisInsight
#
# Why a volume wipe rather than a TRUNCATE: Postgres runs the SQL in
# db/init/ exactly once, when the data directory is empty. Editing the schema
# or the seed does nothing to a database that already exists, so re-seeding
# means starting from no volume at all.
#
# Redis is kept by default. It holds cached odds pages, and on SharpAPI's
# 12 requests/minute free tier throwing them away means re-spending rate limit
# on lines we already had. Pass --all when the cache itself is the problem.
#
# The containers have to stop before a volume they mount can be removed, so
# this does take the stack down. It does not bring it back: which compose
# files and which secrets belong in the next `up` differ between a laptop and
# a server, and guessing wrong there is how a stack comes back up with
# development defaults.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/db.sh
. "$(dirname "$0")/lib/db.sh"

ASSUME_YES=false
WIPE_ALL=false

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=true ;;
    --all) WIPE_ALL=true ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# The project name decides the volume names. It comes from `name:` in
# docker-compose.yml, and falls back to the directory name the way compose
# itself does.
PROJECT="${COMPOSE_PROJECT_NAME:-$(awk '$1=="name:"{print $2; exit}' docker-compose.yml)}"
PROJECT="${PROJECT:-$(basename "$PWD")}"

volume_for() { # volume-key -> full volume name, empty if it does not exist
  docker volume ls -q \
    -f "label=com.docker.compose.project=$PROJECT" \
    -f "label=com.docker.compose.volume=$1"
}

TARGETS=(pgdata)
# Not `$WIPE_ALL && TARGETS+=(...)`: under `set -e` that whole line is the
# command, so a false flag would exit the script instead of skipping the append.
if $WIPE_ALL; then TARGETS+=(redisdata redisinsight); fi

# Show what is about to be lost. A reset is cheap to run and impossible to
# undo, so the contents go on screen before the prompt rather than after.
if db_is_running; then
  echo "Current database contents:"
  psql_run -t -A -F' | ' -c "
    SELECT 'users', COUNT(*)::TEXT FROM users
    UNION ALL SELECT 'pools', COUNT(*)::TEXT FROM pools
    UNION ALL SELECT 'bets', COUNT(*)::TEXT FROM bets
    UNION ALL SELECT 'games', COUNT(*)::TEXT FROM games;" 2>/dev/null \
    | sed 's/^/  /' || echo "  (could not read — continuing)"

  POOLS=$(psql_run -t -A -c "SELECT string_agg(name, ', ' ORDER BY created_at) FROM pools;" 2>/dev/null || true)
  [ -n "${POOLS:-}" ] && echo "  pools: $POOLS"
else
  echo "Database container is not running — resetting from whatever the volume holds."
fi

echo
echo "This will delete these volumes and everything in them:"
for key in "${TARGETS[@]}"; do
  name=$(volume_for "$key")
  echo "  - ${name:-${PROJECT}_${key} (not created yet)}"
done
$WIPE_ALL || echo "  (Redis cache kept — pass --all to drop it too)"
echo

if ! $ASSUME_YES; then
  if [ ! -t 0 ]; then
    echo "Refusing to reset without a terminal to confirm at. Pass -y to proceed." >&2
    exit 1
  fi
  printf 'Type the project name (%s) to confirm: ' "$PROJECT"
  read -r reply
  if [ "$reply" != "$PROJECT" ]; then
    echo "Aborted, nothing was deleted."
    exit 1
  fi
fi

echo "==> stopping the stack"
docker compose down --remove-orphans

echo "==> removing volumes"
for key in "${TARGETS[@]}"; do
  name=$(volume_for "$key")
  if [ -n "$name" ]; then
    docker volume rm "$name" >/dev/null && echo "  removed $name"
  else
    echo "  $key not present, skipping"
  fi
done

echo
echo "Done. The volume is gone and the stack is down; nothing has been recreated."
echo "The schema and seed in db/init/ run on the next start, against the empty volume."
echo
echo "Bring it back with whichever is right for this host:"
echo "  ./scripts/compose.sh up -d                                        # local, secrets from 1Password"
echo "  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d   # server"
