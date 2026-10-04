# Workflow EffectToken scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Общая проверка актуальности project/run/node/visit/lane/dispatch после async Git и перед записью store или запуском процесса.

**Architecture:** Owner создаёт EffectScopeService. Capture сохраняет identity существующего store/run/task и значения позиции отдельно от изменяемых объектов. Scope даёт guard, AbortSignal, checked await и синхронный commit с заданным status source; transaction/read соединяются с уже проверенным GitWorkflowService. Explicit cancellation завершает pending scoped Git; следующий consumer перенос заменит sync workflow/worker/review без дублирования правил. Persistent reconciliation — отдельный связанный шаг B.

**Tech Stack:** TypeScript strict, Node24 AbortController/AbortSignal, core TaskStore/runPositions, node:test и настоящий Git hook. Без dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §7/12.

## Global Constraints

- Runtime production graph без Electron/Desktop/node-pty; no daemon/import-time startup.
- Token host-owned: DTO не разрешает effects, mutable store refs не подменяют snapshot счётчиков.
- Guard до/после await и перед native/store effect; no status source через Promise.
- Lane проверяется по id и forkVisit, соседний lane не отменяет текущий; неоднозначная позиция требует laneId.
- Stop/cancel не запускают повторно native side effects; уже случившийся commit остаётся для reconciliation.
- JSON/backup/schema сейчас не меняются; полноценное подключение consumers и persistent restart reconciliation остаются в B.
- Inline автономно, один reviewer и pack/open по итогам всей задачи.

## Review Focus

- Mutable node/visit, dispatch replacement, task/run recreation with same id → stale before write (Task1).
- Fork generation reuses lane id/node → stale; neighbor advances → current (Task1).
- Explicit stop when task status already ready cancels actual pending Git and releases queue (Task1).
- Checked rejection is stale after stage change, domain/native error preserved when current (Task1).
- Concurrent status attribution and caller-mutated exposed token cannot authorize writes (Task1).

---

### Task 1: Effect scopes linked to shared async Git

**Files:**
- Create: `packages/runtime/src/effect-scope.ts`, `packages/runtime/test/effect-scope.test.ts`.
- Modify: `packages/runtime/src/index.ts`, четыре инженерных docs и `docs/orca-foundation-progress.md`.

**Interfaces:**
- Consumes: core `TaskStore.getTask/getRun`, `runPositions/runPositionAt`, `withStatusSource/source`; runtime `CommandError`, `GitWorkflowService.transaction/read`.
- Produces: `EffectProject {id:string;root:string;store:TaskStore;isCurrent?:()=>boolean}`, `EffectTarget {taskId?:string;runId?:string;nodeId?:string;laneId?:string}`, `EffectOptions {signal?:AbortSignal;source?:StatusSource}`.
- `EffectToken` readonly `{projectId,repoRoot,taskId?,runId?,nodeId?,visit?,laneId?,forkVisit?,dispatchId?}`: immutable detached descriptive value; task's own position/status/branch and parent run/lane also checked from captured primitives.
- `createEffectScopeService():EffectScopeService` with `capture(project,target?,options?):EffectScope`, `cancelTask(projectId,taskId):void`, `cancelRun(projectId,runId):void`, `stop():void`.
- `EffectScope {readonly token:EffectToken;readonly signal:AbortSignal;guard():void;wait<T>(operation:()=>Promise<T>):Promise<T>;commit<T>(operation:()=>T):T;transaction<T>(git:GitWorkflowService,operation:(repo:GitWorkflowRepository)=>Promise<T>):Promise<T>;read<T>(git:GitWorkflowService,operation:(repo:GitWorkflowReadRepository)=>Promise<T>):Promise<T>;close():void}`. guard throws `CommandError('command.stale')` for invalid/closed/cancelled scope. capture missing task/run throws corresponding CommandError. Ambiguous/mismatched node/lane/run target throws command.conflict.

- [ ] **Step 1: Write RED tests.** Real TaskStore: task node/visit/status/dispatch/run change rejects commit; same-id task/run recreated rejects; project registration/root change rejects. Token copied primitives cannot be modified to revive scope. Run lanes same node require id, own visit/fork generation change rejects, neighbor move stays valid. Checked rejected await preserves current cause but after position change throws stale. Concurrent scopes commit status history with own source and do not leak attribution into unrelated store action. CancelTask/Run/stop/parent AbortSignal reject before queued Git; actual held commit cancel preserves files/ref, prevents next branch/spawn/store write and unblocks next queued job; other repo proceeds.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/effect-scope.test.ts`; Expected FAIL because factory absent.
- [ ] **Step 3: Implement.** Snapshot task/run refs + primitive execution positions, exact lane lookup/fork generation; reject mismatched target. Track only open scopes, close/cancel abort and release registry; stop rejects capture. Scope wait checks before invocation and after settled result, guard outside native catch. commit checks synchronously and applies source only during callback. Link Git transaction/read using project bound root + guard/signal, without another queue.
- [ ] **Step 4: GREEN/affected/types.** `node --test packages/runtime/test/effect-scope.test.ts packages/runtime/test/git-workflow.test.ts packages/runtime/test/git-process.test.ts packages/runtime/test/git-operation-queue.test.ts packages/runtime/test/import-boundaries.test.ts`; Expected PASS. `pnpm --filter @orca-board/runtime typecheck`; Expected exit0.
- [ ] **Step 5: Docs/core/runtime and commit.** Docs describe available scope without claiming consumers/restart complete. `pnpm --filter @orca-board/core test` and `pnpm --filter @orca-board/runtime test`; Expected PASS. Inspect git diff/cached, commit exact files `refactor: добавить общий EffectToken для async workflow`. task-done runs affected command Step4.
