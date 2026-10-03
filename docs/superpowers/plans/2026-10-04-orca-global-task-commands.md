# Общие команды глобальных задач — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Выполнять inline с одним независимым итоговым ревью. Пользователь подтвердил автономное продолжение общего фундамента и этот способ исполнения.

**Goal:** Desktop выполняет CRUD глобальных задач, выбор типа, создание подзадач и работу с вложениями через общий API с явным проектом, клиентом и автором.

**Architecture:** Два command service используют общий синхронный executor контекста, доступа, attribution, ошибок и отделения DTO. Global service использует настоящие core guards, выбор роли и execution resources; удаление с очисткой вынесено в общую операцию, которую использует и legacy socket. Desktop adapter сохраняет существующие IPC/preload и фиксирует selection только на границе.

**Tech Stack:** Node 24, pnpm 10.33.0, strict TypeScript, node:test, core/contracts/runtime/Electron.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, разделы 4, 6, 11–12. Это очередной участок command API. Запуск/остановка, переходы workflow, запросы, revisions/idempotency/replay, async Git, Node host, client/UI и независимые поставки остаются обязательными следующими этапами.

## Global Constraints

- Runtime не импортирует desktop/headless/web. Contracts, client и UI не импортируют Node/Electron.
- Клиент не открывает JSON store и не повторяет backend guards.
- Общий `ProjectManager.activeId` не определяет проект чужого запроса.
- Browser `actor.kind` не является доказательством личности; host устанавливает context, политика доступа обязательна.
- Сохраняются Node 24, Windows/macOS/Linux, текущие пути/форматы/версии и native ABI.
- Legacy agent CLI HELP/envelope и channels/preload сохраняются; новых dependencies/UI не требуется.
- Изменения — в назначенном worktree `feature/web-migration-audit`; baseline `79d599f1701a537dc5165e889c2d4996685e89c7`.
- В конце обязательны pnpm verify, отдельное ревью, локальный pack/open и обновление PR 59. Мерж и релиз не входят.

## Review Focus

- Подмена runId/agent/gateFor и разреженные deps/attachments: отказ до открытия проекта и любых записей (Task 1/2).
- Несуществующая или чужая глобальная задача: никаких подзадач, файлов и cleanup в другом проекте (Task 2).
- Живой координатор/dispatch и cascade: guards до cleanup; закрытый dispatch с живым PTY убирается при разрешённом удалении (Task 2).
- Неудачная запись вложений: настоящий rollback нового run и файлов; MIME определяется по байтам (Task 2).
- Legacy null patch, отсутствие selection и чужой IPC frame: совместимость старого клиента и проверка caller прежде selection (Task 3).

### Task 1: Общий executor и строгие входные поля

**Files:** создать contracts `project-commands.ts`, runtime `project-commands.ts` и `command-input.ts`; изменить contracts/runtime `board-commands.ts`, entrypoints, runtime `test/board-commands.test.ts`, `docs/architecture.md`.

**Interfaces:**
- Produces: `ProjectCommandContext`, `CommandErrorCode/Data`, `CommandError` (совместимый alias `BoardCommandError`), `ProjectCommandHost<Project, Name extends string>` с обязательными `project(id)`/`authorize(context,name)`.
- Produces: `createProjectCommandExecutor<Project, Name>(host)` → синхронный generic executor `(rawContext, name, validate: () => (project, context) => T): T`.
- Produces: внутренние `commandFields`, `commandString`, `commandInputError`, `taskCreateFrom` для безопасного построения input и dense deps. Публичный barrel их не экспортирует.
- Существующий `BoardCommands`/DTO и `instanceof BoardCommandError` сохраняются. Новая ошибка `command.globalTaskNotFound`, details `globalTaskId`.

- [x] Написать тест `разреженные deps отклоняются до открытия проекта`: `deps: new Array(1)` → invalidInput/deps, lookup пуст, persistence не меняется. Существующие policy/context/actor/error DTO tests остаются regression.
- [x] Запустить `node --test packages/runtime/test/board-commands.test.ts`: Expected FAIL sparse deps.
- [x] Вынести executor/контекст/ошибку и валидаторы, перевести существующий Board service на них. Отказ policy строго при результате !== true, копия context, payload до lookup, structuredClone результата, source human/cli/app только внутри синхронной операции.
- [x] Запустить board suite, runtime/contracts typecheck и contracts test: Expected PASS.
- [x] Обновить архитектуру, проверить diff, закоммитить; task-done: `node --test packages/runtime/test/board-commands.test.ts` → PASS.

### Task 2: Общий global service и удаление ресурсов

**Files:** создать contracts/runtime `global-task-commands.ts`, runtime `global-task-removal.ts`, `test/global-task-commands.test.ts`; изменить entrypoints, `docs/architecture.md`, `docs/nested-kanban.md`.

**Interfaces:**
- Consumes: executor и валидаторы Task 1, `AgentSelectionServices`, `ExecutionResources`, настоящие TaskStore/JSON persistence.
- Produces: `GlobalTaskCommands` с `list/get/create/update/changeType/move/remove/tasks/createTask/addImages/removeImage/image(context, ...)`; существующие `GlobalTaskInput/Patch/SubtaskInput`, `AttachmentInput[]`, outputs GlobalTask/Task/DTO bytes.
- Produces: `GlobalTaskCommandProject { store, root, runType(typeId?), roles(globalTaskId), agents() }`; `GlobalTaskCommandHost` extends project host, `selection`, `resources`, `dataDir`, `sessions {isAlive,kill}`, `messages.error(global.coordinatorAlive)`.
- Produces: `createGlobalTaskRemoval({resources,dataDir,sessions,messages})` → `(project:{id,store,root}, globalTaskId:string, cascade:boolean) => {deleted:string,tasks:string[]}`; trusted operation для service и существующего socket helper.
- Поля create: title/description/status/priority/typeId; update: title/description/priority; subtask: title/spec/priority/roleId/deps/answerFor. Только dense массивы. Тип выбирается из проекта до создания; роль — из типа глобальной задачи и stageDefaultRole. Существующие guards и rollback resources сохраняются.

- [x] Написать тесты с настоящими двумя persisted store и resources: project isolation после reload; policy всех 12 методов до lookup; context и policy mutation; mass assignment, invalid patch/status/type/answerFor/deps/attachments; foreign run; тип недоступен и locked; scoped subtask deps/default role/attribution/copy; удаление cascade/live coordinator/live dispatch без cleanup; разрешённое удаление чистит только свои attachments/showcase/PTY/worktree; настоящие bytes/MIME и rollback записи.
- [x] Запустить `node --test packages/runtime/test/global-task-commands.test.ts`: Expected FAIL нет executable factory.
- [x] Реализовать service и removal с существующими ресурсами, без Desktop imports; добавлять файлы/убивать PTY только после core guards. Error DTO не содержит paths/stack/cause как отдельные поля, legacy cause остаётся локальным.
- [x] Запустить обе command suites, contracts test и runtime/contracts typecheck: Expected PASS.
- [x] Обновить docs, проверить diff, закоммитить; task-done: `node --test packages/runtime/test/board-commands.test.ts packages/runtime/test/global-task-commands.test.ts` → PASS.

### Task 3: Desktop compatibility adapter

**Files:** создать `apps/desktop/src/main/global-task-commands.ts` и `.test.ts`; общий `project-command-adapter.ts` для двух потребителей; изменить main `board-commands.ts`, `index.ts`, strings ru/en, `docs/architecture.md`, `docs/nested-kanban.md`.

**Interfaces:**
- Consumes: `GlobalTaskCommands`, `createGlobalTaskCommands`, `createGlobalTaskRemoval` Task 2.
- Produces: `registerDesktopGlobalTaskCommands<Event>(handle, {commands,activeProjectId,clientId})` — 12 прежних channels.
- Общий adapter устанавливает operator/local-user; caller проверяется до selection. list без проекта → []; null update → {}; null remove opts → cascade false. Ошибки core/OrcaError из local cause сохраняют legacy перевод.
- Main создаёт два service после ProjectManager с одним проверенным Desktop policy, resources/roles/types/paths/sessions. Main `removeGlobalTask` делегирует общей trusted removal; socket envelope неизменен. reveal/open остаются native, coordinator/accept/return отдельным следующим этапом.

- [ ] Написать интеграционные тесты registered callbacks с настоящим global service/store/resources: старые channels/types/defaults, active project switch, input не подменяет actor/run, чужой caller не читает selection/store, прежняя локализованная ошибка type/role.
- [ ] Запустить `node --experimental-transform-types --no-warnings --import ./apps/desktop/test/ts-resolve.mjs --test apps/desktop/src/main/board-commands.test.ts apps/desktop/src/main/global-task-commands.test.ts`: Expected FAIL нет executable adapter.
- [ ] Подключить common service/adapters к production main, убрать перенесённую бизнес-логику. Новый error key добавить в оба main словаря; preload и signatures не менять.
- [ ] Пересобрать node-pty из исходников под Node 24, запустить adapter suites и `pnpm verify`: Expected PASS всех пакетов/typecheck/build.
- [ ] Обновить docs/checkbox, проверить diff, закоммитить; task-done — обе Desktop adapter suites → PASS.

## Доставка и границы готовности

- [ ] Одно fresh review baseline..HEAD по plan/spec/ledger; Important/Critical одним RED→GREEN проходом, Minor отложить и назвать. Не merge/approve.
- [ ] Собрать local pack, нормально перезапустить только свой app при отсутствии живых агентов, проверить ASAR/codesign/main+renderer/profile identity, открыть app для ручной проверки пользователем.
- [ ] Обновить PR 59, push собственной feature, дождаться CI на точном HEAD; архивировать evidence и удалить только scratch этого плана.

План проверен против утверждённого spec: новый network host/transport и полный workflow API намеренно остаются следующими этапами. Полную готовность фундамента этот перенос не объявляет.
