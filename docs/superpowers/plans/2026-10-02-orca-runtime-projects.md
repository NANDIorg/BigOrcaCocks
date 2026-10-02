# Общий runtime проектов Orca

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Пользователь выбрал выполнение автором и отдельное итоговое ревью.

**Goal:** Перенести ProjectManager и его общие зависимости из Desktop в runtime, сохранив данные, ошибки и поведение Desktop.

**Architecture:** Node runtime владеет проектами, библиотекой типов, миграциями и досками. Хост передаёт перевод сообщений, класс ошибок и кодек настроек; Desktop расширяет общие настройки управлением окном и автообновлением. Старые модули Desktop остаются совместимыми адаптерами.

**Tech Stack:** TypeScript strict, Node 24.x, pnpm 10.33.0, node:test, существующий Electron/Vite.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`

## Global Constraints

- Использовать назначенный worktree `/private/tmp/orca-web-migration-audit`, ветку `feature/web-migration-audit`.
- Runtime не импортирует Electron или Desktop даже через type-only и транзитивные зависимости; contracts остаётся browser-safe.
- Сохранить `projects.json`, `boards/<id>.json`, версии форматов, порядок бэкапов и миграций, атомарную запись и существующие обработчики IPC/сокета.
- Сохранить порядок проверки настроек Desktop: keepInBackground, language, notifications, appearance, updates, assistant.
- Не добавлять внешние зависимости, не менять версии продуктов 1.1.3, не реализовывать Web/CLI/owner в этом срезе.
- Сохранить legacy activeId API для Desktop; контекст клиентов и единственный владелец данных входят в следующие этапы.
- Документация, комментарии и Conventional Commits по-русски; никаких `any`, `as any`, `console.log`.
- После полной проверки и итогового ревью собрать и открыть актуальный рабочий Desktop; PR обновить без слияния и публикации.

## Review Focus

1. Неизвестные настройки другого хоста: запись общих полей сохраняет непрозрачные поля Desktop и будущего хоста (Task 1/3).
2. Некорректный граф: ошибка по-прежнему является OrcaError в Desktop и содержит validation для сокета (Task 2/3).
3. Ошибка записи projects.json: подтверждённые настройки и библиотека остаются прежними в памяти и на диске (Task 3 + существующие регрессии).
4. Удаление одного проекта: очищаются только его вложения и снимки, пути соседнего проекта сохраняются (Task 2/3).
5. Запуск обычным Node: реальный package entrypoint загружает core/runtime и создаёт доску без loader и Electron (Task 1/3).

## Task 1: Общие настройки и вход core для Node

**Files:**
- Modify: `packages/core/src/index.ts`, `packages/contracts/src/settings.ts`, `apps/desktop/src/shared/desktop-settings.ts`.
- Create: `packages/runtime/src/project-messages.ts`, `packages/runtime/src/settings.ts`, `packages/runtime/src/extra-args.ts`, `apps/desktop/src/main/project-settings.ts`.
- Modify: `packages/runtime/src/index.ts`, `apps/desktop/src/main/assistant.ts`, `apps/desktop/src/main/launch-extra-args.ts`, `apps/desktop/src/main/projects.ts`.
- Test: `packages/runtime/test/settings.test.ts`, `packages/runtime/test/core-entry.test.ts`; существующие тесты настроек Desktop.

**Interfaces:**
- Consumes: общие appearance/notifications helpers, core AssistantSettings/parseExtraArgs, Desktop OrcaError/mt.
- Produces: contracts `RuntimeSettings` (language?, appearance?, notifications, assistant), `RuntimeSettingsPatch`; Desktop AppSettings/AppSettingsPatch расширяют их.
- Produces: `StoredRuntimeSettings = Partial<RuntimeSettings> & Record<string, unknown>`; `ProjectSettingsCodec<S extends RuntimeSettings, P extends RuntimeSettingsPatch> { load(raw: StoredRuntimeSettings): S; merge(raw: StoredRuntimeSettings, patch: P): StoredRuntimeSettings }`.
- Produces: `ProjectMessages { Error: new(key: ProjectMessageKey, params?: ProjectMessageParams) => Error; text(key: ProjectMessageKey, params?: ProjectMessageParams): string }`, вложенные сообщения допускают string/number/ProjectMessage.
- Produces: `createRuntimeSettings(messages)` возвращает codec и `mergedAssistantSettings`; exports `loadedAssistantSettings`, `normalizeRuntimeSettings`, `mergeRuntimePreferences`, `extraArgsReason`, `extraArgsProblem`, `withoutExtraArgs`.
- Produces: Desktop `DEFAULT_APP_SETTINGS` и `desktopProjectSettings`, прежние экспорты помощников ассистента и флагов сохранены.

- [x] Написать тест обычного Node, который импортирует core и сохраняет/загружает TaskStore через runtime jsonPersistence. Написать тесты codec: сохранение чужих полей, defaults, смена агента, очистка полей, некорректный patch и флаги.
- [x] Run: `node --test packages/runtime/test/core-entry.test.ts packages/runtime/test/settings.test.ts`.
  Expected: FAIL — вход core без расширений и отсутствующий codec.
- [x] Добавить `.ts` к экспорту barrel core. Вынести общие нормализацию/слияние и причину ошибок флагов; Desktop codec сохраняет прежний порядок валидации и ошибки. Подключить codec к текущему ProjectManager до переноса класса.
- [x] Run: `pnpm --filter @orca-board/runtime typecheck && pnpm --filter @orca-board/desktop typecheck`.
  Expected: PASS.
- [x] Финальная проверка задачи через task-done: `pnpm --filter @orca-board/runtime test && pnpm --filter @orca-board/contracts test && pnpm --filter @orca-board/desktop test`.
  Expected: PASS, существующие ожидания Desktop не изменены.
- [x] Commit: `refactor: выделить общие настройки runtime`.

## Task 2: Проекты и миграции в runtime

**Files:**
- Create: `packages/runtime/src/projects.ts`, `packages/runtime/src/task-types-migration.ts`, `packages/runtime/src/task-type-detect.ts`, `packages/runtime/src/artifact-paths.ts`.
- Modify: `packages/runtime/src/index.ts`, `apps/desktop/src/main/projects.ts`, `apps/desktop/src/main/task-types-migration.ts`, `apps/desktop/src/main/task-type-detect.ts`, `apps/desktop/src/main/run-images.ts`, `apps/desktop/src/main/showcase-snapshot.ts`.
- Test: `packages/runtime/test/projects.test.ts`; существующие projects/task-types/workflow-assistant/run-images/showcase тесты Desktop.

**Interfaces:**
- Consumes: ProjectMessages, ProjectSettingsCodec<S,P>, StoredRuntimeSettings из Task 1; core домен и runtime persistence.
- Produces: `createProjectServices<S extends RuntimeSettings, P extends RuntimeSettingsPatch>(host: { messages: ProjectMessages; settings: ProjectSettingsCodec<S,P> })` возвращает `{ ProjectManager, WorkflowValidationError }`.
- Produces: `new ProjectManager(dataDir: string)` — прежний API, settings():S, setSettings(patch:P):S; WorkflowValidationError наследует переданный Error и содержит readonly validation:WorkflowPreparation.
- Produces: Runtime Project/ProjectsFile/StoredOnboarding/PermissionMode, runnableWorkflow, PROJECTS_BACKUP_NAME, PROJECTS_WORKFLOW_BACKUP_NAME; миграции и детектор с прежними именами.
- Produces: Общие safeArtifactId/runImagesRoot/runImagesDir/removeRunImagesDir/showcaseSnapshotsRoot/showcaseSnapshotDir/removeShowcaseDir; прежние пути и обработка ошибок.
- Desktop экспортирует singleton классы фабрики + одноимённые type aliases для совместимости; DEFAULT_APP_SETTINGS остаётся Desktop.

- [ ] Написать Node integration тест фабрики с реальным temp git репозиторием: проект, доска, reload, отдельные профили; ошибки наследуют host Error; удаление очищает собственные каталоги.
- [ ] Run: `node --test packages/runtime/test/projects.test.ts`.
  Expected: FAIL — createProjectServices отсутствует.
- [ ] Перенести класс и его helper-функции в фабрику без изменения алгоритмов; заменить только i18n/настройки через host, constructor parameter properties явными полями. Миграции и детектор перенести целиком. Из модулей вложений вынести только пути и удаление каталогов; файлы/снимки и launch остаются следующими срезами.
- [ ] Run: `pnpm --filter @orca-board/runtime typecheck && pnpm --filter @orca-board/desktop typecheck`.
  Expected: PASS.
- [ ] Финальная проверка задачи через task-done: `pnpm --filter @orca-board/runtime test && pnpm --filter @orca-board/desktop test`.
  Expected: PASS, не меняя старые ожидания и JSON fixtures.
- [ ] Commit: `refactor: вынести проекты и миграции в общий runtime`.

## Task 3: Интеграционные гарантии и итоговая проверка

**Files:**
- Modify: `packages/runtime/test/projects.test.ts`, `packages/runtime/test/import-boundaries.test.ts`, `docs/architecture.md`, этот план.

**Interfaces:**
- Consumes: реальный @orca-board/runtime entrypoint и Desktop адаптеры из Task 1/2.
- Produces: проверенные гарантии plain Node, rollback, непрозрачных настроек, workflow revision/validation, границ импорта; документация действительного состояния.

- [ ] Закрепить общие гарантии реальными дисковыми сценариями: settings rollback при препятствии rename, workflow conflict без потери новой ревизии, детали WorkflowValidationError, store-open события один раз, сохранение opaque полей при повторной загрузке. Existing Desktop regression tests покрывают миграции и unopened/future boards; их оставить на месте.
- [ ] Run: `pnpm --filter @orca-board/runtime test`.
  Expected: PASS; для каждого нового поведения отсутствующей реализации сначала RED, для закрепления перенесённого поведения допускается GREEN characterization.
- [ ] Описать runtime проектов, host settings/messages и оставшиеся зависимости Desktop в docs/architecture.md; отметить выполненные шаги.
- [ ] Финальная проверка задачи через task-done: `pnpm verify`.
  Expected: PASS — git-flow, strict typecheck, все тесты и production build.
- [ ] Commit: `test: закрепить совместимость общего менеджера проектов`.
- [ ] Выполнить одно итоговое fresh-context ревью диапазона c103ca9..HEAD, исправить Critical/Important через RED→GREEN, minor записать.
- [ ] Run: `pnpm --filter @orca-board/desktop run pack`, проверить подпись и реальный app.asar, открыть актуальный `apps/desktop/release/local/mac/orca-board.app`.
  Expected: локальный рабочий билд 1.1.3 с новым runtime, без bare workspace imports.
- [ ] Push своей ветки, обновить PR #59 и дождаться CI на точном HEAD; без merge или релиза.
