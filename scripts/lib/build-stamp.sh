# Resolves the build stamp shown in the app footer. Sourced, not run.
#
# The web container has no .git of its own and compose cannot shell out, so the
# commit has to be resolved on the host and passed to `docker build` as an
# argument. web/Dockerfile writes it into build-info.js.
#
# Both scripts/compose.sh and scripts/prod-deploy.sh source this, so a laptop
# and a server stamp images the same way. Call it *after* any git pull, or the
# stamp names the commit you were on before the deploy.

# Exports GIT_COMMIT and GIT_REPO_URL. Silently exports nothing outside a git
# checkout — the footer then reads "build unknown", which is the truth.
resolve_build_stamp() {
  git rev-parse --git-dir >/dev/null 2>&1 || return 0

  GIT_COMMIT="$(git rev-parse HEAD)"

  # A stamp that does not describe what is actually running is worse than no
  # stamp. On a server this should never fire; if it does, someone edited files
  # in place and the deploy is not reproducible from the remote.
  if ! git diff --quiet HEAD 2>/dev/null; then
    GIT_COMMIT="${GIT_COMMIT}-dirty"
  fi

  # Normalise the remote into something a browser can open: SSH remotes
  # (git@host:owner/repo.git) are not clickable, and the .git suffix 404s.
  local remote
  remote="$(git remote get-url origin 2>/dev/null || true)"
  remote="${remote%.git}"
  case "$remote" in
    git@*) remote="https://${remote#git@}"; remote="${remote/://}" ;;
    ssh://git@*) remote="https://${remote#ssh://git@}" ;;
  esac
  GIT_REPO_URL="$remote"

  export GIT_COMMIT GIT_REPO_URL
}
