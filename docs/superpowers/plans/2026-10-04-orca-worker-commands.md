# Общие команды воркеров — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести запуск, остановку и восстановление живости воркеров в общий runtime и перевести Desktop на явный project command API.

**Architecture:** Browser-safe contracts описывают `WorkerCommands.start/stop`. Runtime проверяет context/policy/payload до lookup и вызывает общую trusted orchestration. Существующие IPC, agent socket и workflow используют её с прежними DTO и guards; Electron выбирает проект только на своей границе.

**Tech Stack:** Node 24, TypeScript, pnpm, node:test, настоящий Git/TaskStore, SessionRegistry с внедряемым PTY.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §§3–7, 11–12; утверждённая архитектура и inline execution сохраняются.

## Global Constraints

- Назначенный worktree `/private/tmp/orca-web-migration-audit`, ветка `feature/web-migration-audit`; исходный HEAD `69851ad8baf0f8a0968da43c3efafa8081ad17d4`.
- Contracts импортирует только browser-safe core; runtime не импортирует Desktop, Electron или node-pty.
- Context содержит явные projectId/clientId/actor; host устанавливает principal. Policy предшествует payload, project lookup и effects.
- Существующие JSON/CLI HELP/envelope/exit codes/skills, версии, provider transports и пользовательский интерфейс сохраняются. Нового worker:stop IPC не добавляем.
- Только один implementer, один fresh final reviewer. Ручной UI проверяет пользователь; после проверок обязательны локальный pack/open без публикации.
- Этот этап не завершает фундамент: review/request commands, остальные services, async Git/effect tokens, multiclient/replay, полный headless/Linux artifact, client/UI и release tooling остаются следующими этапами.

## Review Focus

- Чужой taskId либо недоверенный caller: ни соседний store, ни процессы, ни Git не меняются.
- Недоступная роль work/ask или негодные extraArgs: старый PTY, dispatch и ожидающий запрос сохраняются до подготовки этапа.
- Git → work/error/human: запускается только фактическая роль выбранной ветки; граф не обходится и запуск не удваивается.
- Живой PTY закрытого dispatch и смешанные живые/мёртвые dispatch: закрытие done убирает старый терминал, sync не закрывает живого воркера.
- Callback выхода при kill: dispatch закрыт раньше PTY, поэтому остановка не выглядит падением; workflow/CLI сохраняют прежний источник статуса и launch DTO.

---

### Task 1: Общие worker commands, orchestration и lifecycle

**Files:**
- Create: `packages/contracts/src/worker-commands.ts`.
- Create: `packages/runtime/src/worker-commands.ts`, `worker-operations.ts`, `task-worker-lifecycle.ts`.
- Modify: оба `src/index.ts`, runtime `command-input.ts`, `coordinator-commands.ts`.
- Test: `packages/runtime/test/worker-commands.test.ts`, `worker-command-test-host.ts`.

**Interfaces:**
- Consumes: `createProjectCommandExecutor`, `WorkerServices.startWorker`, `TaskWorkflowServices.enterWork`, `createWorkerPreflight(...).validate`, SessionRegistry `isAlive/killPty`.
- Produces: `WorkerLaunchInput { cols?, rows?, roleId? }`, `WorkerLaunchResult { ptyId, dispatchId, worktree, branch }`, `WorkerStopResult { stopped: string[] }`; `WorkerCommands.start(context, taskId, input?)`, `stop(context, taskId)`.
- Produces: `WorkerProject { store, root, environment(runId?), agents(), workflow: WorkflowDeps }`; `createWorkerOperations(host).start(project, taskId, input?) / stop(project, taskId)`.
- Produces: `createTaskWorkerLifecycle(sessions).closeTaskWorkers(store, taskId) / closeDoneWorkers(store) / syncWorkerLiveness(store, taskId)`; explicit store, без состояния выбранного окна.

- [x] **Step 1:** Написать failing tests на настоящий store/Git/launcher: start в A не меняет B, policy и невалидные размеры до lookup, чужой task → `command.taskNotFound`, caller mutation не меняет context; stop возвращает dispatch ids и ready с human/cli/app source. В fixture подменяется только native PTY, не services.
- [x] **Step 2:** `node --test packages/runtime/test/worker-commands.test.ts`. Expected: assertion FAIL на отсутствии factory, не import error.
- [x] **Step 3:** Реализовать указанные interfaces; общий size parser используется также координатором. Trusted start сохраняет старые missing/global-task причины socket; публичные commands предварительно проверяют task scope. Роль проверяет общий preflight до старого kill; `enterWork` сохраняет существующие Git/human guards.
- [x] **Step 4:** Добавить случаи work/ask/override, disabled/missing/notInstalled/extraArgs, Git success/error/human, restart с прежним PTY, stop по закрытому dispatch, done cleanup и mixed liveness. Выполнить runtime/contracts typecheck и оба package test. Expected: все tests PASS, boundaries PASS.
- [x] **Step 5:** Проверить diff, закоммитить точные paths: `refactor: вынести команды и lifecycle воркеров в runtime`; task-done повторяет `pnpm --filter @orca-board/runtime test`.

### Task 2: Desktop, workflow и старый socket используют общий путь

**Files:**
- Create: `apps/desktop/src/main/worker-commands.ts`, `worker-commands.test.ts`.
- Modify: `apps/desktop/src/main/index.ts`, `socket.ts`.
- Modify: `docs/architecture.md`, `docs/nested-kanban.md`, `docs/human-requests.md`, `docs/workflow.md`.

**Interfaces:**
- Consumes: Task 1 WorkerCommands/WorkerProject/WorkerOperations/TaskWorkerLifecycle и существующий DesktopProjectCommandAdapter.
- Produces: `registerDesktopWorkerCommands(handle, {commands,activeProjectId,clientId})`, прежний `worker:start(taskId, cols, rows)` → WorkerLaunchResult. Нет нового канала.
- Produces: main собирает project ports, raw WorkerServices и shared preflight; workflow/agent socket идут через trusted operations. Socket answerQuestion/resolveRequest используют общий sync liveness.

- [x] **Step 1:** Написать failing adapter tests: caller до selection, projects.none, capture selection один раз, реальные Git/dispatch/DTO/размеры, wrong project и host localized errors. Создать пустой adapter `export {}` только как import scaffold.
- [x] **Step 2:** `node --experimental-transform-types --no-warnings --import ./apps/desktop/test/ts-resolve.mjs --test apps/desktop/src/main/worker-commands.test.ts`. Expected: assertion FAIL на отсутствии register factory.
- [x] **Step 3:** Реализовать adapter и заменить локальные runWorker/stop/close/liveness orchestration вызовами Task 1; main оставляет только project selection/ports. Workflow callback не вызывает public command policy и не входит повторно в run graph. Обновить четыре документа текущими путями, без новых CLI команд.
- [x] **Step 4:** Desktop typecheck, targeted adapter test, затем `pnpm verify` после восстановления Node ABI node-pty. Expected: все package tests/types/build PASS. Проверить существующие socket/worker/preflight/workflow tests в полном suite.
- [x] **Step 5:** Проверить diff, закоммитить точные paths: `refactor: подключить Desktop к общим командам воркеров`; task-done повторяет adapter command из Step 2.

## Итоговая проверка и доставка

- [x] Один fresh final reviewer диапазона исходный HEAD..production HEAD по plan/spec/Review Focus/ledger; Critical/Important → один RED→GREEN fix pass, Minor → backlog.
- [x] Локальный Desktop pack, codesign/ASAR checks и open свежего app; read-only profile identity probe без GUI кликов.
- [x] Зафиксировать результаты реализации, полного verify, review и локальной сборки в этом плане.

**Фактические результаты:** runtime/contracts typecheck и contracts50 PASS; task-done runtime664/664 и Desktop6/6 PASS. Полный `pnpm verify` — **3634/3634**, fail/cancel/skip0: scripts49/core943/CLI38/contracts50/runtime664/Desktop1890; typecheck/build PASS. Один fresh reviewer проверил текущий диапазон `69851ad..3ab241e`: Critical0/Important0/Minor0, независимые runtime26/26 и Desktop6/6 PASS; исправлений по ревью не потребовалось.

Desktop 1.1.3 / Electron 38.8.6 / macOS x64 собран на production commit `3ab241ebe022ba4bfac88211b7ff20f38d8cf6ae`; codesign и bundled runtime/contracts/core PASS. Приложение: `/private/tmp/orca-web-migration-audit/apps/desktop/release/local/mac/orca-board.app`; фактический main5298/renderer6190, profile identity и read-only owner probe PASS. Ручной интерфейс проверяет пользователь.

При первом старте завис прежний `shellPath()` до профиля/воркеров: основной процесс ожидал subprocess login-shell `zsh`. Диагностика сохранена; после остановки только его зависших bootstrap subprocess приложение завершило запуск. Код чтения PATH в этом переносе не изменён; повторяемость и постоянное исправление — отдельная задача.

**Доставка после последнего коммита документации:** повторить core docs/HELP suite, обновить PR #59 до push, дождаться push и PR CI именно финального HEAD, проверить чистый worktree. Затем архивировать/hash-check только собственный SDD workspace и удалить его leaf. Итоговый receipt после этих действий хранится вне Git: `/private/tmp/orca-worker-commands-evidence/delivery-final.json`, ledger/логи/единственное ревью — в соседнем `sdd/`. Это позволяет подтвердить CI финального HEAD без последующего коммита, который изменил бы проверенный HEAD. В итог пользователю включить scope/tests/review/app/остаток работ, все Rulings и deferred minors текущего ledger.
