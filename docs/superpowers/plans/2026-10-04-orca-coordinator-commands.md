# Общие команды координатора — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести новый запуск, перезапуск, приёмку и возврат глобальной задачи в общий owner API, сохранив Desktop и старый агентский сокет.

**Architecture:** Contracts задаёт четыре синхронные команды с ProjectCommandContext. Runtime проверяет policy и payload до project lookup и использует общий исполнитель координатора; Desktop выбирает проект только на IPC границе. Trusted исполнитель нужен также старому агентскому сокету, чтобы не дублировать orchestration и не менять его envelope.

**Tech Stack:** TypeScript, pnpm workspace, Node test runner, TaskStore, настоящий Git, Electron adapter.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §4–7, §12. Продолжение от `791d2c988e55d41f7df03b7ed5bbfa5d92dce84a`, существующий worktree `feature/web-migration-audit`.

## Global Constraints

- Общий runtime не импортирует Electron/Desktop/node-pty; contracts использует только browser-safe типы core.
- Явные projectId/clientId/host actor; policy до payload/lookup/эффектов. Legacy activeId остаётся только в Desktop.
- Сохраняются core guards, workflow snapshots, feedback, ссылки на вложения при сбое запуска, нативные host ошибки и прежние IPC DTO.
- Настоящие store/Git/диск в тестах; подменяется только native PTY spawn. Нет GUI automation и вызовов реального LLM.
- Нет новых dependencies, версий, transport, CLI продукта, async Git/очереди/replay или релиза. Фундамент ещё не объявляется завершённым.
- Реализация самостоятельно; одно свежее итоговое ревью. После инженерных проверок собрать и открыть локальный Desktop, обновить собственный PR 59 без merge.

## Review Focus

- Чужой project/run или caller: отказ до файлов, смены этапа и PTY.
- Ошибка после записи human feedback: сохраняются durable решение и только действительно используемые файлы; до решения — rollback файлов.
- Run workflow и legacy task scope: разные правила возврата, без рекурсивного startRunWorkflow.
- Завершённый граф, живой координатор и неоднозначные approval: прежние guards до мутаций.
- Ввод неизвестных полей, sparse attachments и нецелых/неположительных terminal размеров: отказ до lookup; attachment-only цель допустима.

### Task 1: Runtime и contracts

**Files:** Create `packages/contracts/src/coordinator-commands.ts`, `packages/runtime/src/coordinator-operations.ts`, `packages/runtime/src/coordinator-commands.ts`, `packages/runtime/test/coordinator-command-test-host.ts`, `packages/runtime/test/coordinator-commands.test.ts`. Modify оба `src/index.ts`, `runtime/src/command-input.ts`, `runtime/src/global-task-commands.ts`.

**Interfaces:**
- Consumes: createProjectCommandExecutor, WorkerServices, RunWorkflowServices, ExecutionResources и RunWorkflowDeps.
- Produces: CoordinatorCommands.start(context, {objective, typeId?, cols?, rows?, images?}), startCoordinator(context, globalTaskId, {cols?, rows?, images?}?), accept(context, globalTaskId, decision?), returnToWork(context, globalTaskId, {text, cols?, rows?, images?}). Launch результат `{ptyId,runId}`, accept — GlobalTask.
- CoordinatorProject `{store,root,environment(runId?),newRunEnvironment(typeId?),workflow:RunWorkflowDeps}`. Host передаёт workers/startCoordinator/returnToWork, run workflow service, resources, error для двух workflow keys. createCoordinatorOperations(host) принимает явный project и используется также legacy agent launch.
- Payload: whitelist; строки objective/text допускают пустую строку согласно старым guards, decision optional string, typeId и runId непустые; cols/rows optional positive integer. Вложения через один общий commandAttachmentsFrom с core validation.

- [x] Step 1: Написать тесты factory и настоящих start/accept/return, двух проектов, всех четырёх policy checks, невалидного context/payload, source human/cli/app, ended/alive/ambiguous guards, legacy return, rollback/retained files при failed launch.
- [x] Step 2: `node --test packages/runtime/test/coordinator-commands.test.ts` с Node 24 PATH. Expected: assertion FAIL, отсутствует createCoordinatorCommands/createCoordinatorOperations, без import ошибки.
- [x] Step 3: Реализовать contracts, trusted operations и четыре project команды. Вынести проверку attachments из global-task-commands в private command-input; сохранить глобальный CRUD.
- [x] Step 4: `pnpm --filter @orca-board/contracts typecheck`, `pnpm --filter @orca-board/runtime typecheck`, `pnpm --filter @orca-board/runtime test`. Expected: всё PASS. Проверить diff и закоммитить точные файлы.
- [x] Step 5: task-done с `pnpm --filter @orca-board/runtime test`. Expected: PASS и ledger completion.

### Task 2: Desktop и документация

**Files:** Create `apps/desktop/src/main/coordinator-commands.ts`, `apps/desktop/src/main/coordinator-commands.test.ts`. Modify `apps/desktop/src/main/index.ts`, `docs/architecture.md`, `docs/nested-kanban.md`, `docs/workflow.md`, этот план.

**Interfaces:**
- Consumes: четыре CoordinatorCommands из Task 1 и createDesktopProjectCommandAdapter, общий test host из Task 1.
- Produces: registerDesktopCoordinatorCommands(handle, {commands,activeProjectId,clientId}); старые четыре IPC callbacks сохраняют signature/launch ptyId string. Старые accept decision и return text defaults нормализует только adapter. Main собирает явные project ports, trusted runCoordinator использует createCoordinatorOperations.

- [x] Step 1: Добавить тесты четырёх callbacks с настоящим runtime: caller до selection; один capture active project; старые defaults/DTO; между проектами нет fallback; локализация host errors; return failure сохраняет feedback и файлы. Пустой adapter export допустим только для запуска RED.
- [x] Step 2: Desktop loader test command для `coordinator-commands.test.ts`. Expected: assertion FAIL отсутствует registerDesktopCoordinatorCommands.
- [x] Step 3: Подключить adapter и project services в main, убрать четыре старые бизнес-реализации и runFinished. Legacy socket использует общий trusted executor, raw graph restart остаётся без startRunWorkflow.
- [x] Step 4: Обновить три документа: текущее покрытие, distinction legacy socket / owner API и ещё отсутствующие lifecycle/worker/review/transport guarantees.
- [x] Step 5: После Node rebuild node-pty выполнить `pnpm verify` с Node 24 PATH, отдельно docs core test при необходимости включён verify. Expected: все suites/typecheck/build PASS. Проверить diff, commit, task-done с Desktop coordinator test command.

## Завершение

Одно свежее whole-branch ревью с фокусом на Task 1–2; severity по эффекту для пользователя. Единственный fix pass Critical/Important RED→GREEN, Minors deferred. Локальный pack/open, read-only проверка startup/профиля и встроенного runtime без GUI. PR 59 body перед последним push; CI на точный final HEAD. Архивировать evidence/hash, удалить только собственный scratch. Итог содержит путь app, результаты, ограничения и все ledger rulings.
