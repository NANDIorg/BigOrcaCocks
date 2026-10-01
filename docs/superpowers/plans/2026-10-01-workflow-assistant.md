# Workflow Assistant Implementation Plan

**Goal:** Обсуждать, создавать и менять графы через существующий ассистент и открывать результат в редакторе.
**Architecture:** Общая библиотека типов, новые узкие CLI/socket команды, общий валидатор и раскладка; контекст редактора передаётся через обнаружимый IPC в существующий чат.
**Tech Stack:** TypeScript, React, Electron, node:test, автономный JS CLI.
**Spec:** `docs/superpowers/specs/2026-10-01-workflow-assistant.md`.

## Global Constraints

- Рабочий worktree `/private/tmp/orca-workflow-assistant`, ветка `feature/workflow-assistant`. Один пишущий агент за раз; не создавать субагентов самостоятельно.
- Не коммитить до общей проверки: код, тесты, docs и skills одной фичи входят в один коммит по CLAUDE.md. Отчёты и пакеты ревью только в игнорируемом workspace.
- Без новых зависимостей. Core, импортируемый renderer, без node API; CLI без npm импортов.
- UI через ru/en; main через mt/OrcaError; новые IPC во всех четырёх точках, старый preload обнаруживается.
- Не сохранять непроверенный граф, не менять остальные настройки типа, не перезаписывать устаревшую ревизию, не запускать задачи.
- Несохранённый граф передаётся без автосохранения; пользовательский текст не заменяется и не отправляется автоматически.
- Инженерные тесты без автоматического обхода интерфейса. В конце pnpm verify, pack и запуск приложения.

## Task 1: Модель и инструменты воркфлоу

Сначала добавить и запустить падающие поведенческие тесты. Реализовать схему, рекурсивную проверку JSON и подготовку координат в core. Вынести существующую чистую autoLayout из renderer в общий модуль, сохранив геометрию и старые импорты. Разместить новые тесты рядом с модулем core.

В ProjectManager добавить workflow get/validate/set/create. Ревизия SHA-256 всего сохранённого типа, атомарный compare-and-patch. Использовать действующие парсер, миграции, validateWorkflow и patchTaskType. Структурированные ошибки/предупреждения. Новое создание целиком проверяется до вставки. Сохранять настройки и снимки текущих прогонов. Не выдавать extraArgs. Тесты в main root: invalid/malformed/nested, revision/roles/title/deletion, restart, no side effects.

Добавить socket handlers и зависимости в main/index.ts; `workflowAssistant:saved` — узкое событие успешных новых workflow.set/create: `{typeId,title,revision}`. Пока без preload подписки. Все команды app-level без обязательного проекта. types list --all для библиотеки, прежние команды совместимы.

CLI HELP и обработка inline `--definition` / `--file`, обязательные type/revision/title, ошибки JSON до обращения к socket. validate принимает необязательные type/base-type, create необязательные base-type/description. Тесты payload и HELP в packages/cli/test/cli.test.js. Socket тесты в root main, тестовые deps обновить. Не править UI за пределами переноса autoLayout и сохранения совместимых экспортов.

Файлы: packages/core/src/workflow*.ts, index.ts; apps/desktop/src/main/projects.ts, socket.ts, index.ts и их root tests/deps; packages/cli/bin/orca-board.js и cli.test.js; renderer/src/workflowGeometry.ts.

## Task 2: Контекст редактора и чат

Прочитать контракты Task 1 и DESIGN.md. Добавить shared WorkflowAssistantContext (`create` либо `edit` с typeId/title, workflow, baseline, dirty, path) и WorkflowAssistantSaved. IPC assistantChat.sendWithWorkflow плюс workflowAssistant.onSaved во всех четырёх точках. Main проверяет форму, берёт авторитетные роли/ревизию, проверяет baseline и формирует контекст; промежуточно невалидный черновик допустим для обсуждения. Изменившаяся база выдаёт понятную ошибку, текст и черновик остаются.

Расширить AssistantConversation.send(text, context?) и AssistantSession.send(...,context?) для скрытого контекста: провайдер получает контекст и исходный текст, история показывает только исходный текст. Обычные вызовы не меняются. Поведенческие тесты для всех действующих чат-протоколов и main контекста. Не принимать произвольную строку системных инструкций от renderer.

Контекст вложения передаётся один раз на успешной отправке по nonce; последующие сообщения используют обычный send, иначе initial baseline конфликтует с сохранённым ассистентом результатом. Ошибка не снимает вложение. App отдельно сохраняет return draft. Новый диалог снимает вложение; вернуть черновик можно независимо от отправки. Amp/Shell показывают ограничение handoff и кнопку выбора агента с чатом, сохраняют return draft. Убрать active-project guard также у rail-кнопки/сочетания чата; terminal navigation не выполняет пустое действие без проекта.

Настройки: «Создать с ассистентом» в меню нового типа; редактор: действие изменения с ассистентом. App хранит переданный черновик и открывает чат; контекст виден чипом, поле фокусируется, имеющийся текст сохраняется. Контекст можно снять. Возврат в редактор восстанавливает исходные draft/baseline. Успешное сохранение даёт «Открыть воркфлоу» с actual typeId, открывает сохранённый граф. Поддержать sectionRequest type + workflow tab + draft/baseline. Чат доступен без активного проекта, terminal navigation отдельно защищён.

Исправить синхронизацию внешнего saved graph: принять только чистый draft, сохранить грязный с предупреждением и защитить его Save от тихой перезаписи новой базы. Вынести решение в чистую функцию с root renderer test. Не обходить существующие patch очередь и роли.

Атомарный Save графа: capability-detectable `workflowAssistant.save(typeId, baseline:Workflow, workflow:Workflow|null)`; main сравнивает текущий effective graph с baseline и синхронно вызывает patchTaskType только для workflow. Null сбрасывает на default с той же защитой. В hook отдельный saveWorkflow ждёт общей очереди и reload/onChanged. Добавить narrow `taskTypes.patch(id, TaskTypePatch)` и `taskTypes.rename(id,title,description)` IPC над актуальным типом main; workflowNotes при patch сохраняются корректно. Остальные patches/rename больше не собирают полный тип из stale latest.current. Все новые методы во всех четырёх точках и guarded stale handling. Тест воспроизводит delayed roles/rules save после workflow.set и проверяет сохранность нового графа.

Добавить suggestion создания воркфлоу; стили существующими токенами и контролами, локализация ru/en, busy и stale guards, фокус/IME. Обновить DESIGN.md только необходимым контекстом.

Файлы: shared/assistant-workflow.ts, shared/assistant-conversation.ts, shared/ipc.ts; preload/index.ts, api.d.ts; main/assistant-workflow.ts и root tests, assistant-session.ts, assistant-conversation.ts и tests, index.ts, i18n.ts; renderer App, AssistantPanel, settings TaskTypeWorkflow/TaskTypePane/SettingsModal, styles/i18n и root tests.

## Task 3: Инструкции и документация

Обновить skills/assistant.md, docs/assistant-chat.md, docs/workflow.md и docs/architecture.md по реально реализованным API. Заменить запрет визуального-only редактирования. Ассистент сначала читает schema/context/roles; обсуждает требования, использует текущий черновик, проверяет и исправляет ошибки, объясняет предупреждения, сохраняет по поручению, выдаёт краткий результат. Сохранить правила поиска id и границы опасных изменений.

Не требовать повторного разрешения для уже порученного обратимого изменения; обсуждение само по себе не поручение сохранения. Не рассчитывать координаты вручную, сохранять id при редактировании. Общая библиотека и снимки прежних прогонов; stale revision — перечитать и согласовать, не повторять старый граф с новым токеном автоматически. Terminal-only режим поддерживает прямые новые CLI команды без потери контекста.

Добавить смысловые prompt-contract тесты в packages/core/src/prompts.test.ts. Запустить тесты инструкций/CLI документации. Не описывать отсутствующие команды или флаги.

## Task 4: Проверка и сдача

Независимое ревью всей ветки: результат создания/редактирования, утрата dirty draft, конфликты ревизий, обработка повреждённого графа и старого preload, отсутствие приватных полей. Исправления по конкретным находкам, повторить покрывающие проверки. Полный pnpm verify. Просмотреть diff и staged diff, один Conventional Commit на русском. Push собственной feature ветки, PR в develop без мержа. Локальный pnpm --filter @orca-board/desktop run pack, запуск приложения с последними изменениями. В итоговом ответе путь к .app и ссылка на PR; ручной UI review оставлен пользователю.
