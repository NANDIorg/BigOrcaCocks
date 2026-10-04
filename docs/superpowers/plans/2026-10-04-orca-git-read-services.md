# Оставшиеся async Git reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Удалить вторую синхронную реализацию Git; сделать profile/docs/preview неблокирующими без изменения файлов/DTO/истории.

**Architecture:** Именованные compatibility methods GitOperations делегируют одному workflowGit.read/transaction; compound production consumers уже используют scoped port напрямую. ProjectManager.add сначала ждёт проверку root общим GitProcessService, затем выполняет guarded sync сохранение. Profile.addProject использует async client executor и проверяет policy до сохранения. Docs используют тот же инъецируемый process service; обычные best-effort ошибки чтения сохраняют fallback, cancellation не подавляется.

**Tech Stack:** Node24, TypeScript strict, pnpm/node:test; настоящие Git repositories, controlled injected process adapter for held read (Git не поддерживает hooks для symbolic-ref/ls-files).

**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md §7/11/12.

## Global Constraints

- Текущий назначенный worktree; inline, без intermediate reviewers/pack/вопросов.
- Без shell и execFileSync Git в production runtime. Async scoped implementation остаётся единственной; не вводить тестовую вторую реализацию Git.
- Plain agent CLI dependency-free, Desktop UI/IPC payloads сохраняются. Нет Web/CLI UI/deploy/release.
- Сохранить dirty/foreign/unborn/detached/remote/error semantics; stale/cancellation не маскировать fallback.
- Только чтение до async guard; никакого сохранения registration/active после отзыва principal. Время ожидания не удерживает глобальный source.
- Persistent reconciliation остаётся следующим шагом B; C–F далее без handoff.

## Review Focus

- Compatibility methods не создают второй queue/process owner; compound production code не вызывает aliases из transaction.
- Docs Git cancellation не превращается в fallback file walk или пропуск группы.
- Add проверяет policy после root read и до save; параллельные одинаковые adds не создают дубликатов.
- Source/tests сохраняют literal expectations; отказ stop Git проверяется независимым реальным чтением диска, а не использованием остановленного service.

### Task 1: Один async Git implementation

**Files:** runtime src/git.ts; Desktop main/git.ts/index.ts; affected runtime/Desktop git tests; четыре docs/dashboard.

**Interfaces:** GitOperations сохраняет имена legacy helper методов с Promise результатами; workflowGit создаётся один раз на том же injected queue/process. read helpers делегируют read, mutation helpers transaction, pure taskWorktreePath/setupCommand остаются sync. projectBranchInfo делегирует projectBranchInfoAsync. Production preview branch допускает Promise уже сейчас.

- [ ] **Step 1: RED.** Добавить actual factory compatibility test: mutation с held commit hook возвращает Promise, heartbeat/другой repo идут, следующий job того же commonDir ждёт. Type/guard test подтверждает cancel не превращается в false/empty DTO.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/git-compatibility.test.ts`; Expected FAIL legacy method blocks/returns sync.
- [ ] **Step 3: Implement.** Удалить legacy execFileSync Git body; thin Promise aliases к scoped port, чистые FS/path helpers сохранить. Мигрировать затронутые fixtures/callers к await/rejects, literal проверки сохранить. Stopped owner regression проверяет независимым Git probe отсутствие HEAD.
- [ ] **Step 4: GREEN/types.** `node --test packages/runtime/test/git-compatibility.test.ts packages/runtime/test/git.test.ts packages/runtime/test/git-process.test.ts packages/runtime/test/git-workflow.test.ts`; Desktop gitBranch/initialCommit tests и полный types PASS.
- [ ] **Step 5: Docs/core/commit.** Четыре docs/dashboard описывают single async Git; core tests PASS. Inspect/stage exact diff; commit `refactor: удалить синхронный дубликат Git`; task-done Step4.

### Task 2: Async profile/docs Git reads

**Files:** runtime src/projects.ts/profile-commands.ts/docs.ts; contracts ProfileCommands.addProject; Desktop startup/profile adapters/doc facade; affected fixtures/tests; четыре docs/dashboard.

**Interfaces:** createProjectServices host adds optional processes:GitProcessService; ProjectManager.add(path,typeId?,select?,guard?)=>Promise<Project> validates root then calls guard before synchronous lookup/type validation/save. createDocServices deps adds optional processes; listWorktreeDocs=>Promise<DocFile[]>; existing public listDocGroups/listProjectFiles remain Promise. Profile.addProject uses createAsyncClientCommandExecutor(host), scope.guard passed to manager.add; other profile methods remain sync. Production Desktop awaits ORCA_REPO add before subsequent startup logic.

- [ ] **Step 1: RED.** Held actual-result process port: root read heartbeat remains responsive; revoke policy/remove owner authority during read rejects before projects.json/selection changes. Two concurrent same-root adds give one registration; actual invalid repo/unborn/root subdir cases preserved. Docs held ls-files/diff read returns Promise, abort/stop propagates through worktree/groups/project fallback; normal missing base/unborn still best-effort.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/git-read-services.test.ts`; Expected FAIL synchronous add/docs or lost cancellation.
- [ ] **Step 3: Implement.** Owned async process reads, guarded sync manager registration, async profile boundary and complete callers. Switch docs execFile/execFileSync to processes.run preserving NUL/limits/order/fallback and cancellation. Migrate fixtures/helpers; no any/test relaxations.
- [ ] **Step 4: GREEN/types.** New read regression, projects/profile/docs/file suites PASS; Desktop project/profile/docs/task-types affected suites and full types PASS.
- [ ] **Step 5: Full verify/docs/commit.** Четыре docs/dashboard state sync Git reads eliminated; reconciliation still pending. `pnpm verify` PASS; commit `refactor: перевести Git чтения профиля и документов на async`; task-done exact affected runtime command. Continue journal/reconciliation B.
