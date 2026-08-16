# Shared psql plumbing. Sourced, not run.
#
# The credentials are resolved *inside* the container, from the environment
# compose already gave it, rather than guessed out here. Every other approach
# has a way to be wrong:
#
#   a hardcoded default   fails wherever POSTGRES_USER is not "leaguepicks",
#                         which is any server with a real .env
#   the caller's shell    `sudo` drops the environment, so an exported value
#                         does not survive the one command most likely to
#                         need it
#   reading .env here     works, until a value is quoted, spaced, or set
#                         somewhere else entirely
#
# The container is the one place that cannot disagree with the database it is
# running, so ask it.

# Non-interactive: SQL comes from arguments or stdin, output comes back.
psql_run() {
  docker compose exec -T db sh -c \
    'exec psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -v ON_ERROR_STOP=1 "$@"' \
    psql "$@"
}

# Interactive: keeps the TTY so psql behaves like a shell.
psql_interactive() {
  docker compose exec db sh -c \
    'exec psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" "$@"' \
    psql "$@"
}

db_is_running() {
  docker compose ps --status running --services 2>/dev/null | grep -qx db
}

require_db() {
  if ! db_is_running; then
    echo "The db container is not running. Start the stack first:" >&2
    echo "  ./scripts/compose.sh up -d                                              # local" >&2
    echo "  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d   # server" >&2
    exit 1
  fi
}
