#!/usr/bin/env bash
#
# Deploy on the server. Pulls, rebuilds, restarts, and then checks that the
# production overlay actually took effect.
#
#   ./scripts/prod-deploy.sh              # pull, build, up, verify
#   ./scripts/prod-deploy.sh --no-pull    # deploy the working tree as it is
#   ./scripts/prod-deploy.sh --logs       # follow the worker afterwards
#
# Both compose files, every time. That is the whole point of having this: a
# plain `docker compose up` on this host republishes Postgres, Redis and
# RedisInsight on 0.0.0.0 and turns DEV_TOOLS back on, which mounts /api/admin
# behind nothing but a valid login. See docs/deploy-ec2.md.
#
# Not for a laptop — use scripts/compose.sh there, which resolves secrets from
# 1Password rather than reading them from .env.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/build-stamp.sh
. "$(dirname "$0")/lib/build-stamp.sh"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
PULL=true
FOLLOW=false

while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=false ;;
    --logs) FOLLOW=true ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- preflight

if [ ! -f .env ]; then
  cat >&2 <<'EOF'
No .env in this directory. The overlay requires these three and refuses to
start without them, rather than falling back to development defaults:

  cat > .env <<VARS
  SITE_ADDRESS=:80          # or the domain, once DNS points here
  JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=\n')
  VARS
  chmod 600 .env
EOF
  exit 1
fi

MISSING=()
for var in SITE_ADDRESS JWT_SECRET POSTGRES_PASSWORD; do
  grep -qE "^${var}=.+" .env || MISSING+=("$var")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "These are missing or empty in .env: ${MISSING[*]}" >&2
  exit 1
fi

# A world-readable .env is a JWT secret and a database password on disk.
PERMS=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)
if [ "$PERMS" != "600" ]; then
  echo "warning: .env is mode $PERMS — it holds the JWT secret. chmod 600 .env" >&2
fi

# ------------------------------------------------------------------- deploy

if $PULL; then
  echo "==> pulling"
  BEFORE=$(git rev-parse HEAD)
  git pull --ff-only
  AFTER=$(git rev-parse HEAD)

  if [ "$BEFORE" = "$AFTER" ]; then
    echo "  already up to date ($(git rev-parse --short HEAD))"
  else
    echo "  $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER")"

    # db/init/*.sql runs only against an empty data directory, so a schema
    # change that arrives in a pull does *not* apply to this database. Silence
    # here would mean the app quietly running against the old shape.
    if ! git diff --quiet "$BEFORE" "$AFTER" -- db/init/; then
      echo
      echo "  !! db/init/ changed in this pull:"
      git diff --name-only "$BEFORE" "$AFTER" -- db/init/ | sed 's/^/     /'
      echo "     Those scripts only run against an empty volume, so this database"
      echo "     will NOT pick the change up. Apply it by hand with ALTER TABLE,"
      echo "     or wipe and re-seed (scripts/reset-db.sh) if the data is expendable."
      echo
    fi
  fi
fi

# Deliberately after the pull: resolved before it, the footer would name the
# commit this host was on *previously* and every deploy would ship a stamp one
# release behind.
resolve_build_stamp
if [ -n "${GIT_COMMIT:-}" ]; then
  echo "==> stamping build ${GIT_COMMIT}"
  case "$GIT_COMMIT" in
    *-dirty)
      echo "  !! the working tree has uncommitted changes." >&2
      echo "     This deploy is not reproducible from the remote, and the footer" >&2
      echo "     will say so. Commit or stash before deploying." >&2
      ;;
  esac
else
  echo "==> not a git checkout — the footer will read 'build unknown'"
fi

echo "==> building and starting"
"${COMPOSE[@]}" up -d --build --remove-orphans

echo "==> waiting for the API"
for _ in $(seq 1 60); do
  STATUS=$("${COMPOSE[@]}" ps api --format '{{.Status}}' 2>/dev/null || true)
  case "$STATUS" in *healthy*) break ;; esac
  sleep 2
done

case "${STATUS:-}" in
  *healthy*) echo "  api is healthy" ;;
  *)
    echo "  api did not become healthy. Recent logs:" >&2
    "${COMPOSE[@]}" logs --tail 40 api >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------- verifying
#
# The deploy is not finished because containers started. These are the two
# ways this host can come up dangerously, so they are asserted rather than
# assumed.

echo "==> verifying the overlay took effect"

PUBLISHED=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Ports}}' \
  | grep -E '0\.0\.0\.0|\[::\]' | grep -v '^caddy ' || true)
if [ -n "$PUBLISHED" ]; then
  echo "  !! services other than caddy are published externally:" >&2
  echo "$PUBLISHED" | sed 's/^/     /' >&2
  echo "     The overlay was not applied. Check both -f flags." >&2
  exit 1
fi
echo "  only caddy publishes ports"

ADMIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer none' http://localhost/api/admin/settle -X POST || echo 000)
if [ "$ADMIN_CODE" = "404" ]; then
  echo "  /api/admin is not mounted (DEV_TOOLS is off)"
else
  echo "  !! /api/admin answered $ADMIN_CODE, expected 404." >&2
  echo "     DEV_TOOLS is on: any logged-in user can fabricate scores and force" >&2
  echo "     settlement. Set DEV_TOOLS=false and redeploy." >&2
  exit 1
fi

# The build arg is easy to lose: a stale image, a cached layer, or a compose
# file edited so the args no longer reach the web service all produce a footer
# reading "build unknown" while everything else looks fine. Assert the bundle
# actually being served names this commit.
if [ -n "${GIT_COMMIT:-}" ]; then
  SERVED=$(curl -s http://localhost/build-info.js || true)
  case "$SERVED" in
    *"$GIT_COMMIT"*) echo "  the footer names ${GIT_COMMIT}" ;;
    *)
      echo "  !! the served build stamp does not match this checkout." >&2
      echo "     expected: $GIT_COMMIT" >&2
      echo "     served:   ${SERVED:-<nothing>}" >&2
      echo "     The web image was not rebuilt with the build args. Try again" >&2
      echo "     with --no-cache on the web service." >&2
      exit 1
      ;;
  esac
fi

echo
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

if $FOLLOW; then
  echo
  "${COMPOSE[@]}" logs -f worker
fi
