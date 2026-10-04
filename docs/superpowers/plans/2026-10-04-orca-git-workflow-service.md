# Async Git workflow service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать workflow/worker/review общий async Git API для многошаговых эффектов с общей очередью repo и guard после каждого subprocess await.

**Architecture:** `GitWorkflowService.transaction` удерживает commonDir queue на время последовательных локальных Git шагов. Callback получает scoped repository port, его методы сами не входят повторно в очередь. Read-only `read` использует тот же executor/guard без queue. Этот port создаётся existing owner factory на том же GitProcessService/queue; Desktop пока сохраняет sync consumers до следующего связанного переноса B.

**Tech Stack:** Node24 process API, TypeScript strict, реальные Git fixtures/node:test, без новых зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §7/12.

## Global Constraints

- Runtime production graph без Electron/Desktop/node-pty; legacy agent CLI/IPC signatures сохраняются.
- Один canonical commonDir queue и process executor на owner; разные repo параллельны.
- Аргументы Git напрямую без shell; cancellation/timeout/bounded output наследуются от GitProcessService.
- Guard выполняется перед и после await; stale/forbidden не форматируются как Git failure и не запускают следующий effect.
- Пауза человека/PTY/events не входит в transaction. Внешние effects после отмены не обещают rollback/exactly-once.
- Foreign branch не удалять, detached/unborn/conflict/dirty/upstream поведения сохранить.
- Scope этого плана — port. Переключение workflow consumers, EffectToken/reconciliation выполняются следующим B переносом; весь B не объявлять готовым.
- Inline уже разрешено; reviewer/pack только после всей задачи.

## Review Focus

- Вложенные helper calls scoped port не должны повторно занимать очередь; реальные branch/worktree/merge tests Task1.
- После held hook + stale guard Git effect может уже случиться, следующий ref/store effect обязан отсутствовать; Task1.
- Ошибка merge с настоящим conflict abort оставляет ветку и worktree доступными; Task1.
- Cleanup foreign branch сохраняет branch и commit, грязное дерево не переносит файлы; Task1.
- Linked worktree/symlink share queue, другая repo выполняется параллельно; Task1.

---

### Task 1: Scoped async Git workflow port

**Files:**
- Create: `packages/runtime/src/git-workflow.ts`, `packages/runtime/src/git-errors.ts`, `packages/runtime/test/git-workflow.test.ts`.
- Modify: `packages/runtime/src/git.ts`, `packages/runtime/src/index.ts`, `apps/desktop/src/main/git.ts`.
- Modify: четыре инженерных docs, `docs/orca-foundation-progress.md`.

**Interfaces:**
- Consumes: `GitMessages`, `GitOperationQueue.enqueue`, `canonicalGitCommonDir(root, processes)`, `GitProcessService.run`.
- Produces: `createGitWorkflowService(messages, queue, processes): GitWorkflowService`, `GitWorkflowOptions {guard?:()=>void; signal?:AbortSignal}`.
- Service: `transaction<T>(root:string, operation:(repo:GitWorkflowRepository)=>Promise<T>, options?:GitWorkflowOptions):Promise<T>`; `read<T>(root:string, operation:(repo:GitWorkflowReadRepository)=>Promise<T>, options?:GitWorkflowOptions):Promise<T>`.
- Scoped repo bound root: async `currentBranch()`, `hasCommits()`, `assertHasCommits()`, `headBase()`, `localBranchExists(branch)`, `isBranchNameAcceptedByGit(name)`, `worktreeBranch(worktree)`, `reviewInfo(worktree,branch,base?)`.
- Mutating scoped methods: async `addTaskWorktree(worktree,branch,base?)`, `commitWorktree(worktree,message)`, `mergeBranch(cwd,branch,message)`, `removeWorktreeKeepBranch(worktree)`, `removeWorktree(worktree,branch,foreign?)`, `gitCreateBranch(worktree,branch,base,own)`, `gitCheckout(worktree,branch)`, `gitCommit(worktree,message)`, `gitPush(worktree,remote,branch)`.
- `createGitOperations` produces `workflowGit` using exactly its queue/processes; Desktop facade exports that port from same singleton. Existing error exports/import paths preserved via `git-errors.ts` re-export.

- [ ] **Step 1: RED tests.** Real repo branch→worktree→commit→review→merge→cleanup verifies HEAD/files/ref deletion and no nested queue hang. Real conflict verifies MergeError/conflict and abort/retained worktree. Dirty checkout and foreign cleanup preserve bytes/ref. Held hook transaction + alias job + independent repo verifies queue and heartbeat; flip guard before release verifies native commit may exist but following ref operation does not. Actual push to local bare remote verifies remote ref/upstream, unborn rejected before worktree.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/git-workflow.test.ts`; Expected FAIL — `workflowGit`/`createGitWorkflowService` absent.
- [ ] **Step 3: Implement port and wire owner factory.** Move only Git error types/classes to dependency-free module, retain exports. Scoped subprocess executes via same process service, guard outside native failure formatting catches. Branch helpers accept only actual exit1 as absence; preserve existing workflow messages and merge abort. `read` passes only read port, `transaction` captures canonical key and checks guard on promotion and completion; no queue nesting. No consumer flags claiming legacy workflow async yet.
- [ ] **Step 4: GREEN/affected/types.** `node --test packages/runtime/test/git-workflow.test.ts packages/runtime/test/git.test.ts packages/runtime/test/git-operation-queue.test.ts packages/runtime/test/git-process.test.ts packages/runtime/test/project-git-async.test.ts packages/runtime/test/import-boundaries.test.ts`; Expected all PASS. Runtime/Desktop typechecks; Expected exit0.
- [ ] **Step 5: Docs/core/bare runtime and commit.** Four docs/dashboard record completed port and remaining consumers/token/reconciliation. `pnpm --filter @orca-board/core test`, `pnpm --filter @orca-board/runtime test`; Expected all PASS. Diff/stage specific files/commit `refactor: добавить общий async Git API для workflow`. task-done runs affected tests from Step4.
