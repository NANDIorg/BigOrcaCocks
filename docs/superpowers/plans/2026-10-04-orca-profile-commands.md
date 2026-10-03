# Общие команды профиля и настроек проектов — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить библиотеку типов/шаблонов, настройки, onboarding, группы и конфигурацию проектов к общему application API без выбора проекта другого клиента.

**Architecture:** ClientCommandContext без обязательного projectId для профиля; ProjectCommandContext для конфигурации конкретного проекта. Обязательная host policy, whitelist и shape validation до manager/project lookup, detached DTO. Существующий ProjectManager и его guards/persistence переиспользуются; Desktop хранит legacy selection и native folder/file dialogs на своей границе. Workflow assistant context/save становятся runtime factory с host messages.

**Tech Stack:** Node24, strict TypeScript, pnpm/node:test, реальные Git/JSON/ProjectManager.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md` §§3–4,7–8,11–12; общий статус `docs/orca-foundation-progress.md`.

## Global Constraints

- Worktree `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; продолжение review/request плана, inline без промежуточного approval.
- Нет изменений JSON version, продукта/release versions, IPC names или agent CLI HELP/envelope.
- Public profile API не читает/меняет activeId. ProjectManager.add получает optional select=false для общего API; default сохраняет прежний Desktop/socket.
- Host Settings/Patch generic ограничены RuntimeSettings; дополнительные Desktop fields разрешает только явный host settings key list. Native dialogs, menu/tray/update refresh остаются в Desktop.
- Один fresh final review всего оставшегося фундамента после других рубежей, mandatory pack/open по итогам всей задачи.

## Review Focus

- Невалидный/подменённый context и policy отказ раньше lookup/files; command result не разделяет ссылки с manager.
- Чужой project id не действует на active project; groups/types/template guards и rollback settings/workflow сохраняются.
- Два client context не меняют чужой selection; onboarding без проекта доступен, повтор complete не понижает статус.
- Workflow baseline/revision conflict до записи, приватные extraArgs не уходят в assistant context, новый export metadata принадлежит host.
- Desktop caller проверяется до folder/file dialogs, async IPC errors локализованы, старые defaults/return DTO сохранены.

### Task 1: Общий profile/config API и workflow assistant

**Files:** create contracts `profile-commands.ts`, `project-config-commands.ts`; modify `project-commands.ts` context и barrels; create runtime `profile-commands.ts`, `profile-command-input.ts`, `project-config-commands.ts`, `workflow-assistant.ts`; modify runtime executor/project-messages/projects/barrel; create tests `profile-commands.test.ts`, `profile-command-test-host.ts` и `workflow-assistant.test.ts`; четыре docs обновляются вместе с API.

**Interfaces:**
- ClientCommandContext `{clientId,actor}`; ProjectCommandContext extends ClientCommandContext.
- createClientCommandExecutor(host) проверяет context/policy и clone/errors так же, как project executor, без project lookup.
- createProfileCommands<S,P>({manager,authorize,settingsKeys?,exportMeta}) → ProfileCommands<S,P>: projects/groups/add/remove/detect/counts; group CRUD/reorder; settings/onboarding; task types list/save/patch/rename/delete/duplicate/default/export; templates list/save/delete; workflow get/validate/set/create/saveDraft/context. Каждый метод получает context первым аргументом; public list не содержит active.
- createProjectConfigCommands({manager,authorize}) → enabledAgents/columns/taskTypes/group с явным project context и прежними project guards.
- createWorkflowAssistantServices({messages}) → saveWorkflowDraft/buildWorkflowAssistantContext на переданном manager, прежние ошибки contextInvalid/conflict и содержимое промпта.

- [x] **Step 1:** Реальные fixture tests с missing factory assertions: context/policy/invalid payload раньше lookup, input/output isolation, сохранение/reload, group lifecycle, scoped project changes, selection после add, настройки/rollback/onboarding, CRUD типов/шаблонов, export host metadata, workflow context/conflict.
- [x] **Step 2:** Targeted node:test под Node24; Expected FAIL factories при успешном импорте.
- [x] **Step 3:** Минимальная реализация contracts/executors/factories и перенос workflow helper без изменения workflow engine.
- [x] **Step 4:** Contracts/runtime typecheck, targeted tests, полный runtime suite; Expected PASS. Прежние project/settings/workflow tests не выключать.
- [x] **Step 5:** Diff/staged diff, commit точных paths; task-done повтор targeted suite. Обновить docs вместе с общим API.

Task1: targeted35/35, runtime730/730, contracts50/50, core943/943; typechecks
contracts/runtime/Desktop PASS, fail/cancel/skip0. Desktop IPC подключается Task2.

### Task 2: Desktop IPC и совместимость workflow helper

**Files:** create Desktop `profile-commands.ts` и `.test.ts`; modify main/index.ts, `assistant-workflow.ts` как compatibility factory, архитектура/workflow/nested-kanban/human-requests и общий статус.

**Interfaces:**
- registerDesktopProfileCommands(handle,host) получает общий ProfileCommands и ProjectConfigCommands, verified clientId, explicit legacy active/list selection, native pickFolder/exportFile и settingsChanged ports.
- app settings/onboarding, groups/projects configuration, taskTypes/nodeTemplates/workflowAssistant прежние IPC вызывают общий API. projects:setActive остаётся только legacy Desktop selection; add/detect/file export выполняют native dialog после caller validation. Project Git — следующий отдельный async перенос.
- main socket продолжает использовать прежний trusted ProjectManager; его services уже общие, agent command policy/envelope без расширения.

- [ ] **Step 1:** Failing adapter tests verified caller до selection/dialogs, explicit ids, defaults, settings side effects, no-selection onboarding/list, native cancel, workflow errors ru/en и return shapes.
- [ ] **Step 2:** Desktop targeted node:test; Expected FAIL register factory при успешном импорте scaffold.
- [ ] **Step 3:** Реальный adapter/main wiring и compatibility helper; четыре docs/статус в том же коммите.
- [ ] **Step 4:** Desktop typecheck, targeted+affected suites и полный verify под Node ABI; Expected PASS.
- [ ] **Step 5:** Diff/staged diff, commit точных paths, task-done targeted repetition; продолжить рубеж A (files/docs/rules/stats и remaining lifecycle), без пользовательского handoff.
