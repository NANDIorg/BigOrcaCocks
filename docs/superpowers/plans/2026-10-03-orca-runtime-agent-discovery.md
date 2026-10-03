# Общий поиск агентов и выбор роли Orca

> **For agentic workers:** Execute inline with superpowers:executing-plans; one fresh final review. Пользователь уже подтвердил самостоятельное выполнение переноса и итоговое ревью.

**Goal:** Обнаружение CLI, чтение версий/моделей и проверка выбора агента/роли доступны через общий Node runtime. Desktop сохраняет прежние exports, сообщения, UI и данные.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, этап 3.

**Architecture:** `createAgentDiscovery(options)` владеет двумя локальными кэшами. Хост задаёт home/codexDir/platform/env; clock и исполнение команды версии можно передать как порты. `createAgentSelection(messages)` выполняет общие проверки через ошибки хоста. Desktop создаёт совместимые singleton adapters.

**Tech Stack:** TypeScript strict, Node 24, node:test, существующие core/runtime и Electron adapter. Новых зависимостей нет.

## Global Constraints

- Назначенный worktree `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; база среза `55338a6c7e848b722019ed2c0fc8732fd275bccd`. Не переключать root checkout.
- Runtime не импортирует Desktop/Electron/node-pty; browser contracts не получают Node dependencies.
- Сохранить порядок AGENTS, supportsExtraArgs, project enabledAgents, TOML parsing, fallback моделей и ошибок чтения. Кэш установки живёт до refresh, Codex config — 60 секунд; refresh перечитывает оба.
- Версия: установленный бинарник остаётся установленным при ошибке/timeout, первая непустая строка до 60 символов, timeout 3000 мс. Windows cmd/bat сохраняют shell invocation, прочие бинарники — argv без shell.
- Явное окружение используется и для lookup, и для запуска версии. Без overrides Desktop использует текущие home/platform/process.env. Пути не мигрируются.
- Выбор роли сохраняет guards до эффектов, неизвестный/не установленный/выключенный агент — прежние коды. Отсутствующая роль — прежнее вложенное сообщение; несколько ролей без выбора — прежний текст для agent client.
- Не менять schema/events/IPC/socket/HELP, legacy CLI, product versions, интерфейс и инструкции агентов.
- Самостоятельных discovery suites в Desktop нет; смешанный launch-extra-args suite остаётся там. Новые общие проверки запускаются runtime test glob.
- Перед сдачей pnpm verify, отдельное итоговое ревью, pack/open и проверка app.asar, обновление существующего PR #59/push/CI точного HEAD. Без merge/release.

## Review Focus

1. Два discovery services не смешивают home/config/env и кэши; refresh одного не меняет другого. Config TTL и перечитывание нового PATH сохраняют правила Desktop.
2. Ошибка запуска/timeout/пустой вывод версии не превращает установленный агент в отсутствующий; Windows quoting/shell и POSIX argv остаются корректными, env доходит до процесса.
3. Отсутствующий/битый config и models cache дают прежние defaults/fallback; top-level TOML не читает секции, скрытые модели/default model обрабатываются core parser.
4. Выбор роли проверяет агента до любых эффектов; ошибки и вложенные параметры не зависят от глобального языка runtime. Desktop сохраняет русский message и перевод IPC после смены языка.
5. Package entrypoint работает в обычном Node без Electron loader/DISPLAY; Desktop использует общий сервис, сохраняя старые imports и supportsExtraArgs. Native PTY и legacy CLI не меняются.

## Task 1: Обнаружение CLI и моделей

**Files:** create `packages/runtime/src/agent-discovery.ts`, `packages/runtime/test/agent-discovery.test.ts`; modify runtime `src/index.ts`, `docs/architecture.md`.

**Interfaces:**
- `DetectedAgent { id: AgentKind; installed: boolean; version?: string }`.
- `AgentVersionCommand { file: string; args: string[]; timeout: number; shell?: true; env?: NodeJS.ProcessEnv }`.
- `AgentDiscoveryOptions extends BinaryLookupOptions { codexDir?: string; now?: () => number; executeVersion?: (command: AgentVersionCommand) => string }`.
- `createAgentDiscovery(options?: AgentDiscoveryOptions)` → `detectAgents(refresh?: boolean)`, `agentInfos(enabledAgents: AgentKind[] | undefined, refresh?: boolean)` и методы BinaryLookup. `parseTopLevelToml(text)` экспортируется.

- [x] Добавить тесты API на настоящих временных файлах: PATH/installed/enabled/version, два home/config, cache/refresh/TTL, TOML sections/quotes, broken/missing config/cache, версии/пустой вывод/ошибка/timeout, Windows cmd port и явное окружение.
- [x] Run: `node --test packages/runtime/test/agent-discovery.test.ts`. Expected: FAIL — factory отсутствует.
- [x] Перенести алгоритмы из Desktop agents.ts в factory, внедрить пути/окружение/clock/version port; экспортировать runtime API и описать границу в architecture.
- [x] Run: runtime typecheck/tests и core docs tests. Expected: PASS; версия реально исполняется безопасным fixture CLI без платного LLM.
- [x] Commit: `refactor: вынести обнаружение агентов и моделей в runtime`.

## Task 2: Общие проверки агента и роли

**Files:** create `packages/runtime/src/agent-selection.ts`, `packages/runtime/test/agent-selection.test.ts`; modify runtime `src/index.ts`, `docs/architecture.md`.

**Interfaces:**
- `AgentSelectionErrorKey`: agent.unknown/notInstalled/disabled, role.missing; params — ExecutionMessageParams (включая common.none и role.missing.*).
- `AgentSelectionMessages { error(key: AgentSelectionErrorKey, params?: ExecutionMessageParams): Error }`.
- `AgentSelectionServices { assertAgentUsable(agents: AgentInfo[], id: string): asserts id is AgentKind; pickRole(type: RoleSource, agents: AgentInfo[], requested: string | undefined): Role }`.
- `createAgentSelection(messages: AgentSelectionMessages): AgentSelectionServices` — прежние алгоритмы и сообщения; missingRoleText общий из launch-policy.

- [x] API-тесты: unknown/notInstalled/disabled с пустым и непустым enabled, явная и единственная роль, отказ при отсутствии роли/нескольких ролях без выбора, неизвестный/неустановленный/выключенный агент роли, независимые error factories.
- [x] Run: `node --test packages/runtime/test/agent-selection.test.ts`. Expected: FAIL — factory отсутствует.
- [x] Вынести проверки с injected messages, сохранить сужение AgentKind и неизменность inputs; описать границу в architecture.
- [x] Run: runtime typecheck/tests и core docs tests. Expected: PASS.
- [x] Commit: `refactor: вынести выбор агента и роли в runtime`.

## Task 3: Desktop adapter и сдача

**Files:** modify `apps/desktop/src/main/agents.ts`, create `apps/desktop/src/main/agents.test.ts`; modify runtime `test/core-entry.test.ts`, `docs/architecture.md`, этот план.

**Interfaces:** Desktop сохраняет все exports через singleton discovery/selection и OrcaError. parseTopLevelToml/DetectedAgent/RoleSource/missingRoleText совместимы. missingRoleMessage переводится на русский прежним mtIn.

- [x] Добавить consumer tests: русский message/код и IPC-перевод после смены языка, роль/guards, общий discovery через package entrypoint без Electron/DISPLAY с реальными config/bin fixtures.
- [x] Run: новые Desktop и package entrypoint tests. Expected: PASS — это consumer characterization уже проверенных RED→GREEN factories; Desktop tests фиксируют совместимость до и после замены adapter.
- [x] Подключить Desktop к общим factories и добавить Node smoke; обновить оставшиеся рубежи docs.
- [x] Run: Desktop targeted tests, runtime/desktop typecheck, затем `pnpm verify`. Expected: PASS без пропусков.
- [x] Commit: `refactor: подключить Desktop к общему обнаружению агентов`.
- [x] Одно fresh-context ревью диапазона среза; один RED→GREEN проход Important/Critical, Minor записать как deferred.
- [x] Записать результат, сохранить evidence вне scratch и удалить только scratch этого плана. Собрать/open Desktop, проверить codesign и app.asar.

Перед итоговой сдачей: update PR #59/push и зелёный CI точного HEAD; это внешние проверки после финального коммита документации, без merge/release.

## Самопроверка

Task 3 использует factories Tasks 1–2, остальные задачи не разделяют изменяемое состояние.
Срез закрывает обнаружение/выбор агентов этапа 3. Диалоги, owner/client context,
async Git, общий UI, installed Linux и независимая поставка остаются следующими
рубежами; готовность всей базы и начало Web здесь не заявляются.


## Результат переноса

Общие createAgentDiscovery/createAgentSelection доступны через Node runtime;
Desktop agents.ts стал совместимым adapter без изменения UI, схем, IPC/socket/HELP,
legacy CLI и версии 1.1.3. Пути/окружение и caches принадлежат экземпляру; refresh,
60-секундный TTL, version timeout/fallback, models и вложенные ошибки сохранены.

Добавлены 33 сценария: 28 runtime, 5 Desktop. Полный pnpm verify: 3345/3345,
failures/skips 0, strict types/build PASS. Обычный Node package smoke: 4/4;
реальный безопасный fixture CLI проверяет argv/env/timeout без платного LLM.
Независимый reviewer: runtime31/31 и Desktop38/38 PASS, регрессий переноса нет.
Отложен Minor: архитектурное описание guards до любых store/Git effects шире
реального orchestration-порядка старого runWorker.

Существующий runWorker сначала подготавливает workflow, затем проверяет агента.
При отказе disabled/notInstalled могут остаться branch/worktree, измениться
stage/visits, очиститься stageBlock или отмениться прежний approval. PTY до guard
не закрывается. Простой перенос проверки выше enterWork не учитывает роль
work/ask и подготовительные Git outcomes; общий preflight/контракт этих эффектов
обязательно уточнить при следующем service wiring, до готовности Web. Чистота
selection factory не означает атомарность всей команды запуска.

Локальный mac x64 pack 1.1.3 собран и открыт:
`/private/tmp/orca-web-migration-audit/apps/desktop/release/local/mac/orca-board.app`.
Codesign strict/deep проходит; настоящий app.asar содержит новые shared factories
и предыдущие services, bare imports private пакетов отсутствуют. UI проверяет
пользователь. Назначенный worktree сохранён; review/ledger/RED/GREEN/verify/pack
сохраняются в `/private/tmp/orca-runtime-agent-discovery-evidence`.

Следующие рубежи: общие диалоги/transcripts/AssistantSession и observers,
application/launch preflight, owner/client context/lock/bootstrap, async Git и
async discovery/commonDir/effect tokens, полный file API, общий client/UI,
installed Linux и независимая продуктовая поставка. Синхронный refresh версий
может блокировать host до 3 секунд на CLI; responsive owner здесь не заявлен.
Вся база и Web ещё не готовы; новый CLI пока не создаётся.
