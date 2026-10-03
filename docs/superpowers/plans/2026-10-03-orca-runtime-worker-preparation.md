# Подготовка запуска воркера в общем runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Пользователь подтвердил самостоятельное выполнение и одно итоговое ревью; новый запрос разрешения не нужен.

**Goal:** Проверять выбранную роль, доступность агента и флаги до прямого входа/перезапуска задачи в граф, сохраняя существующие Git-развилки.

**Architecture:** TaskStore предоставляет read-only preview входа и перехода, основанный на том же чистом движке, что и запись. Runtime enterWork принимает проверку выбранной роли от host и вызывает её перед записью прямого входа; после Git проверяет фактически выбранную роль перед следующим переходом. Общий WorkerPreflight соединяет selection, launch policy и ошибки host; Desktop использует его до закрытия прежнего PTY.

**Tech Stack:** TypeScript strict, Node 24, node:test, существующие core/runtime и Electron adapter; без новых зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, этап 3; сохранение guards/effects и границ host.

## Global Constraints

- Назначенный worktree `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; база среза `92a1120df8a6d59dcb7ee2fb1bc441acea46fab9`.
- Runtime не импортирует Desktop/Electron/node-pty. Preview не создаёт store-клон, не пишет persistence/events, не меняет requests/visits/stageBlock.
- Нет изменений schema/events/IPC/socket/HELP, legacy CLI, версии и интерфейса. Ask-role остаётся временной; work-role сохраняется только после проверки запуска.
- Вход на work/ask, задачи-ответы, гейты, run scope без пути и legacy/path fallback сохраняют прежние правила. Preview и mutation используют одни вычисления.
- Для Git неизвестный исход не угадывается, не проверяются все агенты альтернативных веток. Без явной роли Git выполняется первым; проверка фактической роли происходит до перехода к воркеру, но уже выполненный Git и его записи не откатываются. С явной ролью она проверяется ещё до входа в Git.
- Без validation callback прежние пользователи enterWork сохраняют поведение. Асинхронные EffectToken/owner queues относятся к следующему этапу.
- Итог: pnpm verify, одно свежее ревью, pack/open, PR #59/push и CI точного HEAD. Без merge/release.

## Review Focus

1. Отказ запуска после ручного возврата с проверки сохраняет visits, stageBlock, историю и pending approval; выбранная work-role отличается от прежней роли задачи.
2. Ask-role и явный override проверяются как роль запуска и не портят роль следующей работы; ответ/гейт/run scope используют собственную роль.
3. Git ok/error выбирает разные роли: недоступный агент неиспользованной ветки не мешает; отказ фактического агента оставляет задачу на Git и не запускает PTY.
4. Негодные extraArgs и unknown/notInstalled/disabled дают прежние host errors до прямых mutations; два host/service не смешивают типы/агентов.
5. Повторные preview, condition attempts/role, blocked и путь подзадачи совпадают с последующей записью; public Node entry работает без Electron.

## Task 1: Read-only preview переходов TaskStore

**Files:** modify `packages/core/src/store.ts`, `docs/workflow.md`; create `packages/core/src/worker-preparation.test.ts`.

**Interfaces:**
- Produces: `TaskStore.previewEnterWork(taskId: string, opts?: RunWorkflowFallback): WfStep | undefined` — undefined при отсутствии нового входа; накопленные visits повторного входа совпадают с enterWork.
- Produces: `TaskStore.previewAdvanceStage(taskId: string, outcome: WfOutcome, opts?: RunWorkflowFallback): WfStep` — те же validations и pure step, что advanceStage.

- [ ] Написать тесты: fresh work-role, повторный вход с human и approval, неизменный snapshot/persistence при preview; entry ask/work no-op; blocked; nextStage conditions; legacy и путь подзадачи; ответы/гейты/run scope без пути. Проверить literal stage/action/visits и неизменность до последующей записи.
- [ ] Run: `node --test packages/core/src/worker-preparation.test.ts`. Expected: FAIL — preview API отсутствует.
- [ ] Выделить read-only вычисления из advanceStage/enterWork; обе mutation используют preview, сохраняя events/clearStageBlock/cancelStaleApprovals и прежние blocked semantics. Описать read-only границу в workflow docs.
- [ ] Run: `pnpm --filter @orca-board/core typecheck` и `pnpm --filter @orca-board/core test`. Expected: PASS.
- [ ] Commit: `refactor(core): добавить предварительный расчёт входа воркера`.

## Task 2: Общая проверка выбранной роли перед входом

**Files:** create `packages/runtime/src/worker-preflight.ts`, `packages/runtime/test/worker-preparation.test.ts`, `apps/desktop/src/main/worker-preflight.ts`, `apps/desktop/src/main/worker-preflight.test.ts`; modify runtime `src/index.ts`, `src/workflow.ts`, Desktop `src/main/index.ts`, `docs/architecture.md`, `docs/workflow.md`.

**Interfaces:**
- Consumes: Task 1 previews, AgentSelectionServices.assertAgentUsable, createLaunchPolicy.roleLaunchExtraArgs, ExecutionMessages.
- Produces: `createWorkerPreflight({ selection, launchPolicy, messages }).validate(type: RoleSource, agents: AgentInfo[], roleId: string): Role` — role lookup → agent guard → extraArgs parse.
- Produces: `WorkerPreparationOptions { roleId?: string; validateRole?: (roleId: string) => void }`; `enterWork(deps, taskId, opts?: WorkerPreparationOptions): { roleId?: string }` сохраняет прежний результат temporary ask-role.
- Desktop facade `validateWorkerRole` связывает общий preflight с OrcaError и прежними adapters.

- [ ] Написать regression tests: missing stage-role; disabled/notInstalled/unknown; invalid flags; restart сохраняет approval/stage/visits; work-role применяется после guard; ask/override временные; ответы/гейты/run scope; Git ok/error с разными агентами, отказ перед переходом/PTY, explicit override до Git. Real TaskStore, временный настоящий Git, реальные selection/launch policy. Desktop проверяет OrcaError и перевод после смены языка; Node smoke использует public package entry.
- [ ] Run: `node --test packages/runtime/test/worker-preparation.test.ts`. Expected: FAIL — factory/guard отсутствуют.
- [ ] Создать preflight factory и экспорт; в enterWork вызывать validation до прямой записи, после Git — по preview фактического перехода. Передавать opts через отложенное исполнение Git; оставлять обычное автоматическое execute без нового контракта. Desktop передаёт snapshot типа/агентов и callback, закрывает прежний PTY после успешной подготовки.
- [ ] Run: runtime/Desktop typecheck, новые suites и существующие workflow/launch suites; `pnpm verify`. Expected: PASS, schema/HELP не меняются.
- [ ] Commit: `fix: проверять запуск воркера до входа в этап`.

## Завершение

- [ ] Fresh final reviewer по диапазону текущего среза, плану/spec/ledger; re-grade по эффекту, один fix pass Important/Critical, Minors в ledger.
- [ ] Собрать и открыть локальное приложение после проверок; проверить app.asar, подпись и наличие renderer. Ручной UI проверяет пользователь.
- [ ] Обновить PR #59 один раз перед push, дождаться CI точного HEAD; сохранить evidence, убрать только scratch этого плана.
