# syntax=docker/dockerfile:1
# Orca Web в контейнере за внешним reverse proxy. Контекст сборки — корень репозитория:
#   docker build -f apps/web/docker/Dockerfile -t orca-web .
# Порядок запуска и настройки proxy — docs/web-docker.md.

FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile --ignore-scripts --filter '@orca-board/web...' \
  && pnpm --filter @orca-board/web build
# Как bundle-linux.mjs: production зависимости рядом с dist и native PTY из исходников.
WORKDIR /src/apps/web/dist
RUN rm -f build-meta.json \
  && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm rebuild node-pty --build-from-source \
  && node --input-type=module -e "await import('node-pty'); process.stdout.write('native PTY: OK\n')"

FROM node:24-bookworm-slim
# CLI-агенты по умолчанию; пустое значение собирает образ без них.
ARG ORCA_AGENTS="@anthropic-ai/claude-code @openai/codex"
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client nginx tini procps less ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default \
  && usermod -l orca -d /home/orca -m node && groupmod -n orca node \
  && install -d -o orca -g orca /projects \
  && if [ -n "$ORCA_AGENTS" ]; then npm install -g --no-audit --no-fund $ORCA_AGENTS && npm cache clean --force; fi
COPY --from=build /src/apps/web/dist /opt/orca-web/app
COPY apps/web/docker/nginx.conf /etc/orca-web/nginx.conf
COPY --chmod=755 apps/web/docker/entrypoint.sh /usr/local/bin/orca-web-entrypoint
RUN printf '#!/bin/sh\nexec node /opt/orca-web/app/control.mjs "$@"\n' > /usr/local/bin/orca-web \
  && chmod 755 /usr/local/bin/orca-web

USER orca
WORKDIR /home/orca
ENV HOME=/home/orca \
    ORCA_WEB_CONFIG=/home/orca/.config/orca-web/config.json \
    ORCA_PROJECT_ROOTS=/projects
# HOME хранит config, аккаунты, профиль доски, Git identity и входы CLI-агентов.
VOLUME ["/home/orca"]
# 8080 — панель, 8081 — preview. Публикуйте их только для reverse proxy.
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS -o /dev/null -H "Host: ${ORCA_ORIGIN#https://}" -H 'X-Forwarded-Proto: https' http://127.0.0.1:3737/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orca-web-entrypoint"]
