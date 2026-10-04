# Очередь Git по canonical commonDir

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** root, linked worktree и symlink одного repo используют одну очередь мутаций; независимые repo исполняются параллельно.

**Architecture:** canonicalGitCommonDir асинхронно выполняет rev-parse аргументами без shell и realpath. Owner владеет GitOperationQueue; factory Git получает её явно или создаёт локально. Existing async project mutations используют canonical key. Это первый перенос B; synchronous workflow/worker/review Git и EffectToken/reconciliation следуют отдельными планами, B пока не завершён.

**Tech Stack:** Node24, strict TS, node:child_process execFile, fs/promises, pnpm10.33.0, node:test; без новых dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md` §7/12; `docs/orca-foundation-progress.md` B.

## Global Constraints

- Назначенный feature worktree, native inline; один final whole-foundation reviewer после B–F, без handoff/pack каждого плана.
- Runtime без Desktop/Electron/node-pty, contracts browser-safe; no any/as any/console.log; docs4/dashboard с кодом.
- Git без shell, canonical probe async с timeout30000ms/maxBuffer16MiB; ошибку repo factory переводит в существующий git.notRepo.
- Queue содержит только текущие операции, не ожидание человека/agent events. Не обещает rollback/exactly-once; guards команд остаются до внешних mutations.
- Не менять версии, JSON/schema/paths пользователя, CLI HELP/envelope, release/feed. Полный async workflow и installed headless proof остаются обязательными.

## Review Focus

- Symlink и linked worktree одного repo: очередь общая, очередь чужого repo не задерживается — тест1/2.
- Failed job освобождает слот, последующий commit проходит; нет rejected Promise без handler — тест3.
- Настоящий Git hook ждёт gate: event loop/PTY работают, другие repo коммитятся — тест4.
- Невалидный repo/удалённая directory не вызывают mutation; локализованный git.notRepo сохраняется — тест5.
- Registration/policy изменены пока job queued: root HEAD/index остаются прежними — тест6 и существующие project commands tests.

### Task 1: Canonical queue и подключение project mutations

**Files:** create `packages/runtime/src/git-operation-queue.ts`, `packages/runtime/test/git-operation-queue.test.ts`, fixture helper `packages/runtime/test/git-queue-fixture.ts`; modify `packages/runtime/src/git.ts`/`index.ts`, docs4/dashboard/plan.

**Interfaces:** `canonicalGitCommonDir(root:string):Promise<string>` возвращает realpath Git commonDir. `createGitOperationQueue():GitOperationQueue`, `enqueue<T>(canonicalCommonDir:string, operation:()=>Promise<T>):Promise<T>` сериализует только одинаковые ключи, failure не отравляет очередь. `createGitOperations(messages, queue?:GitOperationQueue)` использует owner queue в serial после async canonical lookup; lookup failure → messages.error('git.notRepo',{path:root}). Existing methods/DTO/guard callbacks сохраняются.

- [ ] **Step 1:** Real temp Git root + linked worktree + symlink (junction Windows), actual refs/index: equal canonical key; held queue mutation blocks project initialCommit alias/worktree, independent B succeeds; rejection allows next actual ref update. Actual pre-commit Node gate fixture proves heartbeat/session output while Git waits. Non-repo errors and queued stale registration/policy leave HEAD/index intact.
- [ ] **Step 2:** `node --test packages/runtime/test/git-operation-queue.test.ts`; Expected FAIL missing exported queue/canonical resolver.
- [ ] **Step 3:** Implement async canonical resolver, owner FIFO Promise tail map with cleanup on success/failure; inject queue into Git factory and replace rootQueues. Preserve current runGit formatting/stdin/timeouts and command guards. No sync-to-async workflow signature changes in this plan.
- [ ] **Step 4:** `node --test packages/runtime/test/git-operation-queue.test.ts packages/runtime/test/project-run-agent-commands.test.ts packages/runtime/test/git.test.ts packages/runtime/test/import-boundaries.test.ts`; runtime/Desktop types and core docs. Expected PASS; add existing Desktop Git suite for old errors/checkout/initialCommit. No full verify repeat until next integrated async transfer requires it.
- [ ] **Step 5:** Diff/staged diff, code+tests+docs commit; task-done affected suite. Dashboard B stays in progress, continue async backend/effect identity.

Self-review: actual queue is consumed by existing project mutations, not an unused alternative. Canonical key is filesystem/Git identity, not display root. Pending Promise tails are dropped after last operation; no persistent lock, timer, global selection or worker wait introduced. Full B requires later async launch/review/workflow and EffectToken/reconciliation.
