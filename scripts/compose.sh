#!/usr/bin/env bash
#
# docker compose, with secrets resolved from 1Password at run time.
#
#   ./scripts/compose.sh up
#   ./scripts/compose.sh rebuild web     # after editing web/public/*
#   ./scripts/compose.sh rebuild         # everything
#   ./scripts/compose.sh logs -f worker
#   ./scripts/compose.sh down
#
# `up` detaches by default. `rebuild` is shorthand for `up -d --build`, which is
# the command this project actually wants most of the time: the client is baked
# into the web image rather than mounted, so an edit to web/public/ is invisible
# until that image is rebuilt, and a plain restart serves the old bundle while
# reporting success. Every other subcommand is passed through untouched.
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
PREBUILD=()
if [ "${1:-}" = "rebuild" ]; then
  # Not a compose subcommand — translated here. Named rather than spelled out
  # because `up -d --build web` has to be typed exactly right to do anything:
  # the flags belong before the service name, and getting that wrong rebuilds
  # nothing while still reporting that the container started.
  shift

  # --no-cache belongs to `build`, not `up`, so it cannot simply ride along:
  # `up --no-cache` is rejected outright. Split it into a build pass followed
  # by the usual start, rather than hand back an error for a reasonable thing
  # to ask for.
  fresh=false
  rest=()
  for arg in "$@"; do
    if [ "$arg" = "--no-cache" ]; then fresh=true; else rest+=("$arg"); fi
  done

  if [ "$fresh" = true ]; then
    PREBUILD=(build --no-cache ${rest[@]+"${rest[@]}"})
    ARGS=(up -d ${rest[@]+"${rest[@]}"})
  else
    ARGS=(up -d --build ${rest[@]+"${rest[@]}"})
  fi
elif [ "${1:-}" = "up" ]; then
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

# One place decides how compose gets invoked, because `rebuild --no-cache` needs
# two passes and both must go through the same wrapper — a build that missed the
# secrets would bake a different image from the one `up` expects.
#
# Note the ${...[@]+...} guards: expanding an empty array is an unbound variable
# under `set -u` on bash 3.2, which macOS still ships.
WRAPPER=()

if ! command -v op >/dev/null 2>&1; then
  echo "warning: 1Password CLI not found — running without SHARP_API_KEY." >&2
  echo "         Lines will stay synthetic. Install: https://developer.1password.com/docs/cli" >&2
elif ! op account list >/dev/null 2>&1; then
  echo "warning: no 1Password account is signed in — running without SHARP_API_KEY." >&2
  echo "         Sign in with: eval \$(op signin)" >&2
else
  # op run conceals secret values in the child process's output by default.
  WRAPPER=(op run --env-file=.env.op --)
fi

if [ ${#PREBUILD[@]} -gt 0 ]; then
  ${WRAPPER[@]+"${WRAPPER[@]}"} docker compose "${PREBUILD[@]}"
fi

exec ${WRAPPER[@]+"${WRAPPER[@]}"} docker compose ${ARGS[@]+"${ARGS[@]}"}
