# Общие команды review и human requests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести review, ответы на вопросы и human requests на общий scoped command API, сохранив прежнюю Git/workflow/attachments семантику Desktop и agent socket.

**Architecture:** Browser-safe contracts, существующий executor для policy/context/validation/attribution; trusted ReviewOperations повторно используют WorkflowServices, ExecutionResources и TaskWorkerLifecycle. Desktop фиксирует project/caller на своей границе, socket сохраняет старые ошибки/envelope.

**Tech Stack:** Node24, TypeScript strict, pnpm/node:test, настоящий Git/JSON/workflow/launcher с fake native PTY.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md` §§3–7/11–12. Общий статус — `docs/orca-foundation-progress.md`.

## Global Constraints

- Назначенный worktree `/private/tmp/orca-web-migration-audit`, branch `feature/web-migration-audit`, BASE `f7e429defdcf4453819a13aef90a775c9cab1459`.
- Contracts browser-safe, runtime без Desktop/Electron/node-pty; версии/CLI HELP/IPC signatures/JSON сохраняются.
- Существующий workflow/router/Git/attachment rollback переиспользуется; клиент не устанавливает server paths.
- Inline исполнение без промежуточного approval; fresh review оставшейся базы после всех рубежей, не отдельное пользовательское поручение после этого переноса.

## Review Focus

- Чужой task/question/request id не меняет соседний store/Git/PTY; policy и payload до lookup/effects.
- Принятие stale/cancelled/уже решённого ответа отказывает до Git/attachments; существующие guards сохраняются.
- Ложные resolution.images из Desktop/socket отбрасываются; новый public input не принимает server paths. Ошибка после записи удаляет только orphan файлы, durable feedback сохраняется.
- Review обычной задачи и run gate идут через прежний router без двойного запуска; taskless approval/decision остаются run-scoped.
- Dead/mixed dispatch сверяются до human answer; ответы сохраняют источник human/cli/app и отделённый DTO, start failure сохраняет принятое решение и escalation.

### Task 1: Contracts, commands и trusted orchestration

**Files:** create `packages/contracts/src/review-commands.ts`, `human-request-commands.ts`; create runtime `review-operations.ts`, `review-commands.ts`, `human-request-commands.ts`; modify contracts/runtime barrels и project command errors, `apps/desktop/src/main/strings/ru.ts` и `en.ts` для нового error union; tests `packages/runtime/test/review-request-commands.test.ts` и fixture.

**Interfaces:**
- Produces: `ReviewCommands.info(context,taskId):ReviewInfo`, `.accept(context,taskId,text?):Task|undefined`, `.reject(context,taskId,feedback,images?):Task|undefined`.
- Produces: `HumanRequestCommands.list(context,opts?):HumanRequest[]`, `.resolve(context,id,resolution:Omit<RequestResolution,'images'>,images?):RequestResolveResult`, `.answer(context,questionId,answer):Question`.
- Produces: `ReviewProject {store,root,workflow:RunWorkflowDeps}`; `createReviewOperations(host).info/decide/resolve/answer` с project первым аргументом. Host содержит WorkflowServices, ExecutionResources, syncWorkerLiveness и attachment error port.
- Consumes: существующие project executor, attachment validator, WorkflowServices.forProject, resources.rejectWithImages/resolveWithImages и TaskWorkerLifecycle.

- [x] **Step 1:** Написать tests с assertion отсутствующих factories: изоляция A/B, policy/context/invalid fields/sparse attachments до lookup; настоящий info/merge/reject, question/requests list и actor source; закрытый/чужой запрос, taskless run approval/decision, dead/mixed liveness, attachments path injection/rollback и start failure.
- [x] **Step 2:** `node --test packages/runtime/test/review-request-commands.test.ts`; Expected: FAIL factory assertion, import работает.
- [x] **Step 3:** Реализовать interfaces с общим router и strict input; добавить стабильные request/question not-found errors. Public resolution запрещает images; trusted путь использует прежний strip/guards. Не менять workflow engine.
- [x] **Step 4:** Runtime/contracts typecheck, targeted tests и package suites. Expected: PASS, соседние store/process/Git нетронуты.
- [x] **Step 5:** Проверить diff/staged diff и commit точных paths; task-done `pnpm --filter @orca-board/runtime test`, Expected PASS.

### Task 2: Desktop и legacy socket

**Files:** create `apps/desktop/src/main/review-request-commands.ts` и `.test.ts`; modify main/index.ts, socket.ts, docs architecture/nested-kanban/human-requests/workflow; общий status document.

**Interfaces:**
- Consumes Task1 factories и DesktopProjectCommandAdapter.
- Produces `registerDesktopReviewRequestCommands(handle,{review,requests,activeProjectId,clientId})` с прежними шестью каналами: review:info/accept/reject, questions:answer, requests:list/resolve. No-selection list=[]; accept остаётся void, caller до selection. Старые resolution.images вырезаются на adapter границе.
- Main socket callbacks используют trusted operations; exported socket answerQuestion делегирует общему helper, реальный PTY port сохраняется.

- [x] **Step 1:** Failing adapter tests на caller/no project/selection capture, Git/DTO/источник/legacy image stripping/localized errors; scaffold только `export {}`.
- [x] **Step 2:** `node --experimental-transform-types --no-warnings --import ./apps/desktop/test/ts-resolve.mjs --test apps/desktop/src/main/review-request-commands.test.ts`; Expected FAIL register factory assertion.
- [x] **Step 3:** Adapter и real wiring, remove местной orchestration; обновить четыре docs и статус вместе с реализацией.
- [x] **Step 4:** Desktop typecheck и полный `pnpm verify` под Node ABI. Expected all PASS; никакого GUI automation.
- [x] **Step 5:** Проверить diff/staged diff, commit точных paths; task-done повторяет targeted command. Затем перейти к следующему рубежу A, без финального ответа пользователю/перезапуска всего плана.

Проверки переноса: runtime695, contracts50, core943; Desktop adapter10. Полный verify
3675/3675 (scripts49, core943, CLI38, contracts50, runtime695, Desktop1900), typecheck
и build PASS; fail/cancel/skip0. Последующие рубежи продолжаются по общему журналу.
