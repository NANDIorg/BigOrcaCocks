# Async workflow consumers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переключить Git effects workflow, запусков и приёмки на общий async executor/queue с EffectToken.

**Architecture:** Сначала async RunBranchServices с недостающими scoped Git primitives. Затем атомарный перенос взаимозависимых worker/review/task/run orchestration и Desktop/socket callers на Promise; старые алгоритмы удаляются после переключения. Scope не удерживается через deliberate store phase transition: перед ожиданием снимается позиция, после ожидания guarded sync commit и новый capture для следующей фазы. Все Git mutations идут той же commonDir queue. Persistent reconciliation и оставшиеся Git reads профиля/files — следующий связанный шаг B.

**Tech Stack:** Node24, TypeScript strict, pnpm, node:test, настоящие Git repositories/hooks, существующие launcher/session ports.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §7/11/12.

## Global Constraints

- Без Electron/Desktop/node-pty в runtime; без новых dependencies. Без Web/CLI UI/deployment.
- Git args без shell, owned process service и одна commonDir queue; не входить в queue повторно из callback.
- Сохранить unborn/detached/conflict/dirty/foreign branch, старые CLI/socket/IPC payloads, локализацию errors, данные JSON/backup.
- Guard актуальной project/run/node/visit/lane/dispatch после await до следующего effect. stale/forbidden не становятся feedback/blockStage нового этапа.
- Не держать status source через Promise; синхронные store phases сохраняют собственное авторство.
- Human/agent waits не удерживают Git queue. Cancel pending start до dispatch, не удалять чужие процессы/dirty files.
- Inline, без intermediate reviewer/pack. Итоговый reviewer/verify/pack/open после всех рубежей A–F.

## Review Focus

- Initial run branch metadata does not invalidate valid sibling lane position; own mutation still checks identity (Task1).
- Missing feature branch/unborn stops before task commit or worktree cleanup; detached/base remote branch behavior preserved (Task1/2).
- Background RunBranchSync does not deadlock on store observer reentry, skips reopened/live runs and preserves dirty files (Task1/2).
- Hook wait keeps PTY/API responsive; revoked policy/changed position prevents spawn/next store mutation, including errors (Task2).
- Native callback errors are awaited across attachments/socket/event/timer routes; preserved referenced files, no unhandled rejection (Task2).

---

### Task 1: Async run branch port

**Files:**
- Create: `packages/runtime/src/run-branch-async.ts`, `packages/runtime/test/run-branch-async.test.ts`.
- Modify: `packages/runtime/src/git-workflow.ts`, `effect-scope.ts`, `execution-resources.ts`, `index.ts`; scoped/effect tests; четыре docs/dashboard.

**Interfaces:**
- Consumes: EffectProject/EffectScopeService.capture; GitWorkflowService; existing RunGit/RunMergeResult/MergeTarget and ExecutionMessages.
- GitWorkflowReadRepository adds `head(ref?:string):Promise<string|undefined>`, `remotes():Promise<string[]>`, `checkedOutAt(branch:string):Promise<string|undefined>`, `isDirty(worktree:string):Promise<boolean>`.
- GitWorkflowRepository adds `addRunWorktree(worktree:string,branch:string,base:string):Promise<void>`, `pruneWorktrees():Promise<void>`, `removeCleanWorktree(worktree:string):Promise<boolean>`; no arbitrary raw shell/process method.
- `createAsyncRunBranchServices({messages,git,effects})` where git is Pick<GitOperations,'workflowGit'>. Produces `ensureRunBranch(project:EffectProject,runId:string|undefined):Promise<RunGit|undefined>`, `mergeTarget(project,task:Pick<Task,'runId'>):Promise<MergeTarget>`, `mergeRunBranch(project,runId:string,message:string):Promise<RunMergeResult>`, `reviewBase(project,task):Promise<string>`, `removeRunWorktree(project,runId:string):Promise<boolean>`, `RunBranchSync` with constructor `{isAlive:(ptyId:string)=>boolean}` and `sync(project:EffectProject):Promise<void>`; `runWorktreePath(root,runId):string`.
- ExecutionResources temporarily produces `effects:EffectScopeService` and `asyncBranches` on same Git owner. Task2 consumes them and removes legacy branch implementation/temporary alias. EffectToken covers domain position; RunBranchServices separately checks captured RunGit metadata inside queue, then commits new metadata after queue completes.

- [x] **Step 1: RED tests.** Real repo/worktree creates isolated feature branch without root switch/upstream, repeat idempotent; detached/unborn/startedWithoutBranch/inbox; restores removed worktree, missing branch rejects before mutation. Merge into checked-out or temporary base, remote base mapping, dirty/bad base/conflict retention. RunBranchSync live/reopened skip, nonforce dirty preservation, observer reentry never duplicates/hangs. Exact ref/files/store effects and held hook heartbeat/other repo/late run mutation. Sibling lane remains current after valid run Git metadata initialization; explicit replacement is rejected by branch port guard.
- [x] **Step 2: Run RED.** `node --test packages/runtime/test/run-branch-async.test.ts`; Expected FAIL because async factory/primitives absent (including effect scope metadata regression).
- [x] **Step 3: Implement.** Scoped head/remote/worktree/dirty helpers and nonforce remove/prune; Git -z worktree parsing keeps raw paths. Async branch algorithms keep legacy decisions; each queue callback gets one scoped repo, no nested transaction. Verify run identity/captured metadata on promotion and after await, store.setRunGit only after guarded Git completion. Pending/keepWorktree sets prevent observer reentry; unrelated repos parallel. Resources has one effects registry/async port, legacy callers unchanged until Task2.
- [x] **Step 4: GREEN/types.** `node --test packages/runtime/test/run-branch-async.test.ts packages/runtime/test/effect-scope.test.ts packages/runtime/test/git-workflow.test.ts packages/runtime/test/git-process.test.ts packages/runtime/test/import-boundaries.test.ts`; Expected PASS. Runtime/Desktop typechecks PASS.
- [x] **Step 5: Docs/tests/commit.** Four docs/dashboard show async port and integration still pending. Core and bare runtime suites PASS. Inspect/stage exact files/commit `refactor: перевести ветки прогонов на общий async Git port`; task-done command Step4.

### Task 2: Switch all execution consumers and Desktop/socket

**Files:**
- Modify: runtime `workers.ts`, `worker-operations.ts`, `coordinator-operations.ts`, `review.ts`, `review-operations.ts`, `workflow.ts`, `workflow-run.ts`, `workflow-services.ts`, `attachments.ts`, `execution-resources.ts`, command adapters for worker/coordinator/review/human requests.
- Modify: contracts worker/coordinator/review/human-request command results to Promise; preserve synchronous stop/read-only core calls.
- Modify: Desktop `main/index.ts`, existing Git/run-branch/workflow/worker/review/attachment facades, operator adapters and socket handlers.
- Modify: affected runtime/Desktop fixture/helpers/tests to await changed effect methods and use assert.rejects for async failures; no fake Promise around blocking production Git. Create `packages/runtime/test/async-execution.test.ts` for actual effect interleavings.
- Remove: legacy `run-branch.ts` body replaced by async service exports/types; unused sync workflow Git algorithms only once no consumer remains. Four docs/dashboard and skill prompt guards if agent semantics change.

**Interfaces:**
- Consumes Task1 asyncBranches/effects/scoped primitives. WorkflowDeps/RunWorkflowDeps add optional `projectId`/`isCurrent`, launcher callbacks accept old synchronous test host or Promise; production caller awaits either. Host public worker.start/coordinator.start/review/request effect methods return Promise; trusted socket accepts sync test double or Promise and awaits before serializing nested results.
- TaskWorkflowServices enterWork/advance/handleEvents/resume/reviewAccept/reviewReject/approvalResolved become Promise; pure taskEngine remains sync. RunWorkflowServices stage/effect/decision methods become Promise; isRunScope/isRunGate/isRunDecider/hasIdleStage/escalateDecision remain sync where no async dependency.
- Async commands use AsyncProjectCommandHost.isCurrent and createAsyncProjectCommandExecutor; scope/policy guard composed with EffectProject.isCurrent. Explicit stop cancels pending task/run before killing active dispatch. Store phases commit sync with captured source; workflow store phases are workflow source.
- Async attachments callback result is awaited before cleanup of unreferenced files; referenced files remain after durable decision/failed launch. For synchronous validations on legacy trusted routes behavior/messages remain unchanged.
- Stage options await branch head before guarded synchronous core transition; settleIdleStages precomputes candidate head metadata and validates candidate positions without putting Promise into core callback. Event handlers/timers catch their returned Promise and log only current failures; stale native results never block a new stage.

- [x] **Step 1: RED integration tests.** Actual held checkout/commit hook on worker start, review merge and task/run Git nodes: heartbeat/second repo proceed; changed visit/lane/dispatch/deleted registration/revoked policy prevents next spawn/store/cleanup. Explicit stop while ready cancels hook and queue promotion. Real review conflict retains branch/worktree; stale failure does not write feedback/blockStage. Two concurrent launches produce one dispatch; real async attachment failure removes only unreferenced return folder. Legacy socket awaits start/reopen nested worker, review accept and stage finish; event/timer failures are handled.
- [x] **Step 2: Run RED.** `node --test packages/runtime/test/async-execution.test.ts`; Expected failure from synchronous blocking/late effects or absent async binding.
- [x] **Step 3: Migrate linked consumers.** Change existing algorithms, no permanent duplicates. Async RunBranchServices become authoritative resources. Recapture token after deliberate store phase, guard native/Git results outside error formatting, stop cancels pending scope. Compound review Git uses one transaction. Replace sync branchHead with port, wrap only sync store phases in source. Update host Promise chain/attachments/socket handlers; rewire existing tests without changing literal expectations.
- [x] **Step 4: GREEN/affected/types.** `node --test packages/runtime/test/async-execution.test.ts packages/runtime/test/workers.test.ts packages/runtime/test/worker-preparation.test.ts packages/runtime/test/review.test.ts packages/runtime/test/review-services.test.ts packages/runtime/test/workflow-git.test.ts packages/runtime/test/workflow-run.test.ts packages/runtime/test/workflow-services.test.ts packages/runtime/test/task-workflow-services.test.ts packages/runtime/test/run-workflow-services.test.ts packages/runtime/test/worker-commands.test.ts packages/runtime/test/coordinator-commands.test.ts packages/runtime/test/review-request-commands.test.ts packages/runtime/test/attachments.test.ts`; Expected PASS. Desktop affected suites with existing TS loader and full typecheck PASS.
- [x] **Step 5: Full verify/docs/commit.** Four docs/dashboard reflect actual integration and remaining reconciliation/profile/file Git reads. `pnpm verify` PASS (includes core docs/CLI guards/build). No native pack yet. Inspect/stage exact files/commit `refactor: подключить async effects к workflow и Desktop`; task-done command Step4. Continue remaining B then C–F without handoff.
