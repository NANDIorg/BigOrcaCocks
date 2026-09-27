# Ассистент доски: контракт настроек и чат-режима

Контракт для двух зависимых задач (без реализации): (1) какие настройки приложения и проекта ассистент
должен уметь читать и менять через `orca-board`, и какие команды/методы сокета для этого нужны;
(2) как панель ассистента (`renderer/src/AssistantPanel.tsx`) выглядит как чат, оставаясь под капотом
PTY с агентом (`skills/assistant.md`, `src/main/worker.ts` → `startAssistant`).

Ссылка из `docs/architecture.md` → раздел «Ассистент».

Команды ниже, которых нет в HELP `packages/cli/bin/orca-board.js`, помечены **(план)** и написаны без
префикса `orca-board`, чтобы не попасть под тест «команды в инструкциях и документации совпадают с CLI»
(`packages/core/src/prompts.test.ts`, сканирует `skills/*.md` и 4 файла `docs/*.md`, этот файл в списке
нет). Перед тем как класть такую команду в `skills/assistant.md` или в сканируемые доки — сначала добавить
её в HELP (или хотя бы заглушку, возвращающую `OrcaError` «не реализовано»), иначе тест упадёт.

## 1. Инвентаризация настроек

Столбец «Сейчас» — что уже доступно через сокет/CLI (`orca-board --help`) не в UI. Столбец «Добавить» —
что нужно для задачи бэкенда.

### Настройки приложения (`Настройки` → шестерёнка в rail, `renderer/src/settings/`)

| Настройка | UI | Где хранится | Сейчас | Добавить |
|---|---|---|---|---|
| Язык интерфейса | `GeneralSection.tsx` | `AppSettings.language` (projects.json, IPC `app.getSettings/setSettings`) | нет | `settings get` / `settings set --language ru\|en` |
| Свёрнуто в фон при закрытии окна | `GeneralSection.tsx` | `AppSettings.keepInBackground` | нет | `settings set --keep-in-background` |
| Уведомления: глобальный выключатель, роли, виды событий, тихие часы, звук, превью | `NotificationsSection.tsx` | `AppSettings.notifications` (`NotificationSettings`, `shared/notifications.ts`) | нет | `settings set --notifications-enabled`, `--notify-role <id>=on\|off`, `--notify-event <kind>=on\|off`, `--quiet-hours <from>-<to>`, `--sound`, `--show-preview` |
| Автообновление: проверять, скачивать, ставить при простое | `UpdatesSection.tsx` | `AppSettings.updates` (`UpdateSettings`) | нет | `settings set --auto-check --auto-download --install-when-idle` |
| Мастер первого запуска: пройти заново | `GeneralSection.tsx` (кнопка) | `OnboardingState` (не в `AppSettings`) | нет | не нужно ассистенту — чисто UI-действие |

### Библиотека типов задач (`Настройки → Типы задач`, `settings/TaskTypePane.tsx`, IPC `taskTypes.*`)

Тип задаёт роли, воркфлоу, режим разрешений и правила агентов; общий для всех проектов, где он доступен.

| Настройка | UI | Где хранится | Сейчас | Добавить |
|---|---|---|---|---|
| Список типов, тип по умолчанию библиотеки | `SettingsModal.tsx` (меню) | `TaskType[]` (task-types.json), IPC `taskTypes.list/setDefault` | `types list` (только доступные проекту, без глобального умолчания и без создания) | `types create --title "..." [--description "..."]`, `types set-default --type <id>` |
| Название, описание типа | `TaskTypePane.tsx` (шапка, «Переименовать») | `TaskType.title/description` | нет | `types rename --type <id> [--title "..."] [--description "..."]` |
| Дублировать тип | `TaskTypePane.tsx` | IPC `taskTypes.duplicate` | нет | `types duplicate --type <id>` |
| Удалить тип (последний нельзя) | `TaskTypePane.tsx` | IPC `taskTypes.delete` | нет | **(опасно)** `types delete --type <id> --yes` |
| Роли типа: список, название, назначение, агент, модель, effort, systemPrompt | `RolesEditor.tsx` (вкладка «Роли») | `TaskType.settings.roles` | `roles list` (только чтение) | `roles add --type <id> --title "..." --agent <id> [--model <id>] [--effort <id>] [--description "..."]`; `roles update --type <id> --role <id> [--title/--agent/--model/--effort/--description "..."]` (**опасно** при смене `--agent` — нужен `--yes`); **(опасно)** `roles remove --type <id> --role <id> --yes` (роль с назначенными задачами/этапами — предупреждение как в UI, `removalConsequences`) |
| Правила роли/типа (системный промпт) | `TaskTypePane.tsx` (вкладка «Правила»), `RolesEditor.tsx` (промпт роли) | `TaskType.settings.agentRules` / `Role.systemPrompt` | **уже есть**: `rules get/set [--type] [--run] [--role]` | — |
| Режим разрешений Claude Code | `PermissionsSection.tsx` (вкладка «Разрешения») | `TaskType.settings.permissionMode` | нет (не входит в `types list`, только в `TaskType`) | `types perm get --type <id>`; `types perm set --type <id> --mode auto\|bypassPermissions\|acceptEdits` |
| Граф воркфлоу (ноды, рёбра, роли этапов, инструкции, `showcase.required`) | `TaskTypeWorkflow.tsx` (вкладка «Воркфлоу») | `TaskType.settings.workflow` | `workflow show [--run] [--type]` (только чтение: этапы и переходы) | не для ассистента: граф — визуальный редактор (координаты нод, рёбра), текстовый CLI-контракт непрактичен; ассистент может **читать** (`workflow show`), правку — предложить человеку открыть «Настройки» |

### Библиотека шаблонов нод (`Настройки → Свои ноды`, IPC `nodeTemplates.*`)

| Настройка | Где хранится | Сейчас | Добавить |
|---|---|---|---|
| Список, создание, удаление своих нод воркфлоу | `WfNodeTemplate[]` (node-templates.json) | нет в CLI | `node-templates list`; `node-templates delete --template <id> --yes` (создание — только визуально, через `WfTemplateNode`, не для CLI) |

### Настройки проекта (`О проекте`, `renderer/src/about/`)

| Настройка | UI | Где хранится | Сейчас | Добавить |
|---|---|---|---|---|
| Список проектов, активный, добавить/удалить | `ProjectList.tsx`, `OverviewSection.tsx` | `Project[]` (projects.json), IPC `projects.list/add/remove/setActive` | `projects list` (только чтение) | `projects set-active --project <id>`; **(опасно)** `projects remove --project <id> --yes` (`add` — диалог выбора папки в Electron, не для headless CLI) |
| Группы проектов в меню | `ProjectList.tsx`/`GroupDialogs.tsx` | `ProjectGroup[]`, IPC `projects.createGroup/renameGroup/removeGroup/setProjectGroup/reorderGroups` | нет | вне охвата ассистента (только раскладка меню, не влияет на работу агентов) — не добавлять |
| Включённые агенты проекта | `AgentsSection.tsx` | `Project.enabledAgents` | `agents list` (только чтение, `enabled` по активному проекту) | `project agents set --project <id> [--enable <id агента>]... [--disable <id агента>]...` (хотя бы один флаг; реализация мержит `--enable`/`--disable` в текущий список, а не задаёт его целиком — так проще проверить один агент, не перечисляя остальные) |
| Колонки доски | `ColumnsEditor.tsx` | `Project.columns` | `columns list` (только чтение) | `project columns set --project <id> --file columns.json` (весь список: удаление занятой колонки переносит задачи в backlog, как в UI — предупредить) |
| Доступные типы задач + тип проекта по умолчанию | `TaskTypesSection.tsx` | `Project.taskTypeIds`/`defaultTaskTypeId` | `types list` (список доступных, без явного изменения) | `project types set --project <id> [--types <id>,<id>,...] --default <id>` (без `--types` — «все типы библиотеки», как `typeIds: null`; `--default` — реализация требует его всегда, а не только при сужении списка, — проще для агента, чем угадывать, выпал ли старый тип по умолчанию) |
| Правила проекта: `CLAUDE.md`/`AGENTS.md` в корне репозитория | `RulesSection.tsx` | файлы репозитория, IPC `rules.list/save` (**имя канала совпадает с CLI `rules get/set`, но это другая сущность** — файлы, не системный промпт типа) | нет в CLI (и не должно называться `rules`, чтобы не путать с `rules get/set` агентов) | `project rules get --project <id> --file CLAUDE.md\|AGENTS.md`; `project rules set --project <id> --file <имя> --text "..." \| --file-content rules.md` |
| Git корня проекта: ветка, fetch/pull, переключение | `OverviewSection.tsx` (частично; больше в `BranchMenu.tsx`) | IPC `projects.branch(es)/gitFetch/gitPull/checkoutBranch` | нет | вне охвата этой задачи (git — работа воркеров/координатора, не настройка; см. правило CLAUDE.md «не вызывать git через shell» и «Работать в общих ветках нельзя») — не добавлять |
| Прогоны проекта: список, закрыть | `RunsSection.tsx` | IPC `runs.list/close` | **уже есть**: `runs list`, `runs close --run <id>` | — |

### Вне охвата (не настройки приложения/проекта в смысле задачи)

- Онбординг (`OnboardingModal.tsx`) — состояние прохождения мастера, не настройка.
- `agentRules.ts` заготовки текста (`agentRulesPlaceholder`) — константа UI, не хранится отдельно.
- Изображения задач, показ человеку (`showcase`, `attachments`) — про конкретные задачи, не про настройки.

## 2. Контракт CLI/сокета для настроек

Стиль — как существующие команды (`packages/cli/bin/orca-board.js`): глагол `list`/`get`/`set`/`create`/
`delete`/`update`, JSON-ответ, ошибки — `Error`/`OrcaError` с текстом по-русски (в HELP они не типизированы
отдельно — CLI печатает `{ok: false, error: {message, ...}}` как есть). Ниже — таблица в стиле раздела
«Протокол сокета» `docs/architecture.md`: метод сокета (`namespace.verb`), CLI-форма **(план)**, параметры,
результат, что при ошибке.

Все методы — уровня проекта (`--project <id>`, как остальные проектные команды), кроме `settings.*`
(уровень приложения, как `projects.list`).

| Метод (план) | CLI (план) | Параметры | Результат | Подтверждение |
|---|---|---|---|---|
| `settings.get` | `settings get` | — | `AppSettings` целиком (то же, что `app.getSettings()` в IPC) | нет |
| `settings.set` | `settings set --language ru\|en --keep-in-background --notifications-enabled --notify-role <id>=on\|off --notify-event <kind>=on\|off --quiet-hours <from>-<to> --sound --show-preview --auto-check --auto-download --install-when-idle` | любой поднабор флагов — как `AppSettingsPatch`, мержится по полям | `AppSettings` после мержа | нет — это не деструктивная правка |
| `types.create` | `types create --title "..." [--description "..."]` | `title` обязателен | `TaskType` (роли и правила — дефолтные, как «Создать тип» в UI) | нет |
| `types.rename` | `types rename --type <id> [--title "..."] [--description "..."]` | хотя бы одно поле | `TaskType` | нет |
| `types.set-default` | `types set-default --type <id>` | `type` обязателен, должен быть в библиотеке | `TaskTypesState` | нет |
| `types.duplicate` | `types duplicate --type <id>` | `type` | новый `TaskType` (копия) | нет |
| `types.delete` | `types delete --type <id> --yes` | `type`; без `--yes` — ошибка `confirmation.required` с текстом «нужно подтверждение: сколько проектов используют тип (`usage.available`), используется ли по умолчанию» (как `typeRemovalConfirm` в UI); последний тип библиотеки — ошибка | `TaskTypesState` | **да**, явное `--yes` (аналог человеческого «да» из `skills/assistant.md`) |
| `roles.add` | `roles add --type <id> --title "..." --agent <id> [--model <id>] [--effort <id>] [--description "..."]` | `type`, `title`, `agent` обязательны; `agent` — из `agents list` | `Role` (с сгенерированным `id`) | нет |
| `roles.update` | `roles update --type <id> --role <id> [--title/--agent/--model/--effort/--description "..."] [--yes]` | `type`, `role` обязательны | обновлённый `Role` | **да** для смены `agent` — без `--yes` ошибка с текущим и новым агентом (другой процесс запуска задач роли), остальные поля — без подтверждения |
| `roles.remove` | `roles remove --type <id> --role <id> --yes` | без `--yes` — ошибка с текстом, что потеряется (роли этапов воркфлоу, назначенные задачи — `removalConsequences`) | `TaskType` без роли | **да** |
| `types.perm.get` | `types perm get --type <id>` | `type` | `{typeId, permissionMode}` | нет |
| `types.perm.set` | `types perm set --type <id> --mode auto\|bypassPermissions\|acceptEdits` | `mode` — одно из трёх | `{typeId, permissionMode}` | **да** для `bypassPermissions` (полностью автономный агент — риск шире, чем у остальных настроек; текст предупреждения как `PERMISSION_MODES.bypassPermissions`) |
| `node-templates.list` | `node-templates list` | — | `WfNodeTemplate[]` | нет |
| `node-templates.delete` | `node-templates delete --template <id> --yes` | нет такого — `nodeTemplate.notFound` | оставшиеся `WfNodeTemplate[]` | **да** |
| `projects.set-active` | `projects set-active --project <id>` | `project` | `Project` | нет |
| `projects.remove` | `projects remove --project <id> --yes` | без `--yes` — отказ; проект с живыми воркерами/координатором — предупредить как в `skills/assistant.md` («Подтверждение») | `{removed: id}` | **да** |
| `project.agents.set` | `project agents set --project <id> [--enable <id>]... [--disable <id>]...` | хотя бы один `--enable`/`--disable`; неизвестный агент — ошибка (сверка с `agents list`) | `Project` (мерж `--enable`/`--disable` в текущий список включённых, не замена целиком) | нет — обратимо, не удаляет данные |
| `project.columns.set` | `project columns set --project <id> --file columns.json` | JSON-файл — весь список `BoardColumn[]` (частичного патча нет, как у `projects.setColumns`) | `Project`; удаление колонки с задачами — не ошибка, они переезжают в backlog (как в UI), но в ответе — `movedToBacklog: <task.id>[]` | **да**, если запрос удаляет непустую колонку (список `movedToBacklog` непустой) — тогда предпоказ и повтор с `--yes` |
| `project.types.set` | `project types set --project <id> [--types <id>,<id>,...] --default <id>` | без `--types` — все типы библиотеки (`typeIds: null`); `--default` обязателен всегда (реализация проще правила «только если старый выпал из списка» — агенту не нужно самому определять, выпал ли он) | `Project` | нет |
| `project.rules.get` | `project rules get --project <id> --file CLAUDE.md\|AGENTS.md` | `file` — из `RULE_FILE_NAMES` (`shared/ipc.ts`), другое имя — ошибка `rules.onlyKnown` (как в `main/rules.ts`) | `RuleFile` (`{name, exists, text, eol}`) | нет |
| `project.rules.set` | `project rules set --project <id> --file <имя> --text "..." \| --rules-file <путь на диске агента>` | `text` обязателен (`''` — очистить); лимит `RULE_MAX_BYTES` (1 МБ) | `RuleFile` после записи | нет — файл не коммитится (решает человек), это текст, не удаление |

Общее для всех «опасных» операций (по аналогии с `skills/assistant.md` → «Подтверждение»): ассистент **не**
передаёт `--yes` сам — только после явного «да» человека в чате, и должен вслух назвать, что изменится
(проект/тип/id и последствия), как уже описано для `task delete`/`global delete`/`worker stop`. Именно
поэтому опасные методы принимают отдельный флаг подтверждения, а не молча выполняются — тот же принцип,
что у `global delete --cascade`.

## 3. Контракт чат-режима

Цель: панель ассистента выглядит как чат (сообщения человека и агента, статус «думает», компактные
tool-вызовы), но снизу остаётся тот же PTY с интерактивным агентом (`skills/assistant.md`,
`assistantEnv` в `src/main/assistant.ts`) — никакого отдельного «безтерминального» протокола с агентом
не заводим, чат — это **другое отображение** того же потока.

### Источник сообщений

- **Основной — транскрипт агента**, а не разбор ANSI из PTY. Claude Code (агент `claude`, единственный
  агент с ролью `assistant` сейчас, см. `DEFAULT_ROLES`) пишет сессию в
  `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl` — то же, что уже разбирает
  `apps/desktop/src/main/transcripts.ts` (`parseClaudeLine`) для статистики. У ассистента `cwd` —
  `userData/assistant` (см. «Ассистент» в `docs/architecture.md`), устойчивый и без git, поэтому найти файл
  сессии проще, чем у воркера/координатора (нет `worktree`, нет привязки к задаче): `claudeDirsFor(env, cwd)`
  → один файл на сессию, без сабагентов (ассистент их не порождает).
  Строки транскрипта: `type: "user"` — сообщение человека (включая то, что уходит в stdin из чата),
  `type: "assistant"` — ответ (текст + `tool_use` блоки), `type: "user"` с `tool_result` — результат
  инструмента (сворачивается в один блок с вызовом). Это те же данные, что видны в PTY, но структурированные
  и без ANSI/спиннеров.
- **Фолбэк — вывод PTY как есть**, когда транскрипт недоступен: агент без транскрипта (не Claude Code —
  сейчас у роли `assistant` только `claude`, но контракт должен переживать добавление другого агента),
  файл сессии не нашёлся (первые секунды после старта, до первой строки), или транскрипт сломан/недоступен
  (права, диск). В этом случае панель показывает **терминал**, а не чат (переключатель ниже) — не пытаемся
  парсить чат из ANSI.

### IPC (типы объявлены в `shared/ipc.ts`, без реализации — см. ниже)

Новый канал `assistantChat` рядом с `assistant` (не заменяет его — `assistant.open/reset` всё равно
поднимает PTY, `assistantChat` только читает и пишет в него другим протоколом):

- `assistantChat.getMessages(ptyId): Promise<AssistantChatSnapshot>` — сообщения с начала сессии (или
  последние N — лимит обсуждается в задаче реализации, по аналогии с `EVENT_ANSWER_LIMIT`, чтобы не тащить
  тело файла целиком через IPC).
- `assistantChat.onMessage(ptyId, cb): () => void` — подписка на новые сообщения/обновления статуса
  (дописанный хвост транскрипта, как `TranscriptCache.read` читает инкрементально — тот же приём: кэш по
  `(путь, размер, mtime)` и дочитывание хвоста, не весь файл на каждое событие).
  Событие — `AssistantChatUpdate` (одно новое/изменённое сообщение или смена статуса), не весь снапшот.
- `assistantChat.send(ptyId, text): Promise<void>` — отправить сообщение из чата: **не** пишет в
  транскрипт напрямую, а делает `pty.write(ptyId, text + '\r')` (тот же путь, что ввод в терминале) —
  агент сам допишет транскрипт, чат увидит новое сообщение через `onMessage`. Разница с прямым
  использованием `window.orca.pty.write` только в том, что `send` — часть контракта чата (валидирует,
  что `ptyId` — ассистент, и что текст не пустой).
- `assistantChat.available(ptyId): Promise<boolean>` — можно ли показывать чат для этого PTY (транскрипт
  найден и агент поддерживает разбор); `false` — панель показывает терминал без предложения переключиться.

### Модель сообщения (типы — `shared/ipc.ts`)

```
AssistantChatRole = 'human' | 'agent' | 'tool'
AssistantChatStatus = 'thinking' | 'done' | 'error'

AssistantChatToolCall = {
  name: string           // имя инструмента (Bash, и т.п.); у ассистента — фактически только Bash(orca-board)
  input: string           // короткое представление аргументов для свёрнутой строки, не весь JSON
  status: 'running' | 'ok' | 'error'
}

AssistantChatMessage = {
  id: string              // стабильный (id записи транскрипта/строки), не пересчитывается между чтениями
  role: AssistantChatRole
  text: string             // текст сообщения; для role='tool' — краткий текст результата
  toolCalls?: AssistantChatToolCall[]   // tool-вызовы, свёрнутые (агент вызывает orca-board через Bash)
  at: number               // мс, из транскрипта
}

AssistantChatSnapshot = {
  ptyId: string
  messages: AssistantChatMessage[]
  status: AssistantChatStatus    // «думает» — агент начал отвечать, но последняя запись — не финальный текст
}

AssistantChatUpdate = { ptyId: string, message: AssistantChatMessage } | { ptyId: string, status: AssistantChatStatus }
```

Tool-вызовы **всегда свёрнуты** (одна строка «выполнил `orca-board task list`» с раскрытием по клику,
как схлопнутые diff-блоки в `Markdown.tsx`) — задача явно требует не показывать голый JSON инструмента в
чате, это и так работа ассистента через CLI, а не то, что интересно человеку.

### Переключатель «чат / терминал»

- Кнопка в `AssistantPanel.tsx` рядом с «Новый диалог» (`Icon.refresh`) и «Открыть в Терминалах»
  (`Icon.external`); состояние — как «Общие → Язык» (`useState` + `localStorage`, не `AppSettings`: это
  предпочтение показа, не настройка приложения).
  Терминал (`Terminal.tsx`, xterm) не размонтируется при переключении на чат — то же правило, что уже
  есть для терминалов ассистента («не размонтируются при закрытии панели»): переключение — это `hidden`,
  не `unmount`, иначе PTY «замёрзнет» визуально при следующем открытии.
- Чат недоступен для PTY (`assistantChat.available` → false, или колбэк ошибки) — кнопка переключения
  скрыта или задизейблена, панель остаётся терминалом. Не блокирующая ошибка (транскрипт не нашёлся
  сразу после старта) — короткий повтор (как `TranscriptCache` при росте файла), не показ ошибки человеку.
- Отправка сообщения из чата, когда агент ещё «думает» (`status: 'thinking'`), — как Enter в терминале
  во время ответа: либо прерывает (Esc-эквивалент), либо ставится в очередь ввода — решает задача
  реализации по опыту `Terminal.tsx`; здесь фиксируем только что `send` не ждёт `done` сама.

### Агенты без транскрипта

Роль `assistant` сейчас жёстко на `claude` (`DEFAULT_ROLES`), но контракт не должен завязываться на это:
- `assistantChat.available` возвращает `false` для любого PTY, у которого нет парсера транскрипта
  (сейчас — все, кроме `agent === 'claude'`; список парсеров — как `parseClaudeLine`/`parseCodexLine` в
  `transcripts.ts`, но для чата нужен не расход токенов, а сообщения, поэтому это **отдельный** парсер,
  не переиспользование `TranscriptCache` как есть — она читает usage, а не текст сообщений).
- Терминал — универсальный fallback: он не требует парсера, работает для любого агента и уже
  реализован (`Terminal.tsx`), поэтому при `available: false` UI не деградирует, а просто не предлагает чат.

## Типы для этой задачи в `apps/desktop/src/shared/ipc.ts`

Добавлены только независимые типы данных чата (не входят в `OrcaApi`, поэтому preload и main их не должны
реализовывать — `pnpm typecheck` проходит без изменения кода main/preload). Методы `assistantChat.*` и
командный контракт `settings`/`types`/`roles`/`node-templates`/`project rules` из разделов 1–2 в
`OrcaApi`/`HELP` **не добавлены** — их вносит задача реализации вместе с main/preload/CLI/socket по
правилу CLAUDE.md «Новый IPC-канал — сразу в четырёх местах» и «Новая команда или метод CLI проходит всю
цепочку».
