# Async Git process и проверки проекта Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать весь путь project Git команд асинхронным и дать остальным Git effects общий исполнитель с ограничением вывода, отменой и остановкой принадлежащих ему процессов.

**Architecture:** Один `GitProcessService` на owner вызывает Git через `execFile` без shell. Он владеет процессами, закрывает stdin, завершает дерево процессов при отмене/таймауте и ждёт их закрытия. Существующая фабрика Git использует этот service для async операций, сохраняя прежние DTO/ошибки и очередь commonDir; синхронные workflow consumers переводятся следующим планом B.

**Tech Stack:** Node 24, TypeScript strict, node:test, настоящие временные Git repo/hooks.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §5–7 и §12.

## Global Constraints

- Без Electron/Desktop/node-pty в production graph runtime и без новых зависимостей.
- Без shell для Git; аргументы отдельно, независимо от пробелов в путях.
- Сохранить JSON/backup/миграции, legacy CLI/skills и Desktop IPC signatures.
- Canonical commonDir queue остаётся общей; независимые repo работают параллельно.
- Процессные ошибки не превращают stale/forbidden guard в обычную Git ошибку.
- Результат после отмены не означает откат внешнего effect; reconciliation/EffectToken — следующий шаг B.
- Inline execution уже разрешено, итоговый reviewer и pack только после всего фундамента.

## Review Focus

- Отмена уже запущенного Git hook с дочерним процессом должна завершить всё принадлежащее дереву; тест Task1.
- Отмена до запуска и stop owner не должны создать новый процесс/коммит; тест Task1.
- Ранний выход Git при stdin не должен породить необработанный EPIPE; тест Task1.
- Ограничение stdout и таймаут не оставляют hook/process живым; тест Task1.
- Unborn/detached/пропавший repo и exit 1 должны сохранять прежние результаты; тест Task2 и существующие Git suites.

---

### Task 1: Общий async process service

**Files:**
- Create: `packages/runtime/src/git-process.ts`.
- Create: `packages/runtime/test/git-process.test.ts`, `packages/runtime/test/git-process-fixture.ts`.
- Modify: `packages/runtime/src/git.ts`, `packages/runtime/src/index.ts`, `packages/runtime/src/git-operation-queue.ts`.
- Modify: четыре инженерных docs и `docs/orca-foundation-progress.md`.

**Interfaces:**
- Consumes: `createGitOperationQueue()` и существующий `canonicalGitCommonDir(root): Promise<string>`.
- Produces: `createGitProcessService(): GitProcessService`; `run(cwd: string, args: readonly string[], options?: GitProcessOptions): Promise<GitProcessResult>`; `stop(): Promise<void>`.
- Options: `input?: string`, `timeoutMs?: number` (default 30_000), `maxBuffer?: number` (default 16 MiB), `signal?: AbortSignal`, `acceptedExitCodes?: readonly number[]`.
- Result: `{stdout: string, stderr: string, code: number}`. `GitProcessError` сохраняет stdout/stderr/code, `killed`, `cancelled`, `timedOut` для прежнего formatter.
- `createGitOperations(messages, queue?, processes?)` позволяет composition передать один owner service; текущие host calls совместимы.

- [ ] **Step 1: Написать tests реальных Git effects.** Hook удерживает commit и запускает собственного ребёнка, записывает PID обоих. Проверить heartbeat/параллельный ref другой repo, abort и смерть PID/отсутствие HEAD, timeout и освобождение queue, pre-aborted сигнал/stop не создают commit, hash-object stdin/ранний exit, accepted exit 1 и bounded output.
- [ ] **Step 2: Запустить RED.** `node --test packages/runtime/test/git-process.test.ts`; Expected: FAIL — отсутствует `createGitProcessService`.
- [ ] **Step 3: Реализовать service и подключить async `runGit`/check-ignore/commonDir.** Таймеры/listeners снимаются при закрытии; POSIX process group, Windows taskkill дерево, только owned PID. stdin закрыт даже без input. `stop` идемпотентно отменяет и ждёт все текущие операции, новые отклоняются. commonDir необязательный service argument сохраняет прежний вызов.
- [ ] **Step 4: Запустить GREEN и affected suites.** `node --test packages/runtime/test/git-process.test.ts packages/runtime/test/git-operation-queue.test.ts packages/runtime/test/git.test.ts packages/runtime/test/project-run-agent-commands.test.ts packages/runtime/test/import-boundaries.test.ts`; Expected: все PASS. Runtime/Desktop typechecks; Expected: exit0.
- [ ] **Step 5: Docs, core tests, bare runtime suite и commit.** Описать точную границу done/remaining B, обновить четыре docs/dashboard; исправить explanatory checkbox в предыдущем плане. `pnpm --filter @orca-board/core test` и `pnpm --filter @orca-board/runtime test`; Expected: все PASS. Проверить diff, stage конкретные файлы, commit `refactor: добавить общий асинхронный исполнитель Git`.

### Task 2: Убрать sync Git из project command path

**Files:**
- Modify: `packages/runtime/src/git.ts`, `packages/runtime/src/project-git-commands.ts`.
- Create: `packages/runtime/test/project-git-async.test.ts`.
- Modify: Git host fixtures при необходимости, четыре docs/dashboard.

**Interfaces:**
- Consumes: Task1 `GitProcessService.run`, существующие commonDir queue и `createAsyncProjectCommandExecutor` scope guard.
- Produces: `projectBranchInfoAsync(root): Promise<ProjectBranchInfo>` и `hasCommitsAsync(root): Promise<boolean>`; project branch command использует async вариант. Все project async methods вызывают только async Git helpers; старые sync имена остаются временной совместимостью ещё не перенесённых workflow consumers.

- [ ] **Step 1: Tests async branch/unborn/detached/notRepo и actual command path.** Реальный repo/проект, branch + initial commit + branches + checkout; данные независимы от другого repo. Git process host порт оборачивает настоящий service и пропускает все subprocess effects, удерживает первый `symbolic-ref`; таймер/другая repo работают, malformed/forged context не запускает процесс. Guard, отозванный во время проверки, блокирует следующую mutation.
- [ ] **Step 2: RED.** `node --test packages/runtime/test/project-git-async.test.ts`; Expected: FAIL — async branch/commit helpers отсутствуют или branch command обходит async port.
- [ ] **Step 3: Реализовать async проверки и подключить.** Exit1 у HEAD означает unborn, прочее — отказ; branch DTO для missing repo прежний. `assertRepo`, `gitResult`, initial commit/pull/checkout полностью async. Guard после каждого await перед следующей mutation и перед возвращением результата, исключения guard вне Git formatter. Сохранить ordering прежних domain checks.
- [ ] **Step 4: GREEN + affected Desktop/Git.** Runtime tests обоих новых файлов/commonDir/git/project-run-agent/import guards и Desktop `gitBranch.test.ts`, `git-root.test.ts`, `project-run-agent-commands.test.ts`; Expected: все PASS. Runtime/Desktop typechecks; Expected: exit0.
- [ ] **Step 5: Docs и полная проверка.** Четыре docs/dashboard фиксируют async project path, sync workflow явно остаётся B. `pnpm verify`; Expected: typecheck/test/build exit0. Diff/stage/commit `refactor: убрать синхронные проверки из команд Git проекта`; task-done — affected runtime tests из Step4.
