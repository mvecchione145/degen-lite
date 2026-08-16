#!/usr/bin/env bash
#
# docker compose, with secrets resolved from 1Password at run time.
#
#   ./scripts/compose.sh up --build
#   ./scripts/compose.sh logs -f worker
#   ./scripts/compose.sh down
#
# `up` detaches by default; every other subcommand is passed through untouched.
#
# Secret references live in .env.op (pointers only, no secret material).
# `op run` resolves them and injects the values into docker compose's
# environment, where compose interpolates them into docker-compose.yml.
#
# Nothing is written to disk and `op run` masks the values in child output.
# Without 1Password available this falls back to plain `docker compose`, so the
# stack still starts — just with synthetic lines instead of live odds.

set -euo pipefail

cd "$(dirname "$0")/.."

# Stamp the build into the web image's footer. Exported rather than passed
# inline so `op run` carries the values through to compose as well.
# shellcheck source=scripts/lib/build-stamp.sh
. "$(dirname "$0")/lib/build-stamp.sh"
resolve_build_stamp

# `up` detaches by default — that is how this stack is always run.
#
# The flag has to be inserted directly after the subcommand, not appended. On
# the end it lands after the service name, where `docker compose up --build web
# -d` is accepted and silently does not rebuild, and where `down` and `logs`
# get a `-d` they reject outright.
#
# Anything the caller passed wins: an explicit -d is not doubled, and the flags
# that mean "stay attached" suppress it rather than conflicting with it.
ARGS=("$@")
if [ "${1:-}" = "up" ]; then
  attached=false
  for arg in "$@"; do
    case "$arg" in
      -d|--detach|--abort-on-container-exit|--attach|--attach-dependencies)
        attached=true ;;
    esac
  done
  if [ "$attached" = false ]; then
    shift
    ARGS=(up -d "$@")
  fi
fi

# Note the ${ARGS[@]+...} guard at each call site: expanding an empty array is
# an unbound variable under `set -u` on bash 3.2, which macOS still ships.

if ! command -v op >/dev/null 2>&1; then
  echo "warning: 1Password CLI not found — running without SHARP_API_KEY." >&2
  echo "         Lines will stay synthetic. Install: https://developer.1password.com/docs/cli" >&2
  exec docker compose ${ARGS[@]+"${ARGS[@]}"}
fi

if ! op account list >/dev/null 2>&1; then
  echo "warning: no 1Password account is signed in — running without SHARP_API_KEY." >&2
  echo "         Sign in with: eval \$(op signin)" >&2
  exec docker compose ${ARGS[@]+"${ARGS[@]}"}
fi

# op run conceals secret values in the child process's output by default.
exec op run --env-file=.env.op -- docker compose ${ARGS[@]+"${ARGS[@]}"}
