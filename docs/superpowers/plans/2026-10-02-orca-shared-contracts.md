# Первый перенос общего фундамента Orca: контракты и границы Desktop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выделить действующие общие DTO и чистые функции из Desktop в `@orca-board/contracts`, сохранив нынешние IPC, данные и поведение приложения.

**Architecture:** Общий пакет зависит только от browser-safe типов core. Desktop использует его через совместимые экспорты из прежних `shared/*`; Electron API, оконные настройки и provider driver остаются в Desktop. Пакет включается в сборки, а независимость от платформы проверяется импортами, TypeScript и действующими тестами потребителей.

**Tech Stack:** Node 24, pnpm 10.33.0, TypeScript strict, `node:test`, существующие electron-vite/Vite и TypeScript compiler API для тестового стража импортов. Новых сторонних библиотек нет.

**Spec:** [Утверждённая архитектура Desktop/CLI/Web](../specs/2026-10-02-orca-shared-foundation-design.md). База исследования: `b3433f4`; документ архитектуры: `1472554`.

## Global Constraints

- Core не зависит от runtime/contracts/UI. Contracts не импортирует Node/Electron/Desktop; разрешена только зависимость на browser-safe core.
- Desktop продолжает работать на каждом этапе; перенос кода сопровождается переносом его тестов и сохранением поведения.
- Сохраняем JSON, атомарную запись, backups и существующие миграции. Перенос пакетов не должен сам менять формат пользовательских данных.
- Legacy agent client сохраняет envelope, команды, HELP и exit codes; новые поля добавляются совместимо.
- `packages/cli/bin/orca-board.js` сохраняется dependency-free; не импортировать в него core/npm.
- Поддержка старого preload при HMR сохраняется; optional API не становится обязательным.
- Версии Desktop/CLI/Web независимы; подготовка контракта не меняет номера версий, теги, каналы обновления или кодовые имена.
- Комментарии/документация/коммиты — по-русски; TypeScript без `any`/`as any`; текущие ru/en тексты и визуальный дизайн сохраняются.
- Работать в назначенном feature worktree, не менять root/develop/master и чужую ветку PR #55. Никаких публикаций или изменения серверных rulesets.
- Перед PR — `pnpm verify`; docs требуют core tests. После пользовательского этапа — локальный `pnpm --filter @orca-board/desktop run pack` и открытие `.app`; UI проверяет пользователь.

## Review Focus

1. Старый main/preload при новом renderer: отсутствие поздних методов остаётся допустимым; прежние сообщения о перезапуске сохраняются (задача 3, существующие compatibility tests).
2. Node/CLI без Electron: импорт common package не запускает процессы и не загружает provider driver/desktop assets (задачи 1 и 4, public-export и import-graph tests).
3. Неверные имена файлов/типов, `constructor`/`__proto__`, Windows-разделители: классификация и whitelist не меняются после переноса (задача 2, перенос существующих pure tests).
4. Старые/повреждённые настройки и частичный патч: чтение нормализует, запись отклоняет ошибку без потери прежних значений (задача 2, pure tests и действующие persistence/appearance tests).
5. Упакованный Desktop вне исходников: private contracts не остаётся внешним TS-import и не требует workspace/node_modules пользователя (задачи 1 и 4, проверка build output и pack).

## Граница этого плана

Это первая часть рубежа 1 из спецификации. Результат — реальный общий контракт данных,
используемый Desktop, и проверяемая граница платформенного API. Он ещё не означает
готовность headless runtime или полной базы.

В этот перенос не входят новые сетевые методы, `OrcaClient` с project context,
операторский handshake, новые dialogs/session lifecycle, daemon/locks, async Git,
auth, общий React package и release tooling. Их реализация связана с соответствующими
services и последующими рубежами. Не создаём пустые runtime/client/ui packages
или заглушки будущих HTTP/CLI методов ради структуры каталогов.

Текущий `OrcaApi` остаётся Desktop API: его implicit active project и системные
диалоги не объявляются готовым Web-контрактом. Общие DTO пока сохраняют существующие
поля (`root`, `ptyId`, `images`, `Uint8Array`), чтобы перенос не стал скрытой
миграцией. Opaque file ids, binary HTTP routes и явный project context добавляются
при разработке общего service API, до реализации Web.

## Карта ответственности

| Файл | Ответственность |
| --- | --- |
| `packages/contracts/src/projects.ts` | Project/group/branch DTO, initial commit mode и git error codes |
| `packages/contracts/src/tasks.ts` | Task/global/subtask input/patch, task type/node template DTO, review/request DTO |
| `packages/contracts/src/files.ts` | File/doc/showcase DTO, ограничения листинга, коды файловых ошибок, attachment capabilities |
| `packages/contracts/src/rules.ts` | Rule whitelist, RuleFile и `isRuleFileName` |
| `packages/contracts/src/sessions.ts` | PtySpawnOptions, TerminalRole/Info/Snapshot как данные текущего API |
| `packages/contracts/src/conversation.ts` | Message/status/tool/interaction/answer/snapshot/update DTO без provider driver |
| `packages/contracts/src/assistant-chat.ts` | AssistantChat aliases, snapshot/update |
| `packages/contracts/src/workflow-assistant.ts` | Контекст редактора и переэкспорт core WorkflowAssistantSaved |
| `packages/contracts/src/settings.ts` | AppLanguage, PermissionMode и onboarding DTO/version |
| `packages/contracts/src/appearance.ts` | Идентификаторы тем, appearance DTO/defaults/normalize/merge; без палитр |
| `packages/contracts/src/notifications.ts` | Перенос нынешней чистой модели/фильтров уведомлений |
| `packages/contracts/src/docs-view.ts` | Перенос классификатора файлов и лимитов просмотра |
| `packages/contracts/src/showcase.ts` | Перенос чистой MIME/preview/open policy и markdown helper |
| `packages/contracts/src/index.ts` | Явная публичная поверхность contracts; без store и платформенных интерфейсов |
| `apps/desktop/src/shared/desktop-api.ts` | Нынешний OrcaApi, AppMenuAction/AppMenuItem, OS export result |
| `apps/desktop/src/shared/desktop-settings.ts` | Составные AppSettings/patch и update types/defaults нынешнего Desktop |
| `apps/desktop/src/shared/ipc.ts` | Compatibility facade: прежние имена через contracts/desktop-api/desktop-settings |
| Остальные `apps/desktop/src/shared/*` | Совместимые экспорты общих модулей; window-chrome и палитры остаются локальными |
| `packages/contracts/test/import-boundaries.ts` | Только тестовый Node-страж импортов, не часть product exports |

Перемещения определений из `ipc.ts` делаются по именам, не по устаревшим line ranges.
Переименование полей и семантические правки не допускаются. Все относительно
импортируемые файлы внутри нового пакета используют `.ts`, как browser-safe core;
это позволяет Node 24 запускать tests без Desktop resolve hook.

## Task 1: Общие DTO становятся настоящей зависимостью Desktop

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`.
- Create: `packages/contracts/src/{index,projects,tasks,files,rules,sessions,conversation,assistant-chat,workflow-assistant,settings}.ts`.
- Create: `packages/contracts/test/contracts.test.ts`.
- Modify: `apps/desktop/package.json`, `apps/desktop/tsconfig.node.json`, `apps/desktop/tsconfig.web.json`, `apps/desktop/electron.vite.config.ts`, `pnpm-lock.yaml`.
- Modify: `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/assistant-conversation.ts`, `apps/desktop/src/shared/assistant-workflow.ts`, `apps/desktop/src/shared/docs-view.ts`.
- Test: действующие main/renderer tests, typecheck и build.

**Interfaces:**
- Consumes: текущие определения из `shared/ipc.ts` и data-часть `shared/assistant-conversation.ts`; core типы через `import type`.
- Produces: `@orca-board/contracts` с теми же Project/TaskPatch/GlobalTaskInput/GlobalTaskPatch/SubtaskInput/TaskTypeInput/TaskTypePatch/TaskTypesState/NodeTemplateInput/ProjectTaskTypesInput/TaskTypeDetection/ReviewInfo/RequestListOptions/RequestResolveResult/RequestFocus, файловыми DTO, terminal DTO, conversation/chat DTO и onboarding/settings enum.
- Produces: `isRuleFileName(value: unknown): value is RuleFileName`, `RULE_FILE_NAMES`, `PROJECT_FILES_DIR_LIMIT`, git/file/doc error code arrays и `ONBOARDING_VERSION` с нынешними значениями.
- Produces: `DocViewKind` в files.ts; нынешний docs-view.ts временно импортирует/переэкспортирует этот type. Классификатор переносится задачей 2, поэтому files.ts не зависит от ещё не существующего общего docs-view.ts.
- Excludes: `TaskStore`, `Persistence`, `OrcaApi`, `AppSettings`, update/window/menu types, `AssistantConversation`, `ConversationOptions`, `TaskTypeExportResult`, `PERMISSION_MODES` с UI-подписями. Driver interfaces пока остаются в старом shared conversation module, с импортом общих DTO.

- [ ] **Шаг 1. Создать тест публичных exports нового пакета**, используя динамический импорт URL `../src/index.ts`, чтобы начальный FAIL не зависел от регистрации workspace. Добавить утверждения:

```ts
assert.equal(contracts.isRuleFileName('CLAUDE.md'), true)
assert.equal(contracts.isRuleFileName('../CLAUDE.md'), false)
assert.equal(contracts.isRuleFileName('claude.md'), false)
assert.equal('TaskStore' in contracts, false)
assert.equal('createConversation' in contracts, false)
```

  Проверки закрывают whitelist и утечку backend в package entrypoint; новые snapshot-копии всех DTO не нужны. Имена и обязательность полей защищает компиляция действующих потребителей.
- [ ] **Шаг 2. Запустить `node --test packages/contracts/test/contracts.test.ts` из корня.** Expected: FAIL с `ERR_MODULE_NOT_FOUND` для нового entrypoint; зафиксировать причину, не считать случайный syntax error нужным FAIL.
- [ ] **Шаг 3. Перенести определения без изменения полей/значений.** В `ipc.ts` импортировать необходимые DTO для оставшегося OrcaApi и переэкспортировать прежние имена. Conversation limit `300` хранится вместе с общими conversation DTO; `AssistantConversation`/`ConversationOptions` не переэкспортировать из contracts. Старый `protocolVersion?: 2` чата не превращать в будущий owner protocolMajor.
- [ ] **Шаг 4. Подключить пакет и сборку.** Package name `@orca-board/contracts`, `private: true`, техническая версия `0.0.1`, `type: module`, `main/types: src/index.ts`, root export `./src/index.ts`, scripts `typecheck: tsc -p tsconfig.json`, `test: node --test test/*.test.ts`, `build: echo skip`. Единственная production dependency — `@orca-board/core: workspace:*`; dev TypeScript с той же версией/range, что у core. TS config наследует base, `types: []`, `lib: ["ES2022"]`, include `src`, exclude tests. Добавить workspace dependency Desktop, одинаковый root alias в обоих tsconfig и main/renderer Vite resolve. Исключить contracts из externalizeDepsPlugin main и preload: TS-исходники private package должны попасть в bundle. Обновить lock обычным pnpm install, затем подтвердить frozen-lockfile; pnpm workspace glob уже подходит.
- [ ] **Шаг 5. Запустить `pnpm --filter @orca-board/contracts test`, `pnpm typecheck`, `pnpm build`.** Expected: PASS; existing preload компилируется с прежними signatures, main/preload output не содержит внешнего import/require `@orca-board/contracts`.
- [ ] **Шаг 6. Просмотреть конкретный diff и закоммитить** только файлы этой задачи: `refactor: вынести общие DTO Orca в contracts`.

## Task 2: Чистые общие функции и их проверки переезжают вместе

**Files:**
- Create: `packages/contracts/src/{appearance,notifications,docs-view,showcase}.ts`.
- Create: `packages/contracts/test/{docs-view,notifications,appearance}.test.ts`.
- Modify: `packages/contracts/src/index.ts`.
- Modify: `apps/desktop/src/shared/{appearance,notifications,docs-view,showcase,theme}.ts`.
- Modify: `apps/desktop/src/main/docs-kind.test.ts`, `apps/desktop/src/main/notify.test.ts`.
- Test: `apps/desktop/src/main/projects-appearance.test.ts`, `apps/desktop/src/renderer/src/appearance.test.ts`, `apps/desktop/src/renderer/src/theme.test.ts`, `apps/desktop/src/main/project-files.test.ts`, `apps/desktop/src/main/docs-view.test.ts`, `apps/desktop/src/main/preview-protocol.test.ts`.

**Interfaces:**
- Consumes: задача 1 — file DTO/error codes, core DispatchShowcase как type-only dependency.
- Produces: прежние `docKindOf(path: string): DocKind`, showcase MIME/policy helpers и лимиты.
- Produces: прежние normalize/merge/quiet-hours/shouldNotify signatures из `shared/notifications.ts` без смены clock/focus semantics.
- Produces: `AppTheme`, `APP_THEMES`, `DEFAULT_APP_THEME`, `isAppTheme(value: unknown): value is AppTheme`, `AppearanceSettings`, `normalizeAppearance(raw: unknown): AppearanceSettings`, `mergeAppearance(current: AppearanceSettings, raw: unknown): AppearanceSettings`.
- Retains: `ThemeColors`, `ThemeDefinition`, палитры, `getAppTheme`, `appFontFamily`, цвета синтаксиса — Desktop/UI, не contracts.

- [ ] **Шаг 1. Перенести существующий `describe('docKindOf')` из docs-kind.test.ts и чистые `shouldNotify`/`inQuietHours`/`normalize / merge` suites из notify.test.ts в tests contracts.** Сохранить утверждения и fixtures; поменять только импортируемый entrypoint. Desktop suites про словари, describeEvent/answerNudge, реальную файловую систему и persistence остаются в Desktop. В новом appearance.test.ts закрепить три случая прямого импорта без Desktop: повреждённые поля нормализуются в graphite/system/false; патч только theme сохраняет motion/highSaturation; ошибочный patch не изменяет переданный current.

```ts
assert.deepEqual(normalizeAppearance({ theme: 'removed', motion: 'bad', highSaturation: 'yes' }),
  { theme: 'graphite', motion: 'system', highSaturation: false })
const current = { theme: 'paper', motion: 'reduced', highSaturation: true } as const
assert.deepEqual(mergeAppearance(current, { theme: 'forest' }),
  { theme: 'forest', motion: 'reduced', highSaturation: true })
assert.throws(() => mergeAppearance(current, { theme: 'slate', highSaturation: 'yes' }))
assert.deepEqual(current, { theme: 'paper', motion: 'reduced', highSaturation: true })
```
- [ ] **Шаг 2. Запустить `pnpm --filter @orca-board/contracts test`.** Expected: FAIL, поскольку функции ещё не экспортированы. Обязательные сохранённые cases: `constructor`/`__proto__`, `App.TSX`, `a.png\\notes.md`, unknown/пустой путь; тихие часы `22:00–08:00` включая границу `08:00`; повреждённые settings и неправильный patch.
- [ ] **Шаг 3. Перенести четыре чистых модуля, сохранив функции/константы.** Docs-view использует DocViewKind из files.ts задачи 1; barrel экспортирует этот type один раз. Из theme переносить только theme ids/default/type guard в contracts appearance; shared theme импортирует и переэкспортирует их, палитры не меняются. Старые shared paths становятся именованными reexports, без копий реализации. Defaults темы остаются graphite/system/false. Ошибочный appearance patch по-прежнему отклоняется целиком; quiet-hours зависят от переданного Date, а не нового server/client clock.
- [ ] **Шаг 4. Заменить старую проверку «shared/docs-view.ts без импортов» на проверку границы actual common source в задаче 4.** Между шагами она временно проверяет canonical `packages/contracts/src/docs-view.ts`; assertion по отсутствию Node/Electron/require сохраняет защиту. Проверки значений лимитов и ru/en кодов не удалять.
- [ ] **Шаг 5. Запустить contracts tests, целевые Desktop tests и typecheck.** Expected: PASS; число перенесённых тестов не теряется, ошибка не скрыта новым test glob. Из корня под Node 24:

```sh
pnpm --filter @orca-board/contracts test
pnpm --filter @orca-board/desktop exec node --experimental-transform-types --no-warnings --import ./test/ts-resolve.mjs --test src/main/docs-kind.test.ts src/main/notify.test.ts src/main/projects-appearance.test.ts src/main/project-files.test.ts src/main/docs-view.test.ts src/main/preview-protocol.test.ts src/renderer/src/appearance.test.ts src/renderer/src/theme.test.ts
pnpm typecheck
```
- [ ] **Шаг 6. Закоммитить проверенный перенос:** `refactor: перенести общие правила файлов и настроек Orca`.

## Task 3: Desktop API становится явной локальной оболочкой

**Files:**
- Create: `apps/desktop/src/shared/desktop-api.ts`, `apps/desktop/src/shared/desktop-settings.ts`.
- Modify: `apps/desktop/src/shared/ipc.ts`.
- Test: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/preload/api.d.ts`, `apps/desktop/src/renderer/src/docLinks.test.ts`, `apps/desktop/src/renderer/src/attachmentDrafts.test.ts`, `apps/desktop/src/renderer/src/appearance.test.ts`.

**Interfaces:**
- Consumes: DTO/проверки из задач 1–2.
- Produces: прежний `OrcaApi` в desktop-api.ts; прежние AppSettings/AppSettingsPatch/update types/defaults в desktop-settings.ts.
- Produces: ipc.ts как совместимый facade. Внешний consumer не обязан немедленно менять imports; нового runtime/client API эта задача не объявляет.

- [ ] **Шаг 1. Зафиксировать baseline совместимости действующими docLinks/attachmentDrafts/appearance tests.** Appearance.test.ts уже проверяет saveAppSettings/droppedPatch. Existing assertions обязаны пройти до структурного переноса. Typecheck фиксирует readonly windowChrome, optional поздние methods и текущую реализацию preload. Не создавать snapshot-копию OrcaApi или тесты простых reexport aliases; это структурный перенос без нового поведения.

```sh
pnpm --filter @orca-board/desktop exec node --experimental-transform-types --no-warnings --import ./test/ts-resolve.mjs --test src/renderer/src/docLinks.test.ts src/renderer/src/attachmentDrafts.test.ts src/renderer/src/appearance.test.ts
pnpm typecheck
```
- [ ] **Шаг 2. Перенести OrcaApi целиком в desktop-api.ts**, не меняя signatures, optionals, callback unsubscribe и argument order. AppMenuAction/AppMenuItem и TaskTypeExportResult остаются локальными; AppSettings composite и PERMISSION_MODES UI-подписи переезжают в desktop-settings.ts. Локальные modules импортируют common DTO напрямую; ipc.ts экспортирует contracts и локальные API/settings, но они не импортируют ipc.ts обратно — без цикла.
- [ ] **Шаг 3. Повторить команды baseline.** Expected: PASS; прежние preload/main/renderer не требуют изменения каналов. Старый preload без docs даёт прежнее сообщение; старый main без handler распознаётся `isStaleDocsError`; сохранение настройки не принимает молча отброшенный patch.
- [ ] **Шаг 4. Проверить отсутствие изменений IPC/socket/store.** В diff нет новых handle/send channels, изменения `main/index.ts`/`socket.ts`/core store или UI copy. Экспорт AppLanguage/common appearance не вводит новых пользовательских settings и не меняет существующую persistence schema.
- [ ] **Шаг 5. Закоммитить:** `refactor: отделить Desktop API от общих контрактов Orca`.

## Task 4: Границы пакета и автономность сборки проверяются автоматически

**Files:**
- Create: `packages/contracts/test/import-boundaries.ts`, `packages/contracts/test/import-boundaries.test.ts`.
- Modify: `apps/desktop/src/main/docs-kind.test.ts` (финальная замена старого source guard).
- Modify: `CLAUDE.md`, `docs/architecture.md`, `CONTRIBUTING.md` — только фактическая структура и проверки нового пакета.
- Test: root `pnpm verify`, frozen install, local Desktop pack.

**Interfaces:**
- Consumes: canonical package root и реальная public export surface задач 1–3.
- Produces: тестовый `auditContractImports(root: string): ContractBoundaryIssue[]`; root — канонический корень repository/fixture с `packages/contracts/src` и `packages/core/src`. `ContractBoundaryIssue = { file: string; specifier: string; reason: 'node' | 'electron' | 'desktop' | 'outside' | 'dynamic' }`.
- Produces: страж production import graph, включённый в `packages/contracts` test script; отсутствуют публичные product exports тестового checker.

- [ ] **Шаг 1. Создать fixture tests в отдельной временной папке.** AST checker должен видеть import, export-from, type-only import и literal dynamic import. Assertions: разрешён относительный файл внутри contracts/core; отклоняются `node:fs`, bare `fs`, `electron`, relative reexport из apps/desktop и `import(variable)`. JSON core release-codenames допустим как asset. Tests не пишут fixtures в рабочий repository.
- [ ] **Шаг 2. Запустить `pnpm --filter @orca-board/contracts exec node --test test/import-boundaries.test.ts`.** Expected: FAIL с отсутствующим `auditContractImports`; затем реализовать helper на существующем TypeScript compiler API, а не regex, который пропустит reexport или type-only dependency.
- [ ] **Шаг 3. Подключить audit всего `packages/contracts/src` и его транзитивных production dependencies core.** Allowed roots — contracts/src и core/src; Node builtins определяются через `node:module` builtinModules, а не короткий список fs/path. Разрешённый bare workspace import — только `@orca-board/core`. Любой другой external dependency/неразрешимый импорт сообщает file/specifier; dynamic nonliteral и require в common source отвергаются. Все `.ts` source files проверяются, даже если пока не попали в barrel. Test directories исключаются; checker сам остаётся Node-only test utility.
- [ ] **Шаг 4. Проверить public-export surface и compile boundaries.** Для index.ts построить TypeScript Program по tsconfig пакета и получить exports через checker.getExportsOfModule: среди type/value symbols нет TaskStore/Persistence/OrcaApi/AppSettings/UpdateState/WindowChromeMode/AssistantConversation/ConversationOptions. Проверка через runtime namespace недостаточна для type-only exports. `tsconfig` common с `types: []` и ES2022 не получает Node/DOM globals. Main/preload bundle не оставляет внешние imports contracts; browser build не тянет Electron/Node. Не создавать новый Web frontend ради проверки — используется действующий renderer build и import graph.
- [ ] **Шаг 5. Обновить документы фактического состояния.** Описать contracts/facades, private bundled delivery, тестовую команду пакета и отсутствие нового серверного API. В архитектуре отметить, что полный explicit-project service API и product-aware releases — последующие этапы, не уже доступные функции. Команды старого agent client не добавлять.
- [ ] **Шаг 6. Выполнить финальные проверки:** `pnpm install --frozen-lockfile`, contracts tests, `pnpm verify`, `git diff --check`. Node runner и Electron pack используют свой native ABI; при необходимости пересобрать node-pty для tests, как CI, до verify. Expected: все tests/typecheck/build прошли, новые suites обнаружены glob и старые перенесённые suites не исчезли.
- [ ] **Шаг 7. Закоммитить:** `test: закрепить границы общих контрактов Orca`. Push своей feature branch и PR в develop только после зелёного verify; без самостоятельного мержа. Собрать `pnpm --filter @orca-board/desktop run pack`, открыть `apps/desktop/release/local/mac*/orca-board.app`, указать путь и честно передать ручную проверку UI пользователю.

## Приёмка и продолжение

После этого плана Desktop использует общие definitions/functions, а contracts
не зависит от Desktop ни напрямую, ни через export/type-only imports. Прежние
пути импорта остаются совместимыми, main/preload packaging включает TS-package,
и текущие данные/skills/socket/UI работают как раньше.

Полная foundation spec остаётся обязательной для следующих планов:

| Требование утверждённой спецификации | Где выполняется |
| --- | --- |
| Общие DTO и чистая часть правил/инструментов | задачи 1–2 этого плана |
| Явная платформенная граница и старый preload | задача 3 |
| Browser-safe граф и bundled Desktop dependency | задачи 1 и 4 |
| Единые services, request validation, explicit project/client context | следующий план извлечения runtime, рубеж 2 |
| PTY/session host, agent launch, dialogs/resume, observers/replay | рубежи 3–4 |
| Один owner/lock, detach, restart, async Git/effect tokens | рубеж 5 |
| Полный file API, opaque ids, stats/groups/types/workflow parity | рубеж 6 |
| Общий React UI/client transport/platform capabilities | рубеж 7, после service API |
| Linux installed artifact, Node/Electron roots, независимые релизы | рубеж 8 |
| HTTPS/auth/Origin/CSRF/isolated preview origin, server deploy | Web-проект после готовности базы; contracts этого плана не является авторизацией |
| Самостоятельный терминальный чат, установка по SSH и service management | CLI-проект; data/session requirements выполняются общей базой заранее |

Следующий план пишется по результатам первого переноса на актуальной базе:
application services/runtime вместо Electron wiring. Полную базу не объявлять
готовой по факту появления contracts package.

**Execution handoff:** план требует проверки пользователем и выбора исполнения.
Для четырёх последовательных переносов рекомендовано обычное исполнение в этой
сессии: один исполнитель сохраняет контекст compatibility imports, а итоговая
проверка оценивает всю ветку. Вариант с отдельным исполнителем/ревьюером на каждую
задачу остаётся доступным; выполнять задачи до выбора и проверки плана нельзя.
