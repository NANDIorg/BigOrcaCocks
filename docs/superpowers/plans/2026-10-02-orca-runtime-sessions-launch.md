# Общий запуск агентов и терминальные сессии Orca

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Пользователь уже выбрал выполнение автором с отдельным итоговым ревью.

**Goal:** Перенести подготовку команд запуска и lifecycle терминалов в runtime, сохранив рабочий Desktop.

**Architecture:** Runtime предоставляет фабрики AgentLauncher и SessionRegistry. Native PTY внедряет host; события не зависят от окна. Desktop сохраняет старые экспорты, IPC channels и cleanup при выходе main. Общий модуль поиска бинарников используется запуском Windows и обнаружением агентов Desktop.

**Tech Stack:** TypeScript strict, Node 24, pnpm 10.33.0, node:test, Electron/Vite, существующий node-pty в Desktop.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`

## Global Constraints

- Назначенный worktree `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; версия продуктов 1.1.3 без изменений.
- Runtime не импортирует Desktop/Electron/node-pty. Native ABI выбирает host; никаких новых зависимостей и скрытых process.exit listeners в runtime.
- Сохранить quoting и лимиты Windows, Amp JSONC/permissions/MCP, права временных файлов, cleanup при exit/spawn error.
- Сохранить PTY ids, метаданные, IPC, bounded tail 256×1024 единиц UTF-16, порядок exit/changed, before → main, активность ввода и завершение через killAll.
- Disconnect подписчика не останавливает PTY. Ошибка одного подписчика не мешает lifecycle и другим подписчикам; host может регистрировать такие ошибки.
- Это часть этапа исполнения: WorkerService, обнаружение моделей/агентов целиком, dialog drivers, writer leases/client context, ownership и установленный headless ещё предстоят. Не утверждать готовность Web/CLI или реального Node PTY по тестовому порту.
- Документация/комментарии/коммиты по-русски; strict types, без any/console.log.
- Автор выполняет задачи сам; одно итоговое независимое ревью. После pnpm verify собрать и открыть Desktop, обновить PR #59 без merge/release.

## Review Focus

1. Windows npm shim и длинный system prompt сохраняют argv, env и существующие лимиты; native node-pty остаётся в Desktop.
2. Два экземпляра AgentLauncher имеют независимый cleanup; выход main Desktop удаляет незавершённые файлы, обычный импорт runtime не добавляет process listeners.
3. PTY before завершается после kill: основная команда не запускается; resize до выхода подготовки применяется к main; spawn failure не оставляет живую запись.
4. Закрытое/пересозданное окно и отписавшийся/бросающий observer не ломают процесс, tail и другие подписки; выход не дублирует changed после kill.
5. Реальный package entrypoint загружается обычным Node без Electron/native ABI; прежние socket tests проверяют настоящий Desktop PTY отдельно.

## Task 1: Общая подготовка запуска

**Files:**
- Create: `packages/runtime/src/binary-lookup.ts`, `packages/runtime/src/win32-launch.ts`, `packages/runtime/src/agent-launch.ts`.
- Modify: `packages/runtime/src/index.ts`, `apps/desktop/src/main/agents.ts`, `apps/desktop/src/main/win32-launch.ts`, `apps/desktop/src/main/agent-launch.ts`.
- Test: `packages/runtime/test/agent-launch.test.ts`, прежние Desktop agent-launch/win32-launch/attachments suites.

**Interfaces:**
- Produces: `createBinaryLookup({ home?, platform?, env? })` → extraPathDirs/findBin/isCmdScript; прежние defaults читают окружение процесса при вызове.
- Produces: прежний API win32Launch/Win32LaunchEnv/Win32Launch/constants/quote helpers; host передаёт executable и поиск бинарников.
- Produces: `createAgentLauncher({ settingsInvalid(path): Error })` → launchAgent и dispose; экспорт LaunchOptions.
- Desktop сохраняет один launcher и process.once('exit', dispose), OrcaError settingsInvalid; runtime не знает локализацию и lifecycle main.

- [x] Написать тесты package API: реальная защищённая временная копия Amp с JSONC, изоляция двух launcher, cleanup при exit/callback/spawn failure/dispose, host error, Windows long prompt. Поиск проверять настоящими файлами во временном PATH.
- [x] Run: `node --test packages/runtime/test/agent-launch.test.ts`.
  Expected: FAIL — отсутствует общий launcher/lookup.
- [x] Перенести существующие алгоритмы; внедрить локальный cleanup factory и error adapter. Сохранить Desktop exports и существующие тесты без ослабления ожиданий.
- [x] Run: `pnpm --filter @orca-board/runtime typecheck` и `pnpm --filter @orca-board/desktop typecheck`.
  Expected: PASS.
- [x] task-done: `pnpm --filter @orca-board/runtime test`.
  Expected: PASS. Desktop suites запускаются целиком в Task 3, включая настоящий PTY; не менять ABI в общей install root.
- [x] Commit: `refactor: вынести подготовку запуска агентов в runtime`.

## Task 2: SessionRegistry и мост Desktop

**Files:**
- Create: `packages/runtime/src/sessions.ts`, `packages/runtime/test/sessions.test.ts`.
- Modify: `packages/runtime/src/index.ts`, `apps/desktop/src/main/pty.ts`.

**Interfaces:**
- Consumes: contracts PtySpawnOptions/TerminalInfo/TerminalSnapshot; core newId.
- Produces: PtyProcess/PtyFactory/PtyCommand/PtySessionOptions, SessionEvent discriminated union data/exit/changed.
- Produces: `createSessionRegistry({ spawn, onObserverError? })` → subscribe (unsubscribe), прежние spawnPty/writePty/resizePty/killPty/killAll/listTerminals/terminalSnapshots/ptyTail/isAlive/lastActivityAt/silentFor.
- Desktop передаёт node-pty.spawn, подписывается один раз и доставляет старые каналы текущему BrowserWindow; setPtyWindow сохраняет API.

- [x] Написать тесты реестра через управляемый PTY port: snapshots/tail/ANSI/граница буфера, detach/reconnect, два независимых реестра, исключение observer, exit order, before/resize, kill during before, main spawn error, env и input activity. Port заменяет только OS PTY, assertions проверяют реальный lifecycle реестра.
- [x] Run: `node --test packages/runtime/test/sessions.test.ts`.
  Expected: FAIL — отсутствует SessionRegistry.
- [x] Перенести lifecycle в factory, заменить send на subscriptions; Desktop оставить native/BrowserWindow adapter. Поведение default shell и env сохраняется.
- [x] Run: `pnpm --filter @orca-board/runtime typecheck` и `pnpm --filter @orca-board/desktop typecheck`.
  Expected: PASS.
- [x] task-done: `pnpm --filter @orca-board/runtime test`.
  Expected: PASS.
- [x] Commit: `refactor: выделить общий реестр терминальных сессий`.

## Task 3: Проверка поставки и интеграции

**Files:**
- Modify: `packages/runtime/test/core-entry.test.ts`, `docs/architecture.md`, этот план.
- Test: `apps/desktop/src/main/pty.test.ts` — настоящий PTY, подменён только получатель IPC.

**Interfaces:**
- Consumes: package runtime и совместимые Desktop adapters из Task 1/2.
- Produces: plain Node package smoke, сохранённые Desktop socket/launch проверки, описание фактических границ готовности.

- [x] Проверить plain Node entrypoint с registry/launcher: без DISPLAY/Electron, без автоматического exit listener; detach не убивает процесс тестового порта, dispose удаляет реальный временный файл. Это не installed/native PTY smoke.
- [x] Run: `pnpm --filter @orca-board/runtime test`.
  Expected: PASS (characterization перенесённого поведения).
- [x] Обновить архитектуру и отметки плана.
- [x] task-done: `pnpm verify`.
  Expected: PASS — все suites, strict typecheck, production build; включая Desktop настоящий PTY.
- [x] Commit: `test: проверить интеграцию общих сессий и запуска`.
- [ ] Одно итоговое fresh-context ревью диапазона af92d48..HEAD; Critical/Important исправить одним TDD pass, Minor записать.
- [ ] `pnpm --filter @orca-board/desktop run pack`; проверить codesign/app.asar; запустить актуальную сборку, сохранив пользовательские процессы при необходимости.
  Expected: рабочая macOS сборка 1.1.3 с общими реализациями в main bundle.
- [ ] Push своей ветки, обновить PR #59; дождаться успешного CI на точном HEAD, без merge/release.
