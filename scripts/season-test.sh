#!/usr/bin/env bash
#
# Plays a full season against mock-espn and checks the chain end to end.
#
#   ./scripts/season-test.sh              # 18 NFL weeks, ~6 minutes
#   ./scripts/season-test.sh --weeks 4    # a shorter pass while iterating
#   ./scripts/season-test.sh --keep       # leave the stack up to poke at
#
# scripts/smoke-test.mjs proves each rule against a single fabricated week.
# This proves they hold together across a whole season: lines posted, bets
# placed and locked at kickoff, scores ingested, wagers graded, payouts
# written, stipends granted, members bust, survivors eliminated, and a
# leaderboard that still reconciles to the ledger at the end.
#
# It runs in its own compose project on its own ports, so it neither sees nor
# disturbs the stack you are working in. The database is created and destroyed
# with the run.

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=lp-season
WEEKS=""
WEEK_SECONDS="${MOCK_WEEK_SECONDS:-20}"
LEAGUE="${SEASON_TEST_LEAGUE:-NFL}"
KEEP=false

while [ $# -gt 0 ]; do
  case "$1" in
    --weeks) WEEKS="$2"; shift 2 ;;
    --week-seconds) WEEK_SECONDS="$2"; shift 2 ;;
    --league) LEAGUE="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Ports of its own, so a season test and your working stack can run at once.
export WEB_PORT=8199 API_PORT=4199 POSTGRES_PORT=5599 REDIS_PORT=6499
export REDIS_UI_PORT=5699 MOCK_ESPN_PORT=3111

# The mock is the whole point: the app must not reach the real ESPN, and the
# ingester must not be handed a SharpAPI key that would overwrite the lines the
# season's scores are derived from.
export ESPN_BASE=http://mock-espn:3001/apis/site/v2/sports
export MOCK_WEEK_SECONDS="$WEEK_SECONDS"

# Enough lead for the harness to register its cast, create four pools, walk the
# season in, and get week 1's bets down before anything kicks off. The mock's
# own default is one week, which at a 20-second week is not close.
export MOCK_LEAD_SECONDS="${MOCK_LEAD_SECONDS:-$(( WEEK_SECONDS * 2 > 45 ? WEEK_SECONDS * 2 : 45 ))}"
export INGEST_LEAGUES="$LEAGUE"
export SHARP_API_KEY=""

# The harness drives ingestion and settlement itself, one week at a time, so it
# knows exactly what has been graded before it checks. A worker ticking on its
# own schedule would settle somewhere in the middle of an assertion.
export INGEST_ENABLED=false
export SETTLEMENT_CRON="0 0 31 2 *"
export INGEST_CRON="0 0 31 2 *"
export ODDS_CRON="0 0 31 2 *"

compose() { docker compose -p "$PROJECT" --profile mock "$@"; }

cleanup() {
  local code=$?
  if [ "$KEEP" = true ]; then
    echo
    echo "Stack left up (--keep):"
    echo "  api    http://localhost:${API_PORT}/api"
    echo "  mock   http://localhost:${MOCK_ESPN_PORT}/status"
    echo "  psql   docker compose -p ${PROJECT} exec db psql -U leaguepicks -d leaguepicks"
    echo "  down   docker compose -p ${PROJECT} --profile mock down -v"
  else
    echo
    echo "Tearing down..."
    compose down -v >/dev/null 2>&1 || true
  fi
  exit $code
}
trap cleanup EXIT INT TERM

echo "Standing up an isolated stack on :${API_PORT} (mock on :${MOCK_ESPN_PORT})..."
# -v on the way in as well as out: the season is keyed to the mock's boot time,
# so a database carried over from a previous run holds a different one.
compose down -v >/dev/null 2>&1 || true
compose up -d --build db redis mock-espn api worker >/dev/null

printf 'Waiting for the API'
for _ in $(seq 1 60); do
  if curl -sf "localhost:${API_PORT}/api/health" >/dev/null 2>&1; then break; fi
  printf '.'; sleep 2
done
echo
curl -sf "localhost:${API_PORT}/api/health" >/dev/null 2>&1 || {
  echo "API never came up:" >&2
  compose logs --tail 40 api >&2
  exit 1
}

curl -sf "localhost:${MOCK_ESPN_PORT}/status" >/dev/null 2>&1 || {
  echo "mock-espn never came up:" >&2
  compose logs --tail 40 mock-espn >&2
  exit 1
}

# The mock anchors its season to its own boot: week 1 kicks off MOCK_LEAD_SECONDS
# after the container starts. Building images and waiting for Postgres eats that
# lead, so by the time the harness could place a bet the opening slate is
# already under way — and week 1 is the one week nothing can bet into late.
#
# Restarting the mock re-anchors it, because it holds no state: every response
# is computed from the wall clock against a season start fixed at boot. So it is
# restarted here, once everything else is already up, and the full lead is the
# harness's to use.
compose restart mock-espn >/dev/null
for _ in $(seq 1 30); do
  curl -sf "localhost:${MOCK_ESPN_PORT}/status" >/dev/null 2>&1 && break
  sleep 1
done

lead=$(curl -s "localhost:${MOCK_ESPN_PORT}/status" \
  | sed -n 's/.*"seconds_until_first_kickoff": *\([0-9]*\).*/\1/p')
echo "Season starts in ${lead:-0}s — a week lasts ${WEEK_SECONDS}s."

export API_BASE="http://localhost:${API_PORT}/api"
export MOCK_BASE="http://localhost:${MOCK_ESPN_PORT}"
export SEASON_TEST_PSQL="docker compose -p ${PROJECT} exec -T db psql -U leaguepicks -d leaguepicks"
export SEASON_TEST_LEAGUE="$LEAGUE"
[ -n "$WEEKS" ] && export SEASON_TEST_WEEKS="$WEEKS"

node scripts/season-test.mjs
