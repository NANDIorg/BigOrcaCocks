#!/bin/bash
# Запуск Orca Web в контейнере: config.json из переменных окружения, первый аккаунт,
# внутренний nginx и сервер Orca. Контейнер завершается, если остановился любой из процессов.
set -euo pipefail

fail() { printf 'orca-web: %s\n' "$1" >&2; exit 1; }
[ -n "${ORCA_ORIGIN:-}" ] || fail 'задайте ORCA_ORIGIN, например https://orca.example.com'
[ -n "${ORCA_PREVIEW_ORIGIN:-}" ] || fail 'задайте ORCA_PREVIEW_ORIGIN на отдельном hostname, например https://orca-preview.example.com'

umask 077
config_dir=$(dirname "$ORCA_WEB_CONFIG")
mkdir -p "$config_dir" "$HOME/.orca-board/profiles/default"
chmod 700 "$config_dir"

# Config пересоздаётся при каждом запуске: источник правды — переменные окружения контейнера.
# parseWebConfig проверяет значения при старте сервера.
node --input-type=module <<'EOF'
import { writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
const env = process.env; const file = env.ORCA_WEB_CONFIG
const config = { schemaVersion: 1, configDir: dirname(file), dataDir: join(env.HOME, '.orca-board', 'profiles', 'default'),
  projectRoots: env.ORCA_PROJECT_ROOTS.split(':').filter(Boolean), origin: env.ORCA_ORIGIN.replace(/\/$/, ''),
  port: 3737, mode: 'proxy', previewOrigin: env.ORCA_PREVIEW_ORIGIN.replace(/\/$/, ''), previewPort: 3738 }
writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); renameSync(`${file}.tmp`, file)
EOF

for root in ${ORCA_PROJECT_ROOTS//:/ }; do mkdir -p "$root" 2>/dev/null || true; done
# Каталоги проектов монтируются с хоста и часто принадлежат другому uid.
git config --global --get-all safe.directory | grep -qx '\*' || git config --global --add safe.directory '*'

accounts="$config_dir/accounts.json"
if [ ! -f "$accounts" ]; then
  if [ -n "${ORCA_ADMIN_LOGIN:-}" ] && [ -n "${ORCA_ADMIN_PASSWORD:-}" ]; then
    node --input-type=module -e "const { initializeWebAccount } = await import('/opt/orca-web/app/index.mjs'); await initializeWebAccount({ configDir: process.argv[1], login: process.env.ORCA_ADMIN_LOGIN, password: process.env.ORCA_ADMIN_PASSWORD })" "$config_dir"
    printf 'orca-web: создан первый оператор %s\n' "$ORCA_ADMIN_LOGIN"
  elif [ -t 0 ]; then
    node /opt/orca-web/app/admin.mjs "$config_dir"
  else
    fail 'нет аккаунтов: задайте ORCA_ADMIN_LOGIN и ORCA_ADMIN_PASSWORD (минимум 12 символов) для первого запуска'
  fi
fi

if [ "$#" -gt 0 ]; then exec "$@"; fi

mkdir -p /tmp/nginx
nginx -c /etc/orca-web/nginx.conf -g 'daemon off;' &
proxy=$!
node /opt/orca-web/app/control.mjs start &
app=$!
stopping=0
trap 'stopping=1; kill -TERM "$app" "$proxy" 2>/dev/null || true' TERM INT
status=0
wait -n "$app" "$proxy" || status=$?
kill -TERM "$app" "$proxy" 2>/dev/null || true
wait "$app" 2>/dev/null || true
wait "$proxy" 2>/dev/null || true
# docker stop — штатная остановка, а не сбой.
[ "$stopping" = 1 ] && exit 0
exit "$status"
