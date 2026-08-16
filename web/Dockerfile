FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html

# The build this image was made from, for the footer. There is no .git inside
# the container, so it has to arrive as a build argument — scripts/compose.sh
# supplies it. Both default to empty, and the footer simply omits the link when
# they are, so a plain `docker compose build` still produces a working image.
ARG GIT_COMMIT=""
ARG GIT_REPO_URL=""
RUN printf 'window.__BUILD__ = { commit: "%s", repoUrl: "%s" };\n' \
      "$GIT_COMMIT" "$GIT_REPO_URL" \
    > /usr/share/nginx/html/build-info.js

EXPOSE 80
