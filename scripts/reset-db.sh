#!/usr/bin/env bash
#
# Wipe the Postgres volume and bring the stack back up on a fresh database.
#
#   ./scripts/reset-db.sh              # prompt first, then reset
#   ./scripts/reset-db.sh -y           # no prompt
#   ./scripts/reset-db.sh -y --build   # rebuild images on the way back up
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
# Comes back up through scripts/compose.sh so SHARP_API_KEY is injected from
# 1Password again — a plain `docker compose up` would silently leave the stack
# without live odds.

set -euo pipefail

cd "$(dirname "$0")/.."

ASSUME_YES=false
WIPE_ALL=false
UP_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=true ;;
    --all) WIPE_ALL=true ;;
    --build) UP_ARGS+=(--build) ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
if docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  echo "Current database contents:"
  docker compose exec -T db psql -U "${POSTGRES_USER:-leaguepicks}" -d "${POSTGRES_DB:-leaguepicks}" -t -A -F' | ' -c "
    SELECT 'users', COUNT(*)::TEXT FROM users
    UNION ALL SELECT 'pools', COUNT(*)::TEXT FROM pools
    UNION ALL SELECT 'bets', COUNT(*)::TEXT FROM bets
    UNION ALL SELECT 'games', COUNT(*)::TEXT FROM games;" 2>/dev/null \
    | sed 's/^/  /' || echo "  (could not read — continuing)"

  POOLS=$(docker compose exec -T db psql -U "${POSTGRES_USER:-leaguepicks}" -d "${POSTGRES_DB:-leaguepicks}" \
    -t -A -c "SELECT string_agg(name, ', ' ORDER BY created_at) FROM pools;" 2>/dev/null || true)
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

echo "==> starting the stack"
# macOS ships bash 3.2, where "${UP_ARGS[@]}" on an empty array trips `set -u`.
./scripts/compose.sh up -d ${UP_ARGS[@]+"${UP_ARGS[@]}"}

# The API's healthcheck is the honest signal that the schema and seed landed:
# it does not report healthy until it can serve a request against the database.
echo "==> waiting for the API to come up"
for _ in $(seq 1 60); do
  status=$(docker compose ps api --format '{{.Status}}' 2>/dev/null || true)
  case "$status" in
    *healthy*) break ;;
  esac
  sleep 2
done

case "${status:-}" in
  *healthy*) echo "  api is healthy" ;;
  *) echo "  api did not become healthy in time — check: docker compose logs api" >&2 ;;
esac

echo
echo "Fresh database:"
docker compose exec -T db psql -U "${POSTGRES_USER:-leaguepicks}" -d "${POSTGRES_DB:-leaguepicks}" \
  -t -A -F' | ' -c "SELECT username, email FROM users;" | sed 's/^/  /'

# Games arrive from ESPN on the worker's startup ingest, which takes a moment;
# the count right after boot is usually still climbing.
echo
echo "The worker is pulling the schedule from ESPN now. Follow it with:"
echo "  docker compose logs -f worker"
