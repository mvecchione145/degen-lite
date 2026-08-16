#!/usr/bin/env bash
#
# Change a member's password.
#
#   ./scripts/change-password.sh alice
#
# Prompts twice, without echoing, and only writes if the two match. There is
# deliberately no flag to pass the password on the command line: it would land
# in shell history and in the process list, where anyone on the box can read it.
#
# Hashing is done by the API's own hashPassword(), inside the api container,
# with the password arriving on stdin. That keeps this correct by construction
# if the algorithm or cost ever changes, and means the plaintext never reaches
# the database, its logs, or any command line — only the resulting hash does.

set -euo pipefail

cd "$(dirname "$0")/.."

# Matches registerSchema in api/src/routes/auth.js. Changing a password should
# not be a way around the rule that applies when setting one.
MIN_LENGTH=8

# shellcheck source=scripts/lib/db.sh
. "$(dirname "$0")/lib/db.sh"

case "${1:-}" in
  ''|-h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  -*) echo "unknown option: $1" >&2; exit 2 ;;
esac

USERNAME="$1"

if [ $# -gt 1 ]; then
  echo "Only a username is accepted. The password is asked for, never passed." >&2
  exit 2
fi

require_db

# Usernames are unique and case-sensitive. Checked before prompting so a typo
# costs one line rather than two password entries.
ESCAPED_USERNAME=${USERNAME//\'/\'\'}
if [ -z "$(psql_run -t -A -c "SELECT 1 FROM users WHERE username = '$ESCAPED_USERNAME';")" ]; then
  echo "No account with the username '$USERNAME'." >&2
  echo "Usernames are case-sensitive. Current accounts:" >&2
  psql_run -t -A -c "SELECT username FROM users ORDER BY username;" | sed 's/^/  /' >&2
  exit 1
fi

if [ ! -t 0 ]; then
  echo "Refusing to read a password from a pipe — run this from a terminal." >&2
  exit 1
fi

printf 'New password for %s: ' "$USERNAME" >&2
read -r -s PASSWORD
echo >&2
printf 'Again to confirm: ' >&2
read -r -s CONFIRM
echo >&2

if [ "$PASSWORD" != "$CONFIRM" ]; then
  echo "Those do not match. Nothing was changed." >&2
  exit 1
fi
if [ "${#PASSWORD}" -lt "$MIN_LENGTH" ]; then
  echo "Too short — $MIN_LENGTH characters minimum. Nothing was changed." >&2
  exit 1
fi

# Hashed by the application itself rather than reimplemented here. The
# password goes in on stdin; the only thing on a command line is the tiny
# script below, which contains no secret.
if ! docker compose ps --status running --services 2>/dev/null | grep -qx api; then
  echo "The api container is not running — it is what hashes the password." >&2
  exit 1
fi

HASH=$(printf '%s' "$PASSWORD" | docker compose exec -T api node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    const { hashPassword } = await import("./src/auth.js");
    process.stdout.write(await hashPassword(input));
  });
')

unset PASSWORD CONFIRM

# Refuse to write anything that is not a bcrypt hash — an empty or truncated
# value here would otherwise lock the account out silently.
case "$HASH" in
  \$2[aby]\$*) ;;
  *) echo "Hashing failed; nothing was changed." >&2; exit 1 ;;
esac

# The hash is safe to interpolate: bcrypt output is [./A-Za-z0-9$] only, with
# no quotes to escape.
psql_run -q <<SQL
UPDATE users
   SET password_hash = '$HASH',
       -- Ends every session the account already has. A password change that
       -- left a stolen token working would not be much of a change.
       token_version = token_version + 1
 WHERE username = '$ESCAPED_USERNAME';
SQL

echo "Password changed for $USERNAME."
echo "Every session that account had is now signed out."
