# Ассистент доски: контракт настроек и чат-режима

Контракт настроек ассистента и двустороннего чата в боковой панели. Настройки и команды доски сохраняют общий CLI/сокет; новый транспорт заменяет встроенный терминал для поддерживаемых агентов.

Ссылка из `docs/architecture.md` → раздел «Ассистент».

Реальные команды CLI сверяются с HELP `packages/cli/bin/orca-board.js` тестом
`packages/core/src/prompts.test.ts`, включая этот документ. Разделы 1–2 сохраняют историческую
инвентаризацию и исходный план настроек; актуальный контракт — таблица «Настройки»
в [architecture.md](architecture.md#протокол-сокета). Ниже описан действующий API воркфлоу и чата.

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
| Ассистент: агент, модель, effort, инструкции (режим разрешений — всегда `auto`, не настраивается) | раздел «Ассистент» в «Настройках» | `AppSettings.assistant` (`AssistantSettings`; раньше — роль `assistant` типа задачи, перенесена миграцией `migrateAssistant`) | `settings get` (поле `assistant`) | `settings set --assistant-agent <id> --assistant-model <id> --assistant-effort <уровень> --assistant-prompt "..."` (**опасно** при смене агента — нужен `--yes`); действует с нового диалога |
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
| Граф воркфлоу (ноды, рёбра, роли этапов, инструкции, `showcase.required`) | `TaskTypeWorkflow.tsx` (вкладка «Воркфлоу») | `TaskType.settings.workflow` | `workflow show` читает этапы/снимки; `workflow get` — полный граф типа | Создание и правка через `workflow schema/get/validate/set/create`, пропуски координат расставляются автоматически; контракт — «Воркфлоу через ассистента» ниже |

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
| Правила проекта: `CLAUDE.md`/`AGENTS.md` в корне репозитория | `RulesSection.tsx` | файлы репозитория, IPC `rules.list/save` (**имя канала совпадает с CLI `rules get/set`, но это другая сущность** — файлы, не системный промпт типа) | нет в CLI (и не должно называться `rules`, чтобы не путать с `rules get/set` агентов) | `project rules get --project <id> --file CLAUDE.md\|AGENTS.md`; `project rules set --project <id> --file <имя> --text "..." \| --rules-file rules.md` |
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

Методы исторической таблицы ниже, кроме `settings.*`, идут через выбранный проект (`--project <id>`).
Новые `workflow.schema/get/validate/set/create` и `types.list` с `all: true` — уровень приложения:
работают без проекта. Прежние `workflow.show` и `types.list` без `all` остаются проектными.

| Метод (план) | CLI (план) | Параметры | Результат | Подтверждение |
|---|---|---|---|---|
| `settings.get` | `settings get` | — | `AppSettings` целиком (то же, что `app.getSettings()` в IPC) | нет |
| `settings.set` | `settings set --language ru\|en --keep-in-background --notifications-enabled --notify-role <id>=on\|off --notify-event <kind>=on\|off --quiet-hours <from>-<to> --sound --show-preview --auto-check --auto-download --install-when-idle --assistant-agent <id> --assistant-model <id> --assistant-effort <уровень> --assistant-prompt "..." [--yes]` | любой поднабор флагов — как `AppSettingsPatch`, мержится по полям; `""` у `--assistant-model/-effort/-prompt` очищает поле | `AppSettings` после мержа | **да** для смены `--assistant-agent` на другой агент (другой процесс ассистента; модель и effort сбрасываются, если не заданы тем же вызовом), остальное — нет |
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

## Воркфлоу через ассистента

Библиотека типов общая для приложения. Ассистент сначала читает схему, находит тип по названию или id
и читает его полный контекст, включая безопасные роли без приватных `extraArgs`:

~~~sh
orca-board workflow schema
orca-board types list --all
orca-board workflow get --type <id>
~~~

`get` возвращает `{typeId,title,workflow,roles,custom,revision}`: эффективный граф (свой или по умолчанию)
и ревизию всего сохранённого типа, включая роли и настройки. Без базового типа используются стандартные
роли из схемы. Ассистент обсуждает недостающие требования, сохраняет id при правке и использует текущий
корневой черновик редактора вместе с вложенными путями; координаты вручную не рассчитывает.

~~~sh
orca-board workflow validate --type <id> --definition '<JSON>'
orca-board workflow validate --base-type <id> --definition '<JSON>'
orca-board workflow validate --definition '<JSON>'
orca-board workflow set --type <id> --revision <token> --definition '<JSON>'
orca-board workflow create --title "..." --base-type <id> --definition '<JSON>'
orca-board workflow create --title "..." --description "..." --definition '<JSON>'
~~~

`validate` не пишет состояние: проверяет сырую форму рекурсивно, миграцию и семантику, затем заполняет
недостающие координаты общей раскладкой. Возвращает `{workflow?,errors,warnings}`: при ошибке формы
графа нет, при семантических ошибках он есть без заполнения координат. `errors` нужно исправить;
`warnings` допускают сохранение, ассистент объясняет их последствия. `--type` и `--base-type`
вместе запрещены. У validate/set/create `--file workflow.json` заменяет `--definition`;
оба источника одновременно запрещены.

`set` меняет только workflow существующего типа с актуальной ревизией; `create` вставляет тип
только после успешной проверки, копируя все настройки базы на сервере либо стандартные роли/настройки
без `--base-type`. Задачи не запускаются, доступные проекту типы не переключаются. Правка библиотечного
графа действует для новых прогонов в проектах с этим типом; прежние прогоны сохраняют снимки.
Конфликт ревизии требует перечитать get и согласовать отличия с поручением: старый граф нельзя
автоматически повторить с новым токеном. Удалённый тип не воссоздаётся вместо правки.

Обсуждение само по себе не разрешает запись. Явное поручение создать или изменить обратимый граф
разрешает сохранение после проверки без повторного подтверждения. Опасные удаления, смена агента
и разрешений сохраняют прежние правила подтверждения. Итог — кратко: тип, id, изменения и существенные
предупреждения; JSON в ответ человеку не выводится.

### Передача черновика и возврат

Создание воркфлоу в приветствии и «Новый тип → Создать с ассистентом» заполняют поле одинаковым
локализованным предложением, фокусируют его и не отправляют сообщение. Меню нового типа также
открывает чат без вставки пустого типа. Чип создания и прежний возврат в редактор не появляются.
Одноразовый запрос заполнения защищён nonce: повторный рендер или открытие сохраняет последующие
правки текста. При terminal-only агенте запрос ждёт появления поля в открытом чате.

«Изменить с ассистентом» во вкладке «Воркфлоу» передаёт независимый снимок всего корневого черновика,
исходную сохранённую базу и выбранный путь, закрывает настройки и открывает чат с фокусом поля.
Только эта явная передача прикладывает конкретный граф: обычное открытие оставляет выбор пользователю.
Контекст показан над полем сообщения вместе с возвратом в редактор; введённый текст сохраняется. Передача не пишет библиотеку
и не отправляет реплику автоматически, даже когда агент закончил запуск или предыдущий ответ.

`WorkflowAssistantContext` — `{mode:'edit',typeId,title,workflow,baseline,dirty,path}`;
`{mode:'create'}` сохраняется в backend-контракте для старых клиентов. Обычное создание отправляет
только текст пользователя; инструкции ассистента уже содержат workflow skill. Main проверяет рекурсивную форму и соответствие
baseline текущему эффективному графу; семантически невалидный draft разрешён для обсуждения.
Текущее название, безопасные роли и ревизию формирует main, служебные инструкции renderer не задаёт.

Контекст отправляется один раз вместе со следующей репликой и снимается только после успешного принятия
отправки для той же сессии и nonce. Claude подтверждает запись в транспорт; Codex ждёт валидный
`turn/start` ACK, ACP — первую activity, валидный запрос разрешения/вопроса или успешный final response.
Для принятия Codex/ACP не требуется полный ответ модели или решение человека;
предел ожидания принятия — 30 секунд.
Ошибка, выход процесса, отмена или закрытие сессии до принятия отклоняют отправку и сохраняют вложение
и текст для повторной попытки. В истории может остаться исходная человеческая реплика попытки;
скрытый JSON в неё не попадает. Следующая обычная реплика не повторяет прежнюю базу.
Plain send сохраняет прежний ранний возврат Promise.

«Снять контекст воркфлоу», обычное открытие через rail/⌘K и «Новый диалог» очищают вложение,
снимок возврата и ожидающее намерение выбора агента. Снятие и обычное открытие сохраняют текст
и текущую дискуссию; новый диалог также очищает результат. Принятие отправки снимает только вложение:
снимок возврата остаётся доступен во время обсуждения этого редактора. «Вернуться в редактор» открывает тот же тип, workflow-вкладку,
исходный draft/baseline/path. Грязный черновик не получает свежую базу из props; при внешней правке
показывает конфликт. Чистый принимает новый граф. Save/Reset проверяют baseline атомарно в main;
завершение старой записи не отменяет уже наблюдённое внешнее изменение, а равная копия графа
не считается новым изменением. «Отменить правки» явно загружает свежий сохранённый граф.

После успешного CLI/socket set/create событие `workflowAssistant:saved` с
`{typeId,title,revision}` показывает «Открыть воркфлоу». Оно открывает актуальный сохранённый граф,
без restore прежнего draft. Запрос раздела применяется один раз по nonce; отсутствующий id показывает
ошибку вместо выбора другого типа. Закрытие «Настроек» очищает запрос возврата, чтобы обычное повторное
открытие не восстановило старые правки. Обычные Save/Reset/rename/validate не создают событие результата.

Amp/Shell остаются terminal-only: прямые новые CLI команды читают сохранённый тип, но не получают
несохранённый draft редактора. Вложение и снимок возврата остаются в UI. «Выбрать агента с чатом»
открывает настройки с отдельной подсказкой: явный выбор chat-agent в этом потоке запускает новый
диалог, сохранив compose и вложение. Обычная смена агента в «Настройках» оставляет текущий чат,
историю и активные разрешения до следующего нового диалога. Без проекта переход в терминалы
недоступен с пояснением; обычный чат доступен.

## 3. Двусторонний чат

Совместимый парсер истории поверх PTY и читатель usage вынесены в
`packages/runtime/src/assistant-chat.ts` и `transcripts.ts`; Desktop main-файлы
сохраняют прежние exports. Кэши имеют отдельное состояние на экземпляр. Параллельное
чтение одного пути в обоих кэшах не дублирует хвост и приросты Codex usage; при новом mtime и прежнем размере файл
разбирается заново. Незавершённая последняя строка ждёт окончания записи. Чтение истории
не запускает сохранённые инструменты повторно.

Общий `createAssistantConversationServices` в `packages/runtime/src/assistant-conversation.ts`
запускает CLI без PTY: Claude — stream-json со stdio control requests, Codex — app-server,
Gemini/Cursor/OpenCode/Copilot/Goose — ACP v1. Desktop `main/assistant-conversation.ts`
сохраняет прежние exports и задаёт messages/env/homeDir/executablePath/platform;
смена языка переводит следующие сообщения без пересоздания factory. DTO находятся
в contracts; host-интерфейсы драйвера — в pure runtime leaf без Node imports.
`shared/assistant-conversation.ts` остаётся совместимым типовым путём.
Amp и Shell сохраняют отдельный терминал по явному выбору пользователя; встроенного
xterm в `AssistantPanel` нет. Устаревший CLI показывает ошибку, провайдер не заменяется автоматически.

Сессия принадлежит приложению, не проекту. Общий `AssistantSession` находится в
`packages/runtime/src/assistant-session.ts`; host задаёт settings, guard, создание
conversation, terminal callbacks, события и error factories. Desktop subclass
сохраняет constructor и OrcaError keys для socket/IPC. Каждый экземпляр имеет
собственное состояние; registry/persistence/reconnect остаются следующим этапом.
`AssistantSession` хранит текущий экземпляр, проверяет новый агент до закрытия старого, отбрасывает поздние события предыдущего диалога и добавляет монотонную `revision`. Закрытие окна в фоне не завершает сессию; фактический выход и установка обновления вызывают dispose. Подпроцесс получает нейтральный `userData/assistant`, инструкции ассистента, настройки модели/effort, пользовательские `extraArgs` после разбора в argv и окружение из `assistantEnv`. Флаги передаются без shell, перед служебными опциями протокола; подкоманды Goose `acp` и Codex `app-server` всегда идут первыми, чтобы variadic-флаг не поглотил их и не запустил интерактивный терминал. Настройки действуют со следующего диалога; флаги интерактивного терминала должны поддерживаться выбранным native-протоколом, иначе CLI сообщает ошибку. Стартовая папка не является системной песочницей. Приложение не добавляет флагов обхода разрешений: Claude сохраняет `auto` и автоматическое разрешение `Bash(orca-board:*)`, остальные используют штатные правила CLI.

### IPC

Идентификатор остаётся в поле `ptyId` для совместимости `assistant.open/reset`; в чат-транспорте это id разговора, не зарегистрированный терминал.

| Метод | Результат / действие |
|---|---|
| `assistant.open(cols, rows)` | `{ptyId}` текущей сессии; размеры нужны только терминальному варианту |
| `assistant.reset(cols, rows)` | Завершить старую сессию и создать новую с актуальными настройками |
| `assistantChat.available(id)` | Есть ли двусторонний чат для этого id |
| `assistantChat.getMessages(id)` | Снимок: `protocolVersion:2`, `revision`, `transport`, `agent`, `messages`, `status`, `interactions`, `error?` |
| `assistantChat.send(id, text)` | Принять сообщение; Promise не ждёт весь ответ модели |
| `assistantChat.sendWithWorkflow?(id, text, context)` | Обнаружимый метод для скрытого контекста; Promise ждёт принятия contextual send |
| `workflowAssistant.save(typeId, baseline, workflow\|null)` | Promise<void>; атомарно сверить эффективную базу и сохранить только граф, null — сброс своего |
| `workflowAssistant.onSaved(cb)` | Подписка на узкое событие результата CLI/socket set/create |
| `assistantChat.interrupt(id)` | Прервать текущий ответ нативной командой протокола |
| `assistantChat.respond(id, requestId, answer)` | Ответить только на активный запрос, сохранив оригинальные id вариантов |
| `assistantChat.onMessage(id, cb)` | Подписка на сообщения, статусы, новые запросы и их разрешение |

События `assistantChat:message:<id>` содержат `ptyId`, `revision` и одну из веток: `message`, `status/error`, `interaction`, `resolvedRequestId`. Renderer устанавливает подписку **до** чтения снимка, буферизует события, затем принимает только ревизии новее снимка. Закрытая подписка игнорирует поздний ответ IPC. Старые main/preload без версии 2 требуют перезапуска приложения.

### Сообщения и взаимодействия

Стабильный id позволяет обновлять потоковый ответ на месте. Снимок и лента ограничены последними 300 сообщениями; контекст диалога остаётся у агента. В ленте видны непустые реплики `human` и `agent`, а между ними — компактные строки вызовов инструментов: имя, краткое описание/команда/путь и статус. Роль `tool` сохраняется в модели протокола; `groupMessages` передаёт её в UI с пустым `text`, поэтому найденные данные и JSON не становятся сообщениями и не доступны кнопке копирования. Действия хранят имя, краткие аргументы и статус `running/ok/error/cancelled`. Статусы разговора: `starting`, `thinking`, `waiting`, `done`, `interrupted`, `error`. Текст ответа проходит существующий безопасный Markdown; входящий HTML, аргументы и подписи не исполняются.

Разрешения отображаются карточками с реальными вариантами провайдера: разрешить один раз/всегда, отклонить один раз/всегда. В раскрываемых details показаны полные аргументы именно текущего запроса, а не краткое описание родительского действия. Ничего не выбрано и не подтверждено автоматически. Для одиночного выбора собственный ответ заменяет radio-выбор, а выбор варианта очищает собственный текст. Вопросы могут содержать несколько пунктов, одиночный или множественный выбор и свободный ответ. Невалидный или уже отозванный запрос не отправляется агенту. Закрытие панели оставляет запрос активным; кнопка остановки отменяет ожидающие взаимодействия нативным способом.

Claude поддерживает `can_use_tool`, `AskUserQuestion`, `control_cancel_request`. ACP использует `session/request_permission` и `session/cancel`, Cursor — также `cursor/ask_question`. Codex отзывает карточки по `serverRequest/resolved`, так что позднее подтверждение невозможно. Codex понимает современные и старые методы разрешения команд/изменений файлов; `requestUserInput` обрабатывается там, где CLI его предоставляет. В старой версии CLI без этого метода обычные вопросы остаются текстовыми сообщениями, на которые можно ответить в поле ввода.

### Поведение панели

Правая панель 560px, на узком окне — вся ширина. Черновик и история сохраняются при закрытии, новый диалог очищает контекст явно. Фокус ограничен открытой панелью и возвращается инициатору; открытие настроек временно отдаёт им фокус. Enter отправляет, Shift+Enter добавляет строку; IME не отправляет промежуточную композицию. Во время ответа поле остаётся доступным для следующего черновика, отправка заблокирована; есть кнопка остановки. Ошибка отправки сохраняет введённый текст. Переход к новому диалогу не даёт позднему завершению старой отправки очистить новый черновик.

Лента следует ответу, пока пользователь у нижней границы; при чтении предыдущих сообщений появляется «К последним сообщениям». Закрытие панели сохраняет положение. Сообщения можно копировать. У действий видны настоящие статусы `running/ok/error/cancelled`; смена статуса обновляет строку на месте. Описание берётся из превью аргументов, ограничено 180 символами; JSON аргументов не раскрывается целиком, для чтения/поиска/изменения показывается только цель. Служебный JSON и результаты команд скрыты; карточки разрешений и вопросов остаются доступными. Индикатор «Ассистент думает…» с подпрыгивающими точками и мягким шиммером виден, пока запрос CLI в статусе `thinking`, включая паузы между частями ответа и после завершённых команд. Первый текст не означает завершение ответа. Во время активного вызова общее ожидание заменяется строкой действия со спиннером, после его завершения точки возвращаются. Завершение ответа, остановка, ошибка и ожидание решения пользователя убирают индикатор. После следующей человеческой реплики ожидание включается снова; действия прежних запросов не мешают этому. Быстрые предложения только заполняют поле, не запускают действие. Появление сообщений/панели и индикатор ответа используют ограниченное движение, отключаемое общей настройкой.

На кнопке ассистента в левой панели остаётся статус закрытого чата: спиннер во время запуска или работы, красная точка у готового непрочитанного ответа. Открытие видимого чата снимает точку; настройки, перекрывающие чат, не отмечают ответ прочитанным. Прочитанность хранится в renderer по id диалога, статусу и ревизии; смена проекта её не меняет, новый ответ получает новую отметку. Активный запрос разрешения/ответа и непрочитанная ошибка диалога тоже привлекают внимание красной точкой с точной подсказкой. Остановка и пустая история не означают готовый ответ. Отдельный терминал Amp/Shell не получает выдуманный чат-статус. Используются существующие `update-spin` и `rail-dot`, reduced motion отключает вращение; RU/EN-подсказки и доступное имя кнопки различают состояния. Дополнительной подписки или API для этого нет.

### Проверка и источники

Тесты используют реальные fixture-процессы без inference: фрагментация JSONL, разные протоколы, разрешения, вопросы, отмена, старые запросы, запуск, завершение и Windows launcher. Отдельные тесты проверяют lifecycle одной сессии и гонки IPC-снимка, скрытие служебного вывода, краткие описания действий, обновление их статусов и жизненный цикл индикатора ожидания. Пользователь проверяет UI на рабочем билде самостоятельно.

Протоколы: [Claude Code headless](https://code.claude.com/docs/en/headless), [Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server), [ACP schema](https://agentclientprotocol.com/protocol/schema), [Cursor ACP](https://cursor.com/docs/cli/acp), [Gemini CLI ACP](https://geminicli.com/docs/cli/acp-mode/), [OpenCode ACP](https://opencode.ai/docs/acp/), [Copilot CLI ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).


### Сохранённая история и provider binding

Snapshot общего driver содержит optional `providerBinding`: transport и native
sessionId (Claude configured UUID, Codex thread id, ACP session id после handshake).
Наличие id не означает поддержку resume; frames/permissions не меняются.
Contracts `DialogRecord` связывает transcript с opaque dialog/project id, revision
и временем. Чистый `dialogHistory` отдаёт отдельный JSON snapshot только для чтения:
незавершённый turn → interrupted, старые interactions очищены, running tools →
cancelled. История не запускает CLI/tools и требует нового разговора. Это общий
слой рубежа 4; подключение persistence к registry/Desktop ещё предстоит.

Runtime `createDialogRepository(absoluteFile)` хранит новый изолированный JSON
`{schemaVersion:1, dialogs:[...]}`. Import/factory/read не создают файл; запись
использует atomic rename. `save(record, expectedRevision)` создаёт revision 0
при `null`, затем принимает только следующий revision; `remove` тоже требует
текущую ревизию. Перед каждой мутацией перечитывается и проверяется весь документ.
Повреждение, другая версия и повтор id блокируют запись с `DialogRepositoryError`
(`dialog.invalid`, `dialog.schemaUnsupported`, `dialog.conflict`); исходный файл
не стирается и не переносится автоматически. Ошибки I/O проходят caller.
Unknown JSON metadata сохраняются при read/update того же DTO и соседних записей.
Фильтр project id относится только к переданному profile-файлу. Caller уже должен
владеть profile: revision check не заменяет межпроцессный lock. Backend пока
синхронный; его подключение к registry/Desktop и async I/O остаются следующим шагом.

Integration проверяет настоящие fixture CLI Claude/Codex в двух profiles и
завершённый ACP turn: snapshot записывается на диск, процессы закрываются,
отдельный plain Node читает public repository/history. На reload пути запрещены
subprocess APIs; DISPLAY/Electron не нужны. Проверяются native ids, все сообщения,
metadata и неизменные исходные байты. Это проверка общего слоя, а не обещание
resume или восстановления чата нынешним Desktop.
