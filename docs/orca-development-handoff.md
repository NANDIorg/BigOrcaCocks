# Orca: точка продолжения после подготовки 2.0.0

> Актуальное состояние 05.10.2026: фундамент и W1–W6 Web реализованы, добавлены
> браузерные обновления/recovery. Выпуски Desktop/Web независимы: vX.Y.Z и web/vX.Y.Z.
> README и docs/web описывают установку. Пользователь принял интерфейс и поручил
> интеграцию/публикацию первого Web 2.0.0. PR #63 слит в develop (955712f);
> Windows junction fix подтверждён CI всех трёх ОС на dff7e6c (run 37222550570).
> Состав выпуска зафиксирован в release/web/2.0.0; notes — docs/releases/web/v2.0.0.md.
> Для этого выпуска пользователь явно разрешил мерж без второго approval после
> зелёного CI; настройки GitHub-защиты не менялись. Далее — release PR в master,
> тег web/v2.0.0 на merge SHA, проверка/публикация пакета latest=false и обратный sync.
> Фактическое состояние публикации — GitHub Release web/v2.0.0 и соответствующие PR.
> Desktop 2.0.0 уже опубликован и не переупаковывается.
> Реальный Linux-сервер/DNS/HTTPS и человеческий CLI остаются следующими задачами.
> Ниже сохранён исходный план после 2.0.0 и журнал фактического продолжения.


Зафиксировано 4 октября 2026 по поручению пользователя. Общий фундамент завершён,
[PR #59](https://github.com/NANDIorg/BigOrcaCocks/pull/59) слит в `develop`, merge commit
`fe94656ac148a9c7f30ef7ae7c9644343cc6b269`. Следующее поручение — Desktop **2.0.0 · Sea Otter**.
Этот документ входит в подготовку выпуска и не утверждает, что черновик уже опубликован.
Фактическое состояние выпуска проверяется по `v2.0.0`, релизному PR и GitHub Release.

После завершения релизной задачи останавливаемся на готовой базе. Продолжение разработки —
**Web для собственного сервера, затем пользовательский терминальный CLI**.
В рамках выпуска 2.0.0 ни Web, ни новый CLI не реализуются.

## Что прочитать следующей сессии

1. [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md), [git-flow.md](git-flow.md).
2. [Карту фактических пакетов и запуск Node host](shared-foundation.md).
3. [Готовность и результаты проверок](orca-foundation-progress.md).
4. [Согласованную архитектуру общего фундамента](superpowers/specs/2026-10-02-orca-shared-foundation-design.md),
   особенно §§8–10 и критерии §12. Это исходная спецификация; выполненные этапы сверять с журналом.
5. [Подробную архитектуру](architecture.md), [workflow](workflow.md),
   [запросы к человеку](human-requests.md), [ассистента](assistant-chat.md), [DESIGN.md](../DESIGN.md).

Исходный проект терминального CLI сохранён в [PR #55](https://github.com/NANDIorg/BigOrcaCocks/pull/55),
ветка `feature/orca-cli-architecture`, исторический commit `1355c1c`:
[handoff](https://github.com/NANDIorg/BigOrcaCocks/blob/1355c1c/docs/superpowers/specs/2026-10-02-orca-cli-handoff.md),
[архитектура](https://github.com/NANDIorg/BigOrcaCocks/blob/1355c1c/docs/superpowers/specs/2026-10-02-orca-cli-design.md),
[план](https://github.com/NANDIorg/BigOrcaCocks/blob/1355c1c/docs/superpowers/plans/2026-10-02-orca-cli.md).
PR #55 отдельно не сливался. Его план отражает базу 1.1.2: переносы runtime/contracts,
которые уже выполнены, повторять не нужно. Обновить план под общий client и Web owner.

## Что уже готово

Все рубежи A–F из журнала готовы, незавершённого этапа извлечения backend нет:

- `packages/core`: домен, store/миграции, события, переходы workflow и промпты.
- `packages/contracts`: browser-safe DTO, commands, errors, protocol/schema/capabilities.
- `packages/runtime`: проекты, настройки, board/global tasks, workers/coordinator,
  workflow/review/requests, Git, файлы/docs/rules/stats, диалоги и PTY lifecycle.
- `packages/client`: общий typed operator client, HTTP/IPC, request identity/retry,
  client selection, snapshot/replay, binary и writer channels.
- `packages/ui`: React/CSS/i18n/assets и presentation helpers; получает client/platform от host.
- `apps/desktop`: использует общие runtime/UI, сохраняет Electron окна/меню/трей/updater/native actions.
- `apps/headless`: самостоятельный установленный Node.js 24 artifact без Electron,
  private loopback operator endpoint, отдельный агентский socket и graceful stop.
- Общий profile owner до backup/migrations; async Git process/queue/effect scopes,
  durable effect journal/reconciliation и ограниченный observer replay.
- Раздельные Node/Electron native roots; product-aware branches/tags/versions/Latest guards.

Существующий `packages/cli/bin/orca-board.js` — совместимый dependency-free клиент агентов.
Он не является новым интерактивным CLI для человека. Desktop root/app version меняется
вместе; в подготовке 2.0.0 версии private shared packages и CLI не выравнивались.
Последующее уточнение: новый Web manifest использует текущую root/Desktop version,
а будущий первый выпуск с Web становится общим с Desktop, как описано ниже.

## На чём остановились и что осталось для Web

Backend не нужно переписывать заново. В общем UI пока есть compatibility API: Desktop
передаёт старый preload через injection, CRUD групп уже использует typed operator client.
**Browser-safe UI не равен готовому Web-приложению:** Web должен реализовать adapter
остальных методов к общим commands и свои platform actions. Headless endpoint сейчас
приватный loopback, а не открытый интернет-сервис.

Порядок следующего проекта:

1. **Сервер и доступ.** Уточнить адрес/провайдера, ОС, домен, SSH/service account,
   persistent data/root paths и механизм входа. Рассчитываем на один сервер,
   один runtime profile owner, одного-двух доверенных операторов.
2. **Web host.** Создать `apps/web` с тем же runtime/headless graph, server session/auth
   и trusted principal/policy. Agent socket и operator ingress сохранять раздельными.
3. **Browser UI adapter.** Подключить общий UI/client; project/dialog selection хранить
   на клиенте, в команды передавать явный context/revision. Не привязывать двух
   операторов к общему legacy activeId. Новые бизнес-правила оставлять в runtime.
4. **Терминалы и события.** Подключить snapshot/replay, reconnect, вывод/backpressure,
   writer lease/sequence/renewal. Закрытие вкладки освобождает её writer/subscriptions,
   а не уничтожает PTY или диалог. Поздний ответ не меняет новую selection/сессию.
5. **Файлы и preview.** Серверный выбор проекта из разрешённых roots, upload/download,
   binary channels вместо base64 в RPC, opaque ids/root/realpath/symlink guards,
   browser actions вместо Finder/Explorer. HTML preview — отдельный origin без cookies
   панели, прежние whitelist/CSP/sandbox/network restrictions сохраняются.
6. **Приватное развёртывание.** HTTPS/reverse proxy, Origin/CSRF и проверки WS,
   лимиты запросов/потоков/загрузок, credentials только на сервере, service manager,
   логи, backup/restore и graceful update/stop. Browser не получает operator credential-файл.
7. **Приёмка и отдельная поставка Web.** Проверить два клиента, stale/duplicate/reconnect,
   PTY lifetime, вопросы/review/workflow, файлы/preview и несовместимую старую вкладку.
   Подготовить Web artifact и job общего Desktop/Web выпуска `vX.Y.Z`; прежнюю
   независимую Web policy заменить до первого выпуска с Web.

Первая версия — внутренняя панель. Регистрация, tenant isolation, биллинг, публичный
multiuser-сервис и масштабирование оставлены на будущее. Общий OS-пользователь не
изолирует двух операторов друг от друга; не обещать такую изоляцию.

## CLI после Web

- Основной будущий entrypoint `orca` — чат в терминале по SSH; commands/slash commands
  дополняют разговор. Terminal UI использует client/contracts и общие диалоговые services.
- Подключаться к существующему owner; запускать свой только при его отсутствии.
  Не заменять Web owner другой версией и не открывать TaskStore короткими командами.
- SSH disconnect/выход интерфейса не останавливает агентов; reconnect восстанавливает
  transcript/status/ожидания. Restart owner и provider resume — разные сценарии:
  сохранённая история не обещает живое продолжение LLM turn.
- Amp/shell сохраняют терминальный режим. Агентский CLI и его HELP/ORCA-контекст совместимы.
- Собранный client/headless/runtime, skills и Node native dependencies входят в поставку;
  npm имя/права публикации, lifecycle и packaging уточнить в CLI-проекте.
- CLI версия/релиз независимы: `cli/vX.Y.Z`, собственные artifacts и workflow,
  `make_latest=false`, без изменения Desktop update feed/codenames.

## Границы, которые нельзя потерять

Один физический profile — один owner до любых backup/migrations. Observer не потребляет
координаторский `check`/`consumedBy`. Client disconnect не равен stop runtime.
Server principal устанавливает host после авторизации, а не JSON браузера.
Mutations используют revision/request identity; uncertain native outcome не проигрывается
автоматически. Recovery resolution только фиксирует выбор, а не исполняет effect.
Writer heartbeat не заполняет durable mutation ledger. Shutdown ждёт native exit до lease release.

Runtime не импортирует Electron/Desktop/React; contracts/client/UI не импортируют Node backend
даже через type-only edges. Node/Electron ABI остаются в разных install roots.
Пока сохраняем JSON/migrations и текущие provider drivers; SQLite, новый scheduler,
remote Desktop и массовый перевод worker/coordinator на structured drivers — отдельные проекты.

Перенос Desktop данных/absolute paths/worktrees на сервер — управляемая offline-процедура
с backup и проверкой Git identity, а не автоматическое копирование live userData.
Файловый profile рассчитан на локальную ФС одной машины, не на общий сетевой каталог.
Синхронный dialog repository и обнаружение версии агента остаются текущими ограничениями;
это не незавершённая зависимость от Electron.

## Проверки и возобновление

Фундамент: локальный `pnpm verify` — 4091/4091; финальный CI #59 на `7ff3972` —
10/10 jobs SUCCESS (Linux/macOS/Windows и installed Linux artifact). Реальный Node PTY/Git,
legacy CLI, writer duplicate, disconnect и ownership/restart проверены. GUI вручную
проверяет пользователь; автоматического обхода экранов не было.

После релиза сначала проверить обратный перенос `master → sync/* → develop`, fetch актуальной
базы и наличие `v2.0.0` в её истории. Затем начать обычную `feature/*` от `origin/develop`
в отдельном worktree. Первое действие по Web — сверить этот порядок с актуальным кодом,
уточнить серверные параметры и оформить конкретный план подключения Web; не повторять
завершённый фундамент и не исполнять старый CLI-план буквально.

Главные решения и проверки сохранены в Git-документах выше. Дополнительные локальные logs
есть в `/private/tmp/orca-foundation-final-evidence-alf3fz_a` и
`/private/tmp/orca-docs-refresh.qZEuri`; эти временные каталоги не являются единственным
источником контекста и не нужны для сборки/продолжения.

## Возобновление Web 4 октября 2026

Desktop 2.0.0 собран в Draft, tag `v2.0.0` — master merge `1c726cc`; история
вернулась в develop через PR #62, merge `57f6d1b`. Релизные проверки и ограничения
ручной приёмки сохранены в [PR #61](https://github.com/NANDIorg/BigOrcaCocks/pull/61).

Пользователь продолжил разработку и уточнил поставку: Web должен устанавливаться
любым владельцем собственного сервера с небольшой первоначальной настройкой.
Сервера пока нет; первым выбран обычный Linux-сервис с установщиком. Агенты работают
под Unix-пользователем сервера. Docker остаётся дополнительным будущим способом.

Создана `feature/web-self-hosted` от `57f6d1b` в отдельном worktree.
[Архитектуру Web](superpowers/specs/2026-10-04-orca-web-self-hosted-design.md)
пользователь утвердил и уточнил общий выпуск с Desktop: одна версия, tag `vX.Y.Z`
и GitHub Release с отдельными установщиками. Web получает готовый Linux-пакет,
мастер установки и серверную команду обновления с backup. Старую независимую Web
release policy в scripts/guards/workflow нужно заменить в W6 до первого общего
выпуска; новый release/tag сейчас не создаётся. CLI остаётся независимым.

Рубежи W1–W6: host/auth → UI/projects → streams → files/preview → installer →
update/acceptance. [Первый implementation plan W1](superpowers/plans/2026-10-04-orca-web-host-auth.md)
подготовлен для проверки пользователем. Выполнять самому, отдельное итоговое ревью —
сохранённый выбор пользователя. W1–W6 реализованы в feature/web-self-hosted; повторять A–F не нужно.
Текущее состояние и проверки записаны ниже; первоначальная спецификация сохраняет свой срез.

## Состояние Web после W1–W6

Реализованы HTTP/auth/session host, общий typed UI adapter и browser shell, server project
picker, bounded observer/long polling/reconnect, explicit PTY writer, upload/download и
preview отдельного hostname. Linux archive включает Node/native/resources/browser;
installer/wizard/systemd/Caddy и серверный update с owner backup/health/rollback реализованы.
Общие Desktop/Web release guards и release job включены, версия не повышалась, Draft 2.0.0
и remote rulesets не менялись. Полный порядок — [web.md](web.md).

Итоговое независимое ревью выявило и исправлено: workflowContext classification, Amp/Shell
snapshot, resync чата, systemd config path и старый browser bundle. Installed smoke выявил
скачивание file attachment по image-only пути — теперь отдельный bounded binary method.
Каталог нового профиля создаётся headless до canonical lookup; smoke больше не создаёт его
заранее. Пользователь просил основные проверки в конце; их актуальные результаты добавляются
после выполнения в этой ветке.

Далее: ручная приёмка общего интерфейса, выбор Linux-сервера/DNS, проверка реального
systemd/HTTPS и обновления с опубликованным Web-выпуском. Публикация первого выпуска с Web
— отдельное поручение с собственным тегом web/vX.Y.Z; существующий Desktop 2.0.0 не переупаковывать. После Web —
человеческий CLI на общем client/runtime; независимый CLI tag/release сохраняется. Docker
дистрибутив, ARM64, аккаунтный SaaS и недоверенные операторы остаются будущими задачами.

### Итоговые проверки этой ветки

- Вся цепочка verify: Git Flow/codenames, все typechecks, 53 script tests и 4052 workspace
  tests (всего 4105), все builds — прошли. Старый macOS workflow assertion ожидал только
  Desktop jobs; обновлён под общий выпуск, затем повторён affected suite и выполнены
  оставшиеся workspace/build шаги. После последних packaging fixes повторены Web tests,
  Web typecheck/build и installed acceptance; неизменённые suites не повторялись.
- Frozen install и git diff --check прошли. Static UI audit strict по browser host:
  ноль findings, canonical map сохранён в UX-CONTRACT.md.
- macOS installed Web вне workspace прошёл реальные auth/two users/RPC replay,
  upload/download/preview, native PTY/writer/detach/restart и control start/status/doctor.
- Linux bundle compiled Node-native на Linux, checksum/installer проверены под ordinary
  user. Ubuntu 24.04 acceptance: TTY wizard/hidden password/custom config, installed host
  и CLI, systemd-analyze verify units и Caddy validate — прошли.
- TTY/direct-path acceptance выявил лишний top-level запуск start.ts внутри bundled
  control.mjs; guard удалён, control теперь единственная CLI entrypoint. systemd-analyze
  выявил неподходящие кавычки WorkingDirectory: используется HOME заданного User (`~`).
- Desktop local pack собран и открыт с последними общими изменениями. Web localhost
  также запущен на disposable profile. GUI/screens/платные ответы агентов вручную
  пока не проверены; Windows проверяется CI, не локальной машиной.

Linux-пакет готов для проверки; публичного Release/tag/bump не выполнено. На настоящем
сервере остаются DNS/сертификаты, реальный systemd autostart и обновление из опубликованного
первого отдельного Web-выпуска. Старый Desktop Draft 2.0.0 остаётся прежним.

Ручная проверка пользователя выявила Times New Roman и отсутствующий логотип на login:
font-sans задавался только в mountOrcaUi после auth, logo geometry была scoped к rail.
Font публикуется appearance до первого рендера, app-logo работает вне rail, Web inputs
наследуют font, submit центрирован. Regression appearance test прошёл; browser rebuild
обновлён в локальном Web. Повторная визуальная приёмка принадлежит пользователю.

### Последнее уточнение 05.10.2026

Web/Desktop релизы независимы по явному выбору пользователя: vX.Y.Z и web/vX.Y.Z,
собственные manifests/feeds/workflows. CLI позже отдельно cli/vX.Y.Z. Shared пакеты
встраиваются из SHA продукта. Новый Desktop для первой публикации Web не требуется.
README содержит краткие установку Desktop и Linux setup/два домена/агентов/обновления Web.
Обновлены docs/web, architecture, shared-foundation, git-flow/releasing, CONTRIBUTING,
CLAUDE, DESIGN/UX-CONTRACT, spec/plan/handoff. Старое общее release policy superseded.
Браузерные обновления реализованы через общий UpdateCard/Banner; отдельный ordinary-user
worker выполняет checksum/backup/owner/rollback. Review выявил аварии и races очереди:
fix pass добавил private transaction и pinned ExecStopPost recovery, атомарный claim,
ожидание inactive до следующей job. Регрессии проверяют настоящий SIGKILL в disposable
install, восстановление согласованного профиля и отсутствие повторного/потерянного job.
Публикация, bump, tag и реальные сервер/DNS/сертификаты остаются отдельными шагами.

Финал расширения: Web18 tests PASS (включая настоящий SIGKILL, очереди/ownership,
потерянные jobs и independent feed), affected release36 PASS, UI40 PASS со штатным
loader (прямой Node запуск без host loader не разрешает directory imports).
Все typechecks прошли; новый общий reason добавлен в exhaustive Desktop switch.
Ubuntu installed bundle/setup и systemd-analyze/visudo/Caddy templates прошли.
Полная прежняя цепочка 4105 тестов не повторялась: после расширения проверены затронутые suites.

Desktop pack с финальными shared изменениями завершён; app открыт из
apps/desktop/release/local/mac/orca-board.app. GUI проверяет пользователь.
Web доступен локально на http://localhost:3737 с прежними данными входа;
локальная проверка настоящего Web feed прошла (публичных Web-выпусков ещё нет).
Остаются PR/CI и отдельные поручения на публикацию Web/сервер, не код W1–W6.
