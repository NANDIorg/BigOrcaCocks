# Журнал внешних операций и восстановление Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** После аварии owner не повторяет неизвестный Git/PTY/file effect автоматически; оператор видит факты и явно разрешает дальнейшие действия.

**Architecture:** Версионированный атомарный JSON journal профиля хранит intent до запуска native эффекта, native completion и подтверждение после persistence. Git port сообщает только о mutating commands; EffectScope связывает записи с неизменяемой позицией и подтверждает их после sync commit. Startup читает journal под profile lease до backups/migrations; reconciliation только читает Git/store и не удаляет ресурсы. Общий operator API разрешает неизвестную запись по revision, не повторяя effect самостоятельно.

**Tech Stack:** Node24, TypeScript strict, existing writeFileAtomic, node:test; настоящие Git/worktree, дочерний процесс и временные профили.

**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md §5–7/12.

## Global Constraints

- Назначенный worktree, inline; один whole-range reviewer и pack после B–F. Не менять UI, legacy agent CLI, версии/теги/публикацию.
- Journal version1, файл `effect-journal.json`; отсутствие допустимо для прежних профилей. Corrupt/future journal отвергается без записи/quarantine; owner lease приобретается первым.
- Не обещать атомарность Git+JSON или exactly-once. Crash между native completion и metadata checkpoint остаётся uncertain.
- Записи не содержат prompt, env, stdout/stderr, credential, содержимое файла или commit message. Только kind/operation/root/cwd/resource identity/position/phase/время.
- Сохранять dirty/foreign branch и пользовательские файлы; inspection не запускает prune/remove/kill. Другой visit/dispatch/созданная заново карточка не принимает старый результат.
- Pending journal entries не вытесняются: максимум1024 незавершённых и256 завершённых записей; при исчерпании refuse new effect до запуска. Никакого import/start I/O.
- По просьбе пользователя: только значимые локальные RED→GREEN на внутренних задачах; full verify/core/review/pack один раз после B–F. Четыре docs/dashboard обновляются вместе с крупным блоком; task-done использует фактический последний receipt без повторного прогона.

## Review Focus

- Ошибка записи intent предотвращает native запуск; ошибка checkpoint после Git сохраняет unknown и не разрешает слепой retry.
- Завершившийся Git hook при stale scope остаётся в journal, поздний результат не изменяет новую позицию.
- Нормальная ошибка Git сохраняет прежний workflow error route; её durable block/error commit подтверждает запись, restart gap остаётся uncertain.
- Отдельные lanes и scopes не подтверждают чужую незавершённую операцию; mutable EffectTarget не ослабляет captured guard.
- Импорт без profile I/O, несогласованная схема до backup, capacity и orphan inspections не теряют пользовательские ресурсы.

### Task 1: Persistent journal и read-only inspection

**Files:** Create runtime src/effect-journal.ts/effect-reconciliation.ts; export index.ts; tests effect-journal/effect-reconciliation; четыре docs/dashboard.

**Interfaces:** `createEffectJournal({dataDir, ownerId, maxPending?, maxCompleted?}):EffectJournal`; position содержит repoRoot, optional projectId/taskId/runId/nodeId/visit/laneId/forkVisit/dispatchId/taskCreatedAt/runCreatedAt. `begin(position, effect):id`, `nativeCompleted(id)`, `applied(ids)`, `pending(position?)`, `assertClear(position)`, `resolve(id, expectedRevision, resolution):record`. Resolution `'retry'|'acknowledge'|'abandon'` только записывает решение оператора. Records имеют id/revision/ownerId/phase/effect/position/createdAt/updatedAt; external kind `'git'|'pty'|'files'`. `inspectEffectRecovery(journal, project, processes):Promise<EffectRecoveryReport>` читает refs/worktrees/dirty и проверяет task/run generation; не сохраняет state.

- [ ] **Step 1: RED.** Write tests real temp profile: empty import/no file; atomic persisted phases/reload; corrupt/future bytes untouched; detached returned DTO; stale revision resolution; pending capacity refuses before callback; completed bounded, pending retained. Inspection actual orphan/dirty/foreign worktree + removed/recreated task returns facts and leaves refs/files/JSON byte-identical.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/effect-journal.test.ts packages/runtime/test/effect-reconciliation.test.ts`; Expected FAIL missing implementation/export.
- [ ] **Step 3: Implement.** Strict JSON validation/version refusal; clone/freeze captured data, publish memory only after write success. Compare position/generation for mutation fence, no automatic resolution. Read-only Git probes use injected owned async process, cancellation propagates.
- [ ] **Step 4: GREEN/types.** Same two test files plus runtime typecheck; Expected PASS. Four docs/dashboard and core tests PASS.
- [ ] **Step 5: Commit/done.** Inspect exact diff, commit `feat: добавить журнал внешних операций и сверку ресурсов`; ledger completion по последнему Step2 receipt.

### Task 2: Git/EffectScope tracking и guarded checkpoints

**Files:** runtime src/git-workflow.ts/git.ts/effect-scope.ts/execution-resources.ts; affected run-branch async callers; tests effect-recovery-integration/effect-scope/git-workflow; четыре docs/dashboard.

**Interfaces:** GitWorkflowOptions receives `onMutation(effect):{completed():void;failed():void}`; callback before real mutating process, no callback for read/precondition failure. Optional owner fallback observer in createGitOperations covers unscoped project mutations; scoped observer overrides it. ExecutionResources optional `journal:()=>EffectJournal|undefined`; EffectScope adds `external(kind,operation,resource,fn)` for synchronous native effects and checkpoint acknowledgement after successful commit. Nested native completion can be acknowledged only by same-owner exact matching position and explicit commit; unpaired cleanup uses explicit native checkpoint.

- [ ] **Step 1: RED.** Actual held hook + scope change + journal reload leaves pending and no metadata write. Child exits after real Git before commit; second owner fence prevents automatic duplicate until revision-checked resolution. Journal failure before native leaves refs unchanged; checkpoint failure does not mark applied. Two scopes/lanes cannot acknowledge each other; target object mutation cannot change guard semantics. Read-only Git creates no entries; precondition refusal creates no entries.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/effect-recovery-integration.test.ts`; Expected FAIL absent tracking/fence/captured target.
- [ ] **Step 3: Implement.** Mutation classification skips `-c` args and covers branch/checkout/worktree/add/commit/merge/push/update-ref/commit-tree/hash-object-write/fetch. Record after scoped repo validation before spawn; native status persisted independently of stale guard. commit acknowledges only after callback successfully saves; failed callback leaves pending. Freeze capture flags once. Audit scope close without metadata, preserving uncertain where outer workflow still has uncommitted transition.
- [ ] **Step 4: GREEN/types.** New recovery integration + existing EffectScope/Git/workflow/RunBranch suites and runtime/Desktop types PASS. Four docs/dashboard/core PASS.
- [ ] **Step 5: Commit/done.** Commit `refactor: связать native effects с журналом и checkpoint`; ledger completion по последнему Step2 receipt.

### Task 3: Desktop startup, process/files и operator recovery API

**Files:** runtime recovery-commands + contracts recovery DTO/API; runtime workers/session commands/attachments/workflow resume; Desktop owner journal factory/Git/session/index/shared API/preload/adapters; tests recovery-commands/startup/worker-files; четыре docs/dashboard.

**Interfaces:** `RecoveryCommands.list(context,projectId?)`, `inspect(context,projectId)`, `resolve(context,id,revision,resolution)` validates input and host principal. Desktop initializes journal only inside startProfileRuntime before initializeDesktop backup; resources receive lazy journal. Native launches and durable attachment placements record intent and checkpoint only after metadata is saved. resumeStuckStages checks unresolved matching records and blocks the existing stage, leaving native resources intact.

- [ ] **Step 1: RED.** Owned startup future/corrupt journal refuses before backup/migrations; real subprocess crash/second owner cannot repeat pending workflow Git/PTY. Fake native boundary for synchronous spawn/attachment verifies intent disk bytes exist before callback and metadata gap remains pending. Unauthorized/agent/foreign client cannot resolve; explicit operator resolution changes journal only, no native action. Existing normal worker/error/attachment paths retain behavior.
- [ ] **Step 2: Run RED.** `node --test packages/runtime/test/recovery-commands.test.ts packages/runtime/test/effect-recovery-host.test.ts`; Expected FAIL missing wiring/API.
- [ ] **Step 3: Implement.** Common validated operator recovery commands, complete Desktop IPC chain without UI changes, journal preflight after lease and before backup. Track process/files without secrets; asynchronous automatic resume uses recovery fence and existing block. Keep live old profile untouched.
- [ ] **Step 4: GREEN/full verify.** Exact Step2 suites, affected Desktop tests, all types and `pnpm verify`; Expected PASS. Four docs/dashboard state реализованный B и его проверки, C–F pending.
- [ ] **Step 5: Commit/done.** Commit `feat: подключить восстановление effects к runtime и Desktop`; ledger completion по последнему Step2 receipt. Continue C without handoff.
