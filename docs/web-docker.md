# Orca Web в Docker за reverse proxy

Образ собирает Web из исходников этого репозитория и запускает его в режиме `proxy`
за вашим reverse proxy (Caddy, Nginx, Traefik и т. п.) на своём домене. Модель доступа
та же, что у [обычной установки Web](web.md): один-два доверенных оператора, агенты
работают с правами пользователя контейнера `orca` (uid 1000).
Это сборка из исходников, а не официальный выпуск `web/vX.Y.Z`; обновление — пересборка образа.

## Как устроено

Orca слушает только `127.0.0.1:3737` (панель) и `127.0.0.1:3738` (preview) и в режиме
`proxy` принимает запросы лишь с loopback. Поэтому внутри контейнера работает nginx:
он публикует порты `8080` (панель) и `8081` (preview), передаёт `Host` и
`X-Forwarded-Proto` от внешнего proxy без изменений и удаляет cookies у preview.
Проверки hostname, HTTPS, Origin и CSRF по-прежнему выполняет сама Orca.

Файлы в `apps/web/docker/`:

| Файл | Назначение |
| --- | --- |
| `Dockerfile` | сборка Web и native PTY, рабочий образ с Git, nginx и CLI-агентами |
| `entrypoint.sh` | config.json из переменных окружения, первый оператор, запуск nginx и Orca |
| `nginx.conf` | внутренний proxy контейнера |
| `compose.yaml`, `.env.example` | готовый запуск через Docker Compose |

## Запуск

Нужны два разных hostname с DNS на сервер с reverse proxy, например `orca.example.com`
для панели и `orca-preview.example.com` для HTML preview.

```sh
cd apps/web/docker
cp .env.example .env   # заполните адреса, логин и пароль первого оператора
docker compose up -d --build
docker compose logs -f
```

| Переменная | Значение |
| --- | --- |
| `ORCA_ORIGIN` | публичный HTTPS адрес панели |
| `ORCA_PREVIEW_ORIGIN` | публичный HTTPS адрес preview на другом hostname |
| `ORCA_ADMIN_LOGIN`, `ORCA_ADMIN_PASSWORD` | первый оператор; нужны только при первом запуске, пароль от 12 символов |
| `ORCA_PROJECTS_DIR` | каталог проектов на хосте, монтируется в `/projects` |
| `ORCA_BIND`, `ORCA_PANEL_PORT`, `ORCA_PREVIEW_PORT` | адрес и порты на хосте для reverse proxy |
| `ORCA_PROJECT_ROOTS` | каталоги проектов внутри контейнера через `:`, по умолчанию `/projects` |

Config пересоздаётся при каждом запуске из переменных окружения. Аккаунты, профиль доски,
Git identity и входы CLI-агентов хранятся в томе `orca-home` (`/home/orca`) и переживают
пересборку образа. Чтобы подключить несколько каталогов, смонтируйте их в `/projects/<имя>`
через `compose.override.yaml`.

## Reverse proxy

Proxy завершает TLS, сохраняет `Host` и обязательно передаёт `X-Forwarded-Proto: https`,
иначе Orca отвечает 403. Long polling требует таймаута чтения не меньше 5 минут.

Caddy:

```caddyfile
orca.example.com {
  reverse_proxy 127.0.0.1:8080
}
orca-preview.example.com {
  reverse_proxy 127.0.0.1:8081
}
```

Nginx:

```nginx
server {
  listen 443 ssl;
  server_name orca.example.com;
  # ssl_certificate ...
  client_max_body_size 32m;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 300s;
  }
}
# Для orca-preview.example.com — тот же блок с портом 8081.
```

Если proxy работает в другом контейнере, подключите оба к одной Docker-сети и направьте
его на `orca-web:8080` и `orca-web:8081`. Не публикуйте порты 8080/8081 в интернет напрямую.

## Агенты и Git

Образ содержит Claude Code и Codex. Другой набор задаёт build arg `ORCA_AGENTS`
(пустое значение — без агентов). Вход и Git identity настраиваются под пользователем контейнера:

```sh
docker compose exec -it orca-web orca-web doctor
docker compose exec -it orca-web claude          # вход в Claude Code
docker compose exec -it orca-web codex login
docker compose exec -it orca-web git config --global user.name "Имя"
docker compose exec -it orca-web git config --global user.email "mail@example.com"
docker compose exec -it orca-web orca-web user add   # второй оператор, затем docker compose restart
```

Каталоги проектов с хоста обычно принадлежат другому uid, поэтому entrypoint добавляет
`safe.directory '*'` в Git config пользователя `orca`. Агенту нужны права на запись в
смонтированные каталоги.

## Обновление

```sh
git pull
docker compose up -d --build
```

Обновление из браузера в контейнере недоступно: панель показывает ручной режим.
Перезапуск отзывает сессии браузера, задания агентов при остановке контейнера завершаются.
