# Orca: точка продолжения после подготовки 2.0.0

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
вместе; версии private shared packages и будущих Web/CLI не выравниваются с 2.0.0.

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
   Подготовить Web artifact/workflow/version с `web/vX.Y.Z`, `make_latest=false`.

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
