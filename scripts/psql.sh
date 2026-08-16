#!/usr/bin/env bash
#
# Open a psql session against the running database.
#
#   ./scripts/psql.sh                          # interactive shell
#   ./scripts/psql.sh -c 'SELECT * FROM pools' # one command, then exit
#   ./scripts/psql.sh -f some-script.sql       # (paths are inside the container)
#
# Any arguments are passed straight through to psql.
#
# No password is needed: this connects over the container's local socket as the
# owner, which the Postgres image trusts. That also means it does not work from
# outside the box — which is the point, the port is bound to loopback there.

set -euo pipefail

cd "$(dirname "$0")/.."

case "${1:-}" in
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# shellcheck source=scripts/lib/db.sh
. "$(dirname "$0")/lib/db.sh"

require_db

# psql needs a terminal to be interactive, but this is also useful in a
# pipeline (`echo 'SELECT 1' | ./scripts/psql.sh`), where docker compose exec
# fails trying to allocate one.
if [ -t 0 ] && [ -t 1 ]; then
  psql_interactive "$@"
else
  psql_run "$@"
fi
