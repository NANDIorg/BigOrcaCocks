# Общие правила и статистика — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести правила проекта и статистику в runtime/application API, сохранить Desktop и agent socket, исключить запись найденных session id в удалённый проект.

**Architecture:** Runtime factories получают класс локализуемых ошибок; кэш транскриптов принадлежит экземпляру stats service. RuleCommands синхронны, StatsCommands используют общий async executor с обязательной host policy и проверкой актуальности проекта до commit и выдачи результата. Desktop сохраняет прежние IPC и выбор проекта только на своей границе.

**Tech Stack:** Node24, strict TypeScript, pnpm/node:test, настоящие Git/JSON/файлы/транскрипты.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md` §§3–8,11–12; `docs/orca-foundation-progress.md`.

## Global Constraints

- Продолжение утверждённого фундамента в `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`, inline без повторного approval.
- Runtime не импортирует Desktop/Electron, contracts — Node; прежний CLI HELP/envelope и формат persistence не меняются.
- Правила: только `CLAUDE.md`/`AGENTS.md`, максимум 1 MiB, LF/CRLF и atomic rename, разрешённые внутренние symlink и прежние ошибки сохраняются.
- Статистика: периоды `all`/`7d`/`30d`, прежние фильтры задачи/gate/прогона и DTO; неизвестные id отклоняются до чтения транскриптов.
- `withStatusSource` действует только вокруг синхронного commit, никогда через await. Устаревший проект даёт `command.stale`; чужая policy — `command.forbidden`.
- Файлы/docs/showcase, полноценные EffectToken/Git queues и composition остаются следующими переносами. Один final review/pack/open после всего фундамента.

## Review Focus

- Malformed context/payload и forbidden раньше project lookup/диска; выходные DTO не разделяют ссылки со store.
- Symlink за пределы проекта, broken link, каталог и слишком большой UTF-8 текст не повреждают файлы.
- Два проекта/клиента не используют общий activeId; кэши двух runtime не разделяют состояние.
- Удаление проекта или замена dispatch во время чтения не записывают поздний session id; обычное изменение соседней задачи не отменяет чтение.
- Desktop async rejection локализована на русском/английском; проверка caller предшествует legacy selection; старый socket вызывает тот же rules service.

### Task 1: Runtime services, contracts и async command boundary

**Files:** create contracts `rule-commands.ts`, `stats-commands.ts`; modify contracts context/errors/barrel; create runtime `rules.ts`, `stats.ts`, `rule-commands.ts`, `stats-commands.ts`, `async-project-commands.ts`; modify runtime executor/barrel; create runtime tests `rules.test.ts`, `stats.test.ts`, `rules-stats-commands.test.ts`, `async-project-commands.test.ts`; add Desktop ru/en `command.stale`; обновить четыре docs и dashboard.

**Interfaces:**
- `createRuleServices({messages})` → прежние `ruleFileName/readRule/listRules/writeRule` и валидатор `ruleText`; чистые EOL helpers и лимит экспортируются.
- `createStatsServices({messages})` → `projectStats/taskStats/globalTaskStats`; StatsDeps дополнены `isCurrent?` и синхронным `commit?`, cache factory-local.
- `createAsyncProjectCommandExecutor(host)` → async execute; host `project/authorize/isCurrent`, operation `(project, context, scope)`; scope `isCurrent()` и `commit(operation)`.
- `createRuleCommands(host)` → list/read/save с явным ProjectCommandContext.
- `createStatsCommands(host)` → project/task/global с явным ProjectCommandContext, StatsDeps/workflow от хоста; range и id проверяются до lookup.

- [ ] **Step 1:** Failing factory/assertion tests с реальным ProjectManager/Git/JSON, реальными Claude/Codex транскриптами; invalid/forbidden ordering, explicit A/B, detached DTO, whitelist/UTF-8/EOL/symlink, subset stats, cache isolation, delayed project removal/dispatch replacement и независимый sync attribution во время await.
- [ ] **Step 2:** Targeted `node --test packages/runtime/test/{rules,stats,rules-stats-commands,async-project-commands}.test.ts` под Node24; Expected FAIL из-за отсутствующего API при успешных импортах.
- [ ] **Step 3:** Реализовать factories/contracts/executor; перенести алгоритмы без замены статистической модели и JSON.
- [ ] **Step 4:** Targeted + полный runtime и contracts suites, contracts/runtime/Desktop typecheck; Expected PASS, без выключения прежних suites.
- [ ] **Step 5:** Docs/diff/staged diff и commit точных paths; task-done повтор targeted suite.

### Task 2: Desktop IPC/socket и compatibility facades

**Files:** modify Desktop `rules.ts`, `stats.ts` как common facades, main/index.ts и project-command-adapter.ts (async error translation); create `rules-stats-commands.ts` и `.test.ts`; четыре docs/dashboard/план обновляются вместе с подключением.

**Interfaces:**
- `registerDesktopRulesStatsCommands(handle, host)` регистрирует ровно `rules:list/save`, `stats:project/task/global`; RuleCommands/StatsCommands и verified caller внедряются.
- Rules сохраняют legacy active selection, stats — explicit projectId. Common stats deps захватывают project/store identity; socket rules использует общий facade без новых agent полномочий.
- `invokeDesktopCommand` переводит синхронную и Promise ошибку без удержания общего attribution через await.

- [ ] **Step 1:** Failing adapter tests с real services/manager/файлами/транскриптами: caller до selection, A/B и legacy DTO, invalid range/id, sync/async ru/en ошибки, удаление проекта во время чтения.
- [ ] **Step 2:** `pnpm --filter @orca-board/desktop exec tsx --test src/main/rules-stats-commands.test.ts`; Expected FAIL missing register factory при успешном импорте.
- [ ] **Step 3:** Подключить пять IPC к общим commands, заменить facades; оставить protocol/caller authorization прежними.
- [ ] **Step 4:** Desktop affected rules/stats/socket suites, typecheck, полный `pnpm verify`; Expected PASS.
- [ ] **Step 5:** Docs/diff/staged diff/commit, task-done affected suite; продолжить оставшийся application API без handoff.
