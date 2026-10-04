# Orca Web на своём сервере

Web использует общий runtime и тот же React-интерфейс, что Desktop. Проекты, Git,
worktrees и CLI-агенты находятся на сервере; браузер управляет ими через authenticated
HTTP API. Один сервер предназначен для одного или двух доверенных операторов.
Это не многопользовательский SaaS: оба оператора имеют доступ ко всем проектам,
агенты работают с Unix-правами пользователя сервиса.

## Готовая установка

Первый поддерживаемый сервер — Linux x64, Ubuntu 24.04. Нужны обычный Unix-пользователь,
Git, curl, tar, sha256sum и Python 3; sudo нужен для systemd и HTTPS. Node 24 и собранный native PTY
включены в архив. Исходники, pnpm и компилятор на сервере не нужны.

Первый пакет — [Orca Web 2.0.0](https://github.com/NANDIorg/BigOrcaCocks/releases/tag/web/v2.0.0):
`install-orca-web.sh`, `orca-web-linux-x64-2.0.0.tar.gz` и `SHA256SUMS`.
Web выпускается отдельно под тегами `web/vX.Y.Z`; Desktop 2.0.0 не переупаковывается.
Установщик не меняет существующую установку.

Скачайте установщик из Web-выпуска и запустите:

```sh
curl -fL https://github.com/NANDIorg/BigOrcaCocks/releases/download/web%2Fv2.0.0/install-orca-web.sh -o install-orca-web.sh
bash install-orca-web.sh
```

Установщик выбирает последний стабильный `web/vX.Y.Z` (максимальная версия среди 100 последних выпусков репозитория), проверяет SHA256,
разворачивает готовый пакет и открывает мастер. Для конкретного выпуска задайте
`ORCA_WEB_VERSION=X.Y.Z`. Мастер спрашивает папку проектов, основной домен, отдельный
домен preview, логин и пароль. Пустой домен включает локальный HTTP. Пароль вводится
скрыто, минимум 12 символов; сервер сохраняет только scrypt hash. При ошибке мастера
повторите `orca-web setup`, повторно скачивать пакет не требуется.

Пути по умолчанию:

| Содержимое | Путь |
| --- | --- |
| Версии, bundled Node и native modules | `~/.local/share/orca-web/releases/X.Y.Z` |
| Активная версия | `~/.local/share/orca-web/current` |
| Launcher | `~/.local/share/orca-web/bin/orca-web`, ссылка `~/.local/bin/orca-web` |
| Конфигурация и аккаунты | `~/.config/orca-web/config.json`, `accounts.json` |
| Общий профиль | `~/.orca-board/profiles/default` |
| Шаблоны сервиса и HTTPS | каталог конфигурации |

Если команда не найдена, добавьте `~/.local/bin` в PATH. `ORCA_WEB_HOME` выбирает
каталог установки; `ORCA_WEB_CONFIG` — абсолютный путь config.json, который сохраняется
в systemd unit. Не запускайте Web или установщик под root.

## Агенты и Git

Установите выбранные CLI-агенты и войдите в них **под пользователем сервиса**. Его HOME,
PATH, Git identity и credential helpers используются при всех заданиях. Настройте
`git config --global user.name` и `user.email`; доступ к remote проверяйте под тем же
пользователем. Пароли браузерных операторов не заменяют credentials CLI-агентов.

```sh
orca-web doctor
orca-web start
orca-web status
orca-web user add
```

`doctor` проверяет Node, native PTY, Git и обнаруженные агенты. Добавление второго
аккаунта также требует терминала со скрытым вводом; после добавления перезапустите
сервис. Публичной регистрации, сброса пароля и управления аккаунтами в браузере нет.

## Автозапуск и HTTPS

```sh
orca-web service install
sudo systemctl status orca-web.service
journalctl -u orca-web.service -f
```

Оба HTTP listener привязаны к 127.0.0.1: основная панель по умолчанию 3737, preview 3738.
Для доменов нужен Caddy в `/usr/bin/caddy`, DNS двух разных hostname на сервер и открытые
80/443. Сгенерированные `Caddyfile` и `orca-web-proxy.service` обслуживают HTTPS отдельно
от приложения. Cookies удаляются при проксировании preview. Установка сервиса требует
sudo. Основной сервис и worker работают под обычным пользователем. Установка добавляет
`orca-web-update.service` и sudoers с тремя фиксированными командами systemctl: запустить
worker, остановить и запустить только `orca-web.service`; произвольного root-доступа нет.
Отдельный worker не зависит от жизненного цикла HTTP-панели.

Если Caddy уже обслуживает сайты, добавьте подготовленные site blocks в его текущую
конфигурацию и выполните `orca-web service install-app`. Orca не перехватывает активный
`caddy.service`. Для другого reverse proxy сохраните Host, установите
`X-Forwarded-Proto: https` и направьте два hostname на соответствующие loopback-порты.
Не публикуйте внутренние порты напрямую. В production config требуется `mode: "proxy"`
и HTTPS origins с разными hostname; local mode предназначен для localhost.

## Браузер и безопасность

Вход создаёт in-memory сессию: HttpOnly/SameSite=Strict cookie, Secure в HTTPS,
CSRF token только в памяти вкладки. Есть ограничение попыток входа и числа клиентов.
Перезапуск сервиса отзывает все сессии; после обновления старый JS требует reload.
Язык и выбранный проект принадлежат вкладке, настройки/доски общие.

Выбор проекта разрешён только внутри `projectRoots` из config.json; проверяется
canonical realpath, включая прямые API-вызовы и symlink escape. Это ограничение выбора,
а не sandbox для терминала: доверенный оператор и агент могут работать с файлами,
доступными пользователю сервиса.

Файлы передаются отдельным bounded upload/download API; native «Показать в папке»
заменено скачиванием. HTML preview находится на другом hostname без cookies панели,
с token, sandbox/CSP и исходными path/file guards. Потоки используют long polling,
bounded observer cursor и snapshot recovery. Обрыв связи или закрытие вкладки
не останавливает задания. Ввод в терминал требует явной writer lease; её получает
только один клиент. После восстановления показана доступная часть вывода, полного
архива PTY нет. Остановка сервиса завершает принадлежащие ему процессы.

## Обновление

Desktop и Web используют общий код, но независимые версии и GitHub Releases:
`vX.Y.Z` для Desktop, `web/vX.Y.Z` для Web. Web не становится Desktop Latest. В «Настройки → Обновления» используется общая карточка
Desktop: установленная/доступная версия, описание выпуска, ручная проверка, скачивание
с прогрессом и «Обновить сервер». Собственный Web feed проверяется при старте и раз в шесть часов.
Автоматической установки нет. Перед установкой браузер предупреждает об остановке
агентов и временном отключении всех пользователей. После неё перезагрузите страницу
и войдите снова: старые сессии отозваны.

Для установки кнопкой требуется `orca-web service install` либо `service install-app`:
команда устанавливает основной unit, отдельный oneshot updater и проверенные через
visudo ограниченные sudoers. Перенастройте service install на существующей установке,
если updater ещё не установлен. Queue/status хранятся приватно в `updates/state.json`
каталога установки; атомарный `updates/lock.json` различает CLI/browser ownership и исключает
одновременные обновления. Orphan browser claim после аварии панели восстанавливается.
Установщик сохраняет private transaction до stop; `ExecStopPost` вызывает recovery даже
при SIGKILL/timeout worker через pinned предыдущие Node/control в `recovery`, независимо
от исправности нового пакета. При прерывании возвращается согласованный backup/версия
и запускается панель. Состояние очереди не зависит от profile/config rollback.
Worker скачивает ровно выбранную версию и сверяет SHA256, до подтверждения установки
основной сервис продолжает работать. Сбой завершённого worker показывается как ошибка,
без вечного прогресса. Журнал: `journalctl -u orca-web-update.service`.

Локальный/source host проверяет реальные выпуски, но предлагает терминальную установку.
Команда для сервера остаётся доступна:

```sh
orca-web update
```

Команда выбирает только Linux Web archive из отдельного стабильного выпуска Web, проверяет
checksum и структуру, останавливает только `orca-web.service`, получает exclusive
profile owner, сохраняет профиль и конфигурацию в `backups/web-update`, переключает
`current` и проверяет version/health. При неудаче восстанавливает профиль, конфигурацию
и предыдущую версию. Git-репозитории проектов вне профиля не откатываются. Backup и
предыдущий пакет сохраняются. CLI остаётся отдельной будущей линейкой `cli/vX.Y.Z`.

Перед первым обновлением существующего сервера проверьте его backup и права пользователя.
Не запускайте Desktop/headless и Web одновременно с одним профилем: второй owner
откажется стартовать. HTTPS proxy при обновлении приложения не перезапускается.

## Локальная разработка и проверка поставки

В рабочем worktree с Node 24/pnpm 10.33.0:

```sh
pnpm install --frozen-lockfile
pnpm --filter @orca-board/web build
pnpm --filter @orca-board/web setup
pnpm --filter @orca-board/web start
```

Source host требует node-pty для Node ABI: Desktop install root рассчитан на Electron.
Для автоматической проверки используйте `node scripts/test-web-artifact.mjs`: он
копирует JS/resources вне workspace и Node-native dependency из отдельного `.native`.
Не rebuild node-pty Desktop для Node. Для собственного source запуска можно установить
native dependency в `apps/web/dist` через `npm install --omit=dev` из этого каталога.

Linux CI строит пакет командой `pnpm --filter @orca-board/web bundle:linux` и проверяет
`node scripts/smoke-web-bundle.mjs apps/web/release` под обычным пользователем. Smoke
использует временные профиль/репозиторий, TTY мастер со скрытым вводом, двух операторов, настоящий Git/PTY, проверяет
установщик/checksum, upload/download/preview, duplicate writer, detach, рестарт и
служебные команды. Никаких платных запросов агентам или обхода GUI.

Ручную проверку общего интерфейса, реальные DNS/сертификаты, автозапуск и обновление
на арендованном сервере выполняют после выбора сервера. Первый Web-выпуск публикуется
отдельно через web-release.yml; новый Desktop для этого не требуется. Docker-дистрибутив, ARM64,
публичные аккаунты и человеческий терминальный CLI в этот выпуск не входят.
