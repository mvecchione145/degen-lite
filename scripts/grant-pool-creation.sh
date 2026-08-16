#!/usr/bin/env bash
#
# Grant or revoke a member's permission to create pools.
#
#   ./scripts/grant-pool-creation.sh alice            # grant
#   ./scripts/grant-pool-creation.sh alice --revoke   # revoke
#   ./scripts/grant-pool-creation.sh --list           # who has it
#
# Creating a pool is off by default (users.can_create_pools). Anyone can
# register and join with an invite code; opening a new pool is granted here.
#
# Revoking stops new pools and nothing else — pools the member already runs
# keep running, and they keep their commissioner rights over them.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/db.sh
. "$(dirname "$0")/lib/db.sh"

usage() {
  sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
}

require_db

REVOKE=false
USERNAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --revoke) REVOKE=true ;;
    --list)
      echo "Accounts that can create pools:"
      psql_run -t -A -F' | ' -c \
        "SELECT username, email FROM users WHERE can_create_pools ORDER BY username;" \
        | sed 's/^/  /'
      exit 0
      ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)
      if [ -n "$USERNAME" ]; then
        echo "Only one username at a time." >&2
        exit 2
      fi
      USERNAME="$1"
      ;;
  esac
  shift
done

if [ -z "$USERNAME" ]; then
  usage
  exit 2
fi

# Usernames are unique and case-sensitive in the schema, so this matches
# exactly — no ILIKE, which could hit the wrong account.
#
# Checked separately from the UPDATE because `UPDATE ... WHERE username =
# 'alcie'` succeeds and changes nothing: a typo would otherwise look like a
# successful grant.
EXISTS=$(psql_run -t -A -c \
  "SELECT 1 FROM users WHERE username = '${USERNAME//\'/\'\'}';")

if [ -z "$EXISTS" ]; then
  echo "No account with the username '$USERNAME'." >&2
  echo "Usernames are case-sensitive. Current accounts:" >&2
  psql_run -t -A -c "SELECT username FROM users ORDER BY username;" | sed 's/^/  /' >&2
  exit 1
fi

VALUE=$([ "$REVOKE" = true ] && echo FALSE || echo TRUE)

# Idempotent: re-running is a no-op that still reports the resulting state.
psql_run -t -A -F' | ' -c \
  "UPDATE users SET can_create_pools = $VALUE WHERE username = '${USERNAME//\'/\'\'}'
   RETURNING username, can_create_pools;" | sed 's/^/  /'

if [ "$REVOKE" = true ]; then
  echo "Revoked. $USERNAME can still join pools with an invite code, and keeps"
  echo "any pool they already run."
else
  echo "Granted. $USERNAME can create pools from the pools page."
fi
