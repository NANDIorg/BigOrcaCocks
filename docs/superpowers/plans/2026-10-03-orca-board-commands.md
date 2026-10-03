# Общие команды доски — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Выполнять inline, затем одно независимое итоговое ревью. Пользователь уже подтвердил автономное продолжение общей архитектуры и этот способ исполнения.

**Goal:** Desktop выполняет чтение доски и создание, правку, перемещение, удаление обычных задач через общий runtime API с явным проектом, клиентом и автором.

**Architecture:** Browser-safe contracts описывают DTO и ошибки. Синхронный runtime service проверяет host-established context, обязательную политику доступа и payload до открытия store, использует существующие guards/persistence и возвращает отделённые копии. Desktop compatibility adapter фиксирует текущий проект в начале вызова, проверяет доверенный IPC sender и сохраняет прежние каналы/preload.

**Tech Stack:** Node 24, pnpm 10.33.0, strict TypeScript, node:test, существующие core/contracts/runtime/Electron.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, разделы 4, 6, 11–12. Это первый участок полного command API, а не завершение этих разделов.

## Global Constraints

- Runtime не импортирует desktop/headless/web. Contracts, client и UI не импортируют Node/Electron.
- Клиент не открывает JSON store и не повторяет backend guards.
- Общий `ProjectManager.activeId` не определяет проект чужого запроса.
- Browser `actor.kind` не является доказательством личности; context устанавливает host, политика доступа обязательна.
- Сохраняются Node 24, Windows/macOS/Linux, текущие пути/форматы/версии, native ABI и legacy agent CLI HELP/envelope.
- Новые dependencies, IPC каналы, UI, Web/CLI продукты и схема сохранения не требуются.
- Работа в назначенном `feature/web-migration-audit`; разрешены свой push/PR, локальная упаковка/запуск; merge/release не входят.
- Все новые операции синхронны. Async actor queues/effect tokens/revision/idempotency/replay и socket migration — следующие отдельные участки; не выдавать этот API за готовый transport protocol.
- Ошибки имеют code/details. Старые доменные ошибки core/выбора роли сохраняют причину и совместимый перевод в Desktop; гранулярные доменные коды переносятся позднее.

## Review Focus

1. Чередующиеся клиенты A/B с разными проектами: команда B не меняет A независимо от activeId; test Task 1.
2. Подмена actor/client или отказ политики: store не открывается и результат не раскрывается; tests Task 1/2.
3. Payload с runId/agent/gateFor, null/массивами/невалидными deps/priority: ошибка до создания inbox/сохранения; test Task 1.
4. DTO со вложенными объектами/массивами после чтения: мутация результата не меняет store и не сохраняется; test Task 1.
5. Удалённый проект/задача и задача в работе: нет fallback на соседний проект, прежние guards и attribution сохраняются; tests Task 1/2.

---

### Task 1: Контракты и исполняемые команды runtime

**Files:** Create `packages/contracts/src/board-commands.ts`, `packages/runtime/src/board-commands.ts`, `packages/runtime/test/board-commands.test.ts`; Modify barrels и `docs/architecture.md`.

**Interfaces:**
- Produces contracts `ProjectCommandContext { projectId, clientId, actor: { kind: 'operator'|'agent'|'system', id } }`, `TaskCreateInput`, `BoardCommandName`, `BoardCommands` (get/createTask/updateTask/moveTask/removeTask), `BoardCommandErrorData`.
- Produces runtime `BoardCommandError` с `code/details/cause`; `createBoardCommands({ project(id), authorize(context, command), selection }) : BoardCommands`.
- `project(id)` возвращает `{ store: TaskStore, roles(): RoleSource, agents(): AgentInfo[] } | undefined`; никогда не activeStore. `selection: AgentSelectionServices`. authorize возвращает строго true для разрешённого вызова, иначе отказ.
- Results: get → BoardSnapshot DTO с tasks/dispatches/events/questions/runs/requests и optional formatVersion; create/update/move → Task; remove → void. Возвращённые структуры клонированы.
- Errors: `command.invalidContext`, `command.forbidden`, `command.invalidInput`, `command.projectNotFound`, `command.taskNotFound`, `command.rejected`; details содержат поле/идентификаторы/причину, без stack и store.

- [ ] Написать tests реальных TaskStore и файловых persistence: два проекта/клиента, host policy deny до project lookup, неизвестные context/project/task, payload schema и лишние поля, role/agent guards, история operator→human/agent→cli/system→app, неизвестная колонка и in_progress, мутации копий, reload, throw политики/selection/store.
- [ ] RED: `node --test packages/runtime/test/board-commands.test.ts`; ожидается assertion отсутствующего runtime factory.
- [ ] Реализовать contracts/service. Payload копируется и проверяется до effects; whitelist исключает массовое присваивание runId/agent/gateFor. Source действует только в синхронной операции; существующие listeners не меняются.
- [ ] GREEN: тот же targeted command, затем typecheck contracts/runtime, suites contracts/runtime/core; ожидается exit 0, все assertions проходят.
- [ ] Commit `refactor: выполнять команды доски через общий runtime`; task-done targeted suite.

### Task 2: Desktop compatibility adapter и итоговая поставка

**Files:** Create `apps/desktop/src/main/board-commands.ts`, `apps/desktop/src/main/board-commands.test.ts`; Modify `main/index.ts`, `main/strings/ru.ts`, `main/strings/en.ts`, docs architecture/этот план.

**Interfaces:**
- Consumes Task 1 `BoardCommands`, `ProjectCommandContext`, `BoardCommandError`.
- Produces `registerDesktopBoardCommands<Event>(handle, { commands, activeProjectId, clientId })`: прежние `board:get`, `tasks:create`, `tasks:update`, `tasks:move`, `tasks:remove`.
- `clientId(event): string | null` проверяет текущие webContents/mainFrame. Неподтверждённый sender отвергается даже при пустой доске. Для проверенного sender board:get без проекта отдаёт прежний пустой snapshot; мутации — `projects.none`.
- Context: projectId из legacy selection в начале запроса, clientId из доверенного sender, actor `{kind:'operator', id:'local-user'}`. Runtime policy разрешает только этот текущий Desktop client/operator. Серверные clients будут задавать собственный явный контекст, без такого fallback.
- Адаптер сохраняет перевод OrcaError причины, прежний текст core rejection; новые boundary ошибки переводит ru/en через OrcaError.

- [ ] Написать integration tests с настоящим runtime/TaskStore через зарегистрированные IPC callbacks: прежние параметры/результаты, пустая доска, недоверенный sender/actor, переключение выбранного проекта, null patch → {}, сохранение core guard и перевода role/boundary ошибок.
- [ ] RED: Desktop node:test с существующим ts-resolve loader; ожидается отсутствие adapter factory/регистрации.
- [ ] Реализовать adapter; initializeDesktop создаёт один service, registerIpc подключает его вместо пяти прямых store handlers; mainFrame проверяется до чтения/изменения данных.
- [ ] GREEN: Desktop targeted suite, typecheck, Node ABI rebuild и полный `pnpm verify`; ожидается exit 0.
- [ ] Commit `refactor: подключить Desktop к общим командам доски`; task-done targeted suite.
- [ ] Одно fresh review increment от baseline `330292464de50158510886dc366f9ff3d26250c5`, Important/Critical — один RED→GREEN fix pass, Minor — ledger/final без исправлений.
- [ ] Актуализировать docs, при docs changes core suite; собрать `pnpm --filter @orca-board/desktop run pack`, открыть app, проверить packaged imports/code signing/main и renderer без автоматического UI обхода.
- [ ] Обновить собственный PR 59, push, дождаться exact HEAD CI. Evidence архивировать с hash, удалить только scratch этого плана; app/worktree сохранить.

## Проверка покрытия и границы

План покрывает первый пять-методный участок раздела 4 и explicit context из раздела 12.5. Все пять Review Focus имеют конкретные tests. Собственный HTTP/WS/operator endpoint, actor sequencing/revision/retry, глобальные задачи/workflow/files/settings, socket handlers и общий client/UI не реализуются этим переносом. Прямой вызов service является host API, не аутентификацией пользователя по произвольному JSON actor.
