# Общий runtime: хранение и Git — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Исполнитель работает сам; один независимый reviewer проверяет результат в конце. Это продолжение уже подтверждённого переноса общего фундамента.

**Goal:** Desktop использует общий Node-пакет для хранения, резервных копий и Git; тот же пакет работает без Electron.

**Architecture:** Переносим существующие реализации, сохраняя сигнатуры и формат файлов. В Desktop остаются совместимые пути импортов, отображение обновления и адаптер локализации Git. Git получает сообщения через `createGitOperations(messages)`; состояние очереди принадлежит созданному экземпляру, без общего языка интерфейса в runtime.

**Tech Stack:** pnpm 10.33.0, Node 24, TypeScript strict, node:test, electron-vite, существующий Git process API.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, разделы 3, 7, 11–12.

Это первый ограниченный перенос этапа 2, а не завершение серверной базы. ProjectManager, application services, RuntimeContext/owner/handshake, выполнение агентов, полный async Git с очередью commonDir и EffectToken, Web и терминальный чат CLI — последующие переносы. Существующие синхронные Git-операции сейчас сохраняются; они должны стать async до готовности серверной базы.

## Global Constraints

- Desktop продолжает работать на каждом этапе; перенос выполняется небольшими вертикальными срезами.
- Core не зависит от runtime/contracts/UI; runtime не импортирует Electron и Desktop.
- Сохраняем JSON, атомарную запись, backups и существующие миграции. Перенос пакетов не должен сам менять формат пользовательских данных.
- Git вызывается аргументами через process API без shell.
- Не запускаем перенос пользовательских данных на сервер; Desktop сохраняет прежние userData и socket paths.
- `packages/cli/bin/orca-board.js` остаётся dependency-free агентским клиентом.
- Продуктовые версии не меняем. `@orca-board/runtime` — private TS-пакет с технической версией `0.0.1`, встраиваемый в Desktop main bundle.
- Комментарии, документация и коммиты — по-русски; без `any`, `as any`, `console.log`.
- Работа в назначенном worktree `feature/web-migration-audit`; PR в develop, без самостоятельного merge.

## Review Focus

1. Ошибка записи нескольких файлов: прежние байты восстанавливаются, новый файл удаляется, чужой каталог `.tmp` сохраняется — Task 1, перенос persistence suites.
2. Повреждённое/будущее состояние: backup сохраняет исходные байты до миграций, future board не переписывается — Task 1, перенос backup/persistence suites.
3. Два host-экземпляра с разными сообщениями: один не меняет ошибки и подпись untracked другого — Task 2, реальные Git-фикстуры.
4. Runtime импортирован обычным Node: операции работают без Electron loader, а type-only/transitive/неэкспортируемый импорт Desktop обнаруживается — Tasks 1–3.
5. Установленный Desktop: package не остаётся внешним workspace require; IPC получает прежние OrcaError/code, MergeError/GitOpError сохраняют идентичность — Tasks 2–3, старые Desktop suites и проверка bundled/packaged main.

## Task 1: Общая запись состояния и резервные копии

**Files:**
- Create: `packages/runtime/package.json`, `packages/runtime/tsconfig.json`, `packages/runtime/src/index.ts`, `packages/runtime/src/persistence.ts`, `packages/runtime/src/backup.ts`.
- Move tests: `apps/desktop/src/main/persistence.test.ts` → `packages/runtime/test/persistence.test.ts`; backup suites → `packages/runtime/test/backup.test.ts`.
- Modify: `apps/desktop/src/main/persistence.ts`, `apps/desktop/src/main/backup.ts`, `apps/desktop/src/main/backup.test.ts`, `apps/desktop/package.json`, `apps/desktop/tsconfig.node.json`, `apps/desktop/electron.vite.config.ts`, `pnpm-lock.yaml`, `CLAUDE.md`, `docs/architecture.md`.

**Interfaces:**
- Consumes: `Persistence`, `StoreSnapshot` и `TaskStore` из core; вызывающий передаёт абсолютный путь файла/каталога и версию продукта.
- Produces: существующие `writeFileAtomic(file, text): void`, `writeFilesAtomic(writes: readonly AtomicFileWrite[]): void`, `quarantineCorrupt(file, now?): string | undefined`, `readJsonFile<T>(file, what): JsonReadResult<T>`, `jsonPersistence(file, onWarning?): Persistence`.
- Produces: прежние `BACKUPS_KEEP`, `UNKNOWN_VERSION`, `compareVersions`, `readLastRunVersion`, `copyStateTo`, `pruneBackups`, `backupOnVersionChange(dataDir, currentVersion): VersionBackupResult`.
- Desktop only: `rememberUpdate(result): void`, `getJustUpdatedFrom(): string | null` и их модульное UI-состояние. Backup entrypoint runtime их не экспортирует.

- [ ] Step 1: Перенести существующие behavioral suites на будущие relative `.ts` imports runtime; оставить тест UI-флага в Desktop. Сохранить все проверки реального I/O и TaskStore roundtrip.
- [ ] Step 2: Запустить `node --test packages/runtime/test/{persistence,backup}.test.ts` под Node 24.
  Expected: FAIL из-за отсутствующего runtime-модуля; сохранить RED log.
- [ ] Step 3: Перенести реализации без изменений алгоритмов/формата; relative imports с `.ts`. Создать private package с core dependency, TypeScript и существующей версией `@types/node` в devDependencies; `test` запускает `test/*.test.ts`. Desktop persistence — именованный реэкспорт; backup — реэкспорт дисковых функций плюс прежний UI-флаг. Добавить workspace dependency, TS path и main alias/externalize exclusion; runtime не добавлять в renderer/preload.
- [ ] Step 4: Обновить архитектуру и инженерные правила для реально перенесённых модулей.
- [ ] Step 5: Выполнить итоговую проверку задачи: `pnpm --filter @orca-board/runtime typecheck`, `pnpm --filter @orca-board/desktop typecheck`, `pnpm --filter @orca-board/runtime test`, Desktop backup test и core tests.
  Expected: PASS всех команд; сбой I/O и future state всё ещё защищены прежними suites.
- [ ] Step 6: Коммит `refactor: вынести хранение и резервные копии в общий runtime`.

## Task 2: Общие Git-операции с Desktop-адаптером сообщений

**Files:**
- Create: `packages/runtime/src/git.ts`, `packages/runtime/test/git.test.ts`.
- Modify: `packages/runtime/src/index.ts`, `packages/runtime/package.json`, `apps/desktop/src/main/git.ts`, `docs/architecture.md`.
- Existing regression tests: `apps/desktop/src/main/git-root.test.ts`, `gitBranch.test.ts`, `initialCommit.test.ts`, `workflow-git.test.ts`, `review.test.ts`, `run-branch.test.ts`, `project-files.test.ts`.

**Interfaces:**
- Consumes: project Git DTO из `@orca-board/contracts`, Node process/fs/path API; Desktop `mt` и `OrcaError` только в адаптере.
- Produces: `GitErrorCode` — union только кодов ошибок, уже используемых git.ts; `GitMessage` с `key: GitErrorCode` и `params?: GitMessageParams`; `GitMessageParams = Record<string, string | number | GitMessage>`.
- Produces: `GitMessages { error(key: GitErrorCode, params?: GitMessageParams): Error; untrackedLabel(): string }` и `createGitOperations(messages: GitMessages): GitOperations`. `GitOperations` — возвращаемые прежние 25 функций git.ts с теми же аргументами/результатами; фактический список взять из исходного модуля, ничего не удалить.
- Produces: прежние `MergeError`, `GitOpError`, `ReviewInfo`; классы вне factory и совместимо реэкспортируются Desktop.
- Desktop adapter: один экземпляр с `error: (key, params) => new OrcaError(key, params)` и `untrackedLabel: () => mt('review.untracked')`; именованные function exports из него сохраняют старых потребителей. Lazy callbacks сохраняют смену языка после запуска.

- [ ] Step 1: Написать runtime Git tests с настоящими временными репозиториями: unborn/initial empty commit сохраняет staged и рабочие файлы; no-commits/notRepo/dirty errors принадлежат host; review untracked подписи двух hosts не смешиваются; branch/worktree/commit/merge/remove roundtrip; gitCheckIgnore с пробелами; неизменённые MergeError/GitOpError для отказов. Добавить неудачный hook и проверить `git.opFailed` с причиной.
- [ ] Step 2: Запустить `node --test packages/runtime/test/git.test.ts`.
  Expected: FAIL из-за отсутствующего Git runtime; сохранить RED log.
- [ ] Step 3: Перенести исходный Git код внутрь factory, заменить создание OrcaError на messages.error, единственный mt на messages.untrackedLabel. Дисковые операции, аргументы git, таймауты, обход EPIPE и очередь по переданному root не менять. Сохранить все функции/классы; не добавлять глобальный язык и не импортировать Desktop.
- [ ] Step 4: Подключить Desktop adapter и runtime entrypoint. Описать текущее ограничение sync Git и root queues; не заявлять готовую серверную надёжность.
- [ ] Step 5: Выполнить typecheck runtime/Desktop, все runtime tests, перечисленные Desktop regression suites и core tests.
  Expected: PASS; существующие `instanceof OrcaError`/error keys и русские сообщения проходят без переписывания expectations.
- [ ] Step 6: Коммит `refactor: вынести Git-операции в общий runtime`.

## Task 3: Проверяемые границы runtime и итоговая сборка

**Files:**
- Create: `packages/runtime/test/import-boundaries.ts`, `packages/runtime/test/import-boundaries.test.ts`.
- Modify if necessary: `packages/runtime/tsconfig.json`, `CLAUDE.md`, `docs/architecture.md`, этот план (фактический статус).

**Interfaces:**
- Consumes: runtime production graph, core/contracts dependencies, созданные в Tasks 1–2, разрешённые Node builtins.
- Produces: `auditRuntimeImports(root: string): RuntimeBoundaryIssue[]`, тестовый AST-аудит всех production `.ts`, включая неэкспортируемые файлы, type-only/reexports/dynamic import, транзитивные зависимости и canonical paths. Допустимы только runtime/core/contracts и Node; Electron/прочие apps/неявный require/вычисленный импорт запрещены. Это dev utility, не экспорт production package.

- [ ] Step 1: Написать fixtures: allowed Node/core/contracts; прямой и type-only Desktop/Electron; транситивный core→Desktop; неэкспортируемый файл; computed import/require; относительный выход за allowed roots. Проверить настоящий production graph.
- [ ] Step 2: Запустить `node --test packages/runtime/test/import-boundaries.test.ts`.
  Expected: FAIL из-за отсутствующего аудитора; сохранить RED log.
- [ ] Step 3: Реализовать тестовый AST traversal с realpath, без новых production dependencies; запретить Electron types в compiler runtime (`types: ["node"]`, `lib: ["ES2022"]`).
- [ ] Step 4: Выполнить `pnpm verify` из worktree; сохранить полный log, изучить ошибки/итоги.
  Expected: PASS git-flow, typecheck, все тесты и build; built main не содержит внешнего runtime import.
- [ ] Step 5: Коммит `test: закрепить границы общего runtime`; fresh-context review всего нового переноса. Critical/Important — один проверенный RED→GREEN fix pass; Minor — явно отложить.
- [ ] Step 6: Push своей feature-ветки, обновить PR #59 по финальному diff и проверить CI на текущем HEAD. Собрать `pnpm --filter @orca-board/desktop run pack`, проверить отсутствие внешнего runtime import в app.asar и открыть local mac app; путь указать пользователю.
  Expected: PASS проверок; приложение собрано и открыто. Ручную проверку интерфейса выполняет пользователь.

## Статус

План проверен против утверждённой архитектуры. Исполнение: в работе; переносы ProjectManager, owner и async/commonDir Git остаются отдельными следующими планами.
