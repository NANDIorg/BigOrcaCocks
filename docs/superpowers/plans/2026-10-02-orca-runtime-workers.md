# Общие воркеры и координатор Orca

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Пользователь выбрал выполнение автором и одно отдельное итоговое ревью; продолжение переноса уже разрешено.

**Goal:** Запускать существующих воркеров, координатора и терминального ассистента через runtime без Electron, сохранив Desktop.

**Architecture:** Общие фабрики получают сообщения, Git, PTY registry, launcher и явный контекст хоста. Работа с ветками прогонов, возобновлением и вложениями переносится вместе с запуском. Desktop сохраняет прежние экспорты и передаёт свои userData, ресурсы, язык, shell и Node executable.

**Tech Stack:** TypeScript strict, Node 24, pnpm 10.33.0, node:test, существующие Git/node-pty/Electron/Vite.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`

## Global Constraints

- Использовать назначенный `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; версии 1.1.3 не менять.
- Runtime не импортирует Desktop/Electron/node-pty, включая type-only imports. Native backend и ABI выбирает host.
- Сохранить schemas, пути Desktop, guards, IPC/socket/HELP, роли, prompt instructions, permission modes и extraArgs. Новых зависимостей нет.
- Git вызывается массивом аргументов без shell. Синхронные операции сохраняются в этом переносе; async queues/effect tokens — последующий рубеж.
- Host явно передаёт dataDir, CLI bin, Node executable, prompts, язык, shell, PATH dependencies и Windows launch options. Импорт runtime не добавляет lifecycle hooks.
- Отписка клиента сохраняет исполнение; ошибка запуска не оставляет новый открытый прогон или файлы старта. Возобновление сохраняет существующий прогон и вложения возвратов.
- Это срез этапа исполнения: workflow/review executors и wiring main/index.ts, обнаружение моделей, dialog registry, ownership/leases/replay и установленный headless ещё предстоят.
- Комментарии, документация и коммиты по-русски; strict types, без any/console.log. Автор выполняет все задачи, затем одно независимое ревью.
- Перед сдачей pnpm verify, локальный pack/open, push собственной ветки и обновление PR #59; без merge/release.

## Review Focus

1. Снимок роли с испорченными extraArgs или удалённой ролью отвергается до создания ветки/dispatch/прогона; прежний живой процесс не затрагивается.
2. Два экземпляра services с разными profile/language/PATH/session registry не смешивают окружение и процессы; отписка observer не останавливает worker.
3. Координатор повторно получает сохранённые и новые вложения в прежнем порядке и лимитах; отказ spawn сохраняет возвраты существующего прогона и закрывает только новый.
4. Windows сохраняет отдельный setup before, npm quoting/long prompt options и регистр PATH; Unix setup не теряет аргументы с пробелами и кавычками.
5. Ветки параллельных прогонов, старые прогоны без ветки и исчезнувший worktree сохраняют прежние правила; native smoke без окна доказывает запуск, но не установленную поставку/очистку ConPTY долгоживущего owner.

## Task 1: Общие ресурсы исполнения

**Files:**
- Create: `packages/runtime/src/execution-messages.ts`, `execution-resources.ts`, `run-branch.ts`, `coordinator-resume.ts`, `attachments.ts`, `run-images.ts`, `launch-policy.ts`.
- Modify: `packages/runtime/src/index.ts`, `extra-args.ts`; Desktop `main/run-branch.ts`, `coordinator-resume.ts`, `attachments.ts`, `run-images.ts`, `launch-extra-args.ts`, `assistant.ts`, `agents.ts`; create `main/execution-resources.ts`.
- Test: runtime `execution-resources.test.ts`, `attachments.test.ts`, `run-images.test.ts`; Desktop прежние run-branch/global-review/extraArgs/assistant suites.
- Modify: `docs/architecture.md`.

**Interfaces:**
- Consumes: `createGitOperations`, browser-safe AttachmentCapabilities/attachmentOpenable, core TaskStore/roles/prompts/extraArgs.
- Produces: `ExecutionMessages.error(key: ExecutionMessageKey, params?: ExecutionMessageParams): Error`, recursive ExecutionMessage; `ExecutionLogger.warn(message: string, detail?: string): void`.
- Produces: `createExecutionResources({ messages, git, logger })` → прежние методы веток прогонов, resume/return, attachments/run-images, `roleLaunchExtraArgs`, `assistantLaunch`; `ExecutionResources = ReturnType<typeof createExecutionResources>`.
- Produces: shared `parseLaunchExtraArgs(text: string | undefined, invalid: (reason: ExtraArgsMessage) => Error): string[]`, `missingRoleText`, `assistantEnv`, `assistantCwd`; Desktop сохраняет launchExtraArgs callback MText и OrcaError.
- Desktop singleton ресурсов используется прежними facades; native/window/language state в ресурсах отсутствуют.

- [x] Добавить тесты общего API с реальным Git/TaskStore/диском: независимые ветки, восстановление worktree, legacy run, guard возврата до stop, partial-write rollback и сохранение referenced return files. Перенести suites attachments/run-images на общий пакет с тестовым классом ошибки вместо Desktop i18n.
- [x] Run: `node --test packages/runtime/test/execution-resources.test.ts`.
  Expected: FAIL — общей фабрики ещё нет.
- [x] Перенести существующие алгоритмы в указанные модули; внедрить typed messages/logger/Git. Сохранить все старые именованные exports через Desktop facades, добавить документацию границы.
- [x] Run: `pnpm --filter @orca-board/runtime typecheck` и `pnpm --filter @orca-board/desktop typecheck`.
  Expected: PASS.
- [x] task-done: `pnpm --filter @orca-board/runtime test`.
  Expected: PASS. Desktop совместимость целиком проверяется в Task 3.
- [x] Commit: `refactor: вынести ресурсы исполнения Orca в runtime`.

## Task 2: Общий сервис запуска

**Files:**
- Create: `packages/runtime/src/workers.ts`, `packages/runtime/test/workers.test.ts`.
- Modify: `packages/runtime/src/index.ts`, `apps/desktop/src/main/worker.ts`, `docs/architecture.md`.

**Interfaces:**
- Consumes: Task 1 ExecutionResources/ExecutionMessages, прежние AgentLauncher.launchAgent и SessionRegistry spawnPty/isAlive/killPty.
- Produces: `WorkerHostContext { dataDir: string; cliBinDir: string; nodePath?: string; prompts: BuiltinPrompts; language(): AgentLanguage; shell(): string; extraPathDirs(): string[]; launchOptions(): LaunchOptions; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }`.
- Produces: `createWorkerServices({ host, resources, messages, sessions, launcher })` → `startWorker`, `startCoordinator`, `returnToWork`, `startAssistant`, `workerPath`; прежние сигнатуры результатов и WorkerEnvContext/AssistantContext.
- Desktop получает Electron paths только в своём adapter, сохраняет cliBinDir/pruneLaunchTempFiles и все функции worker.ts; запуск использует те же singleton launcher и PTY registry.

- [x] Написать тесты реальных store/Git/resources/launcher/registry с управляемым OS PTY port: worker dispatch/env/prompts/повторный ответ/role override; coordinator resume/attachments/exit escalation/rollback; возврат закрывает прежний терминал; assistant neutral cwd; два host контекста; Windows before и Unix quoted setup.
- [x] Run: `node --test packages/runtime/test/workers.test.ts`.
  Expected: FAIL — общий сервис ещё отсутствует.
- [x] Перенести worker.ts в factory, заменить Electron/i18n/path discovery на host context, сохранить последовательность guards/effects и ошибки.
- [x] Run: `pnpm --filter @orca-board/runtime typecheck` и `pnpm --filter @orca-board/desktop typecheck`.
  Expected: PASS.
- [x] task-done: `pnpm --filter @orca-board/runtime test`.
  Expected: PASS.
- [x] Commit: `refactor: выделить общий сервис воркеров и координатора`.

## Task 3: Интеграция без окна и совместимость Desktop

**Files:**
- Modify: `packages/runtime/test/core-entry.test.ts`, `workers.test.ts`, `docs/architecture.md`, этот план.
- Replace: Desktop `agent-language.test.ts` source guards → behavioral runtime tests языка/флагов/окружения/cleanup.
- Create: `apps/desktop/src/main/worker-runtime.test.ts` (native test host использует существующий node-pty, не меняя dependency runtime).

**Interfaces:**
- Consumes: общий package entrypoint из Tasks 1–2, настоящий Git, native PTY host Desktop.
- Produces: Node smoke без Electron loader/DISPLAY и сценарий coordinator → worker → результат/review на общем сервисе, detach → output/exit, ошибки fixture дают ненулевой exit.
- Native scenario выполняется в дочернем fixture owner с явным timeout/cleanup; Windows conout worker не удерживает родительский test runner.

- [x] Добавить package smoke, который создаёт общий сервис под обычным Node без Electron и проверяет реальные изменения store; native fixture запускает безопасную тестовую команду вместо платного LLM, проверяет вывод/exit и состояние задачи.
- [x] Run: targeted Node/native tests.
  Expected: FAIL при отсутствии соответствующего host wiring/assertions; затем PASS после подключения.
- [x] Run: `pnpm verify`.
  Expected: PASS всех пакетов, guards, typecheck и build.
- [x] Commit: `test: проверить общие воркеры без окна Electron`.
- [x] Одно итоговое независимое ревью диапазона этого плана, исправления Important/Critical через RED→GREEN, pnpm verify после исправлений.
- [x] Записать результат и оставшиеся рубежи в план/docs; сохранить ledger и проверки вне scratch, удалить только workspace этого плана.
- [x] Собрать и открыть Desktop; проверить упакованный runtime.

Перед сдачей: push/update PR #59 и CI точного HEAD; результат подтверждается checks
последнего коммита в PR. Не сливать PR и не выпускать релиз.

## Самопроверка плана

Этот план реализует часть рубежа 3 и необходимые для неё файловые зависимости рубежа 6. Все пять Review Focus закреплены Task 1/2/3. Сигнатуры factories согласованы: сообщения/ресурсы Task 1 потребляются сервисом Task 2 и Node/native hosts Task 3. Остальные требования общей спецификации сохранены как следующие этапы, завершение всей базы этим переносом не объявляется.

## Результат исполнения

Общие ExecutionResources/WorkerServices подключены к Desktop через совместимые
facades; Node entrypoint и native сценарий без окна работают. Одно независимое
ревью диапазона `8f05546..9e9ee04` нашло один Important: возврат в работу менял
store и закрывал прежний PTY до проверки роли. В `082d775` добавлен общий preflight
роли/агента/extraArgs; два регрессионных теста показали RED→GREEN и сохранение
снимка/живого процесса. Critical/Minor в этом ревью нет; второго ревью не требовалось.

После исправления `pnpm verify` прошёл: **3280/3280**, ноль failures/skips/cancellations,
runtime 178, Desktop 2034; typecheck, package boundaries и build проходят. Отдельные
core-проверки документации: 934/934. Ledger, review package и логи сохранены в
`/private/tmp/orca-runtime-workers-*`; удалён только scratch этого плана.
Local mac x64 pack проверен через codesign и настоящий app.asar: общие пакеты
встроены, WorkerServices/ExecutionResources присутствуют. Новый main и renderer
запущены из `apps/desktop/release/local/mac/orca-board.app`.

Далее: workflow/review executors и полный wiring main, discovery версий/моделей,
диалоги и защита поздних ответов; затем owner lock/reconciliation, leases,
client context/auth/replay/backpressure и async Git/commonDir/EffectToken. Проверка
установленного Linux host вне workspace с отдельным Node install root и cleanup
ConPTY долгоживущего owner остаются обязательными. UI проверяет пользователь
в локальном Desktop. Версия продукта остаётся 1.1.3; merge/release не выполняются.
