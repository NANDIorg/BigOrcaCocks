# Архитектура orca-board

## Процессы

```
Electron main ───── node-pty ───── PTY: claude (координатор)
   │                                   └─ bash: orca-board task-create ...
   │                                          │ unix socket / JSON-RPC
   ├── SQLite (tasks, events, dispatches) ◄───┘
   ├── node-pty ───── PTY: claude (воркер задачи #12, worktree ../wt/task-12)
   ├── node-pty ───── PTY: codex  (воркер задачи #13, worktree ../wt/task-13)
   └── renderer (React): доска + xterm.js на каждый PTY
```

- Все агенты — дочерние процессы приложения. Никакого API: агент логинится сам.
- CLI `orca-board` — тонкий клиент к сокету приложения. Его вызывают агенты
  через свой Bash. Приложение — единственный владелец состояния.

## Модель (`packages/core/src/types.ts`)

- `Task { id, title, spec, status, deps[], roleId, agent, worktree?, branch?, dispatchId?, feedback?, createdAt, updatedAt, startedAt?, doneAt? }`.
  - `status` — **id колонки доски** (`TaskStatus = string`), не фиксированный enum.
  - `roleId` — роль проекта (см. «Роли и колонки»); агент и модель берутся из неё при старте.
    `agent` — снимок `AgentKind` на момент создания/запуска, `worker.ts` синхронизирует его с ролью.
  - `startedAt` — первый `startDispatch`; `doneAt` — момент попадания в колонку `kind=done`
    (при выходе из неё сбрасывается, `store.setStatus`).
- `Role { id, title, agent, model?, effort? }` — кто выполняет задачу: агент из реестра, модель
  и уровень рассуждений `effort` (пусто — по умолчанию у агента; `validateRoles` обрезает пробелы,
  пустая строка → поле не сохраняется). `DEFAULT_ROLES`: `coordinator`, `developer`, `reviewer`, `qa`;
  `DEFAULT_ROLE_ID = 'developer'` — его получают задачи без `roleId` при миграции старой доски.
- `BoardColumn { id, title, color, kind }`. `kind` — системный (`backlog`, `ready`, `in_progress`,
  `needs_input`, `review`, `done`) либо `custom`. По `kind` store делает автоматические переходы,
  по `id` — хранит статус задачи. `color` — hex из `COLUMN_COLORS` (8 предустановленных).
- `DEFAULT_COLUMNS`: `id === kind` (`backlog`…`done`), поэтому старые доски со строковыми
  статусами открываются без миграции.
- `TASK_STATUSES` и `STATUS_TITLES` — только дефолт, помечены `@deprecated`: реальные колонки
  живут в настройках проекта.
- `Dispatch { id, taskId, ptyId, startedAt, endedAt?, outcome?, summary?, files?, stuckNotified? }`
- `Event { id, type, taskId?, dispatchId?, payload, createdAt, consumedBy? }`
  типы: `task_ready`, `worker_done`, `question`, `escalation`, `question_answered`.
- Автопереходы (`store.ts`, по `kind`): `backlog → ready`, когда все `deps` в `done`;
  `in_progress` при старте воркера; `review` после `done`; `needs_input` при вопросе или выходе PTY без `done`.

## Роли и колонки (`src/main/projects.ts`)

- **Хранение**: `Project.roles?: Role[]` и `Project.columns?: BoardColumn[]` в `userData/projects.json`.
  Новый проект получает копию ролей и колонок из глобального дефолта (`ProjectManager.defaults()`,
  см. «Проекты»), поэтому у него они всегда заданы. `undefined` остаётся только у старых проектов,
  созданных до появления дефолта, и читается как встроенные `DEFAULT_ROLES` / `DEFAULT_COLUMNS`
  (`ProjectManager.roles(id)`, `columns(id)`), а не как текущий глобальный дефолт.
  Меняются через IPC `projects:setRoles` / `projects:setColumns` (вкладка «О проекте») или целиком
  переписываются дефолтом через `projects:applyDefaults`.
- **Откуда берётся дефолт**: `projects.json → defaults.roles` / `defaults.columns`; не заданы —
  встроенные `DEFAULT_ROLES` / `DEFAULT_COLUMNS`. При `setDefaults` роли и колонки проходят те же
  `validateRoles` / `validateColumns`, что и у проекта.
- **Дефолтные роли**: `coordinator`, `developer`, `reviewer`, `qa` — все на `claude`, модель пустая.
- **Валидация ролей** (`validateRoles`): хотя бы одна роль; непустые уникальные `id`, непустые
  `title`; `agent` — известный `AgentKind`; `model` — строка или отсутствует (пустая после trim → удаляется).
- **Валидация колонок** (`validateColumns`): хотя бы одна; непустые уникальные `id` и `title`;
  каждый системный `kind` ровно один раз (удалить или продублировать системную колонку нельзя),
  остальные — `custom`; пустой `color` → первый из `COLUMN_COLORS`. Порядок массива = порядок на доске.
- **Store и колонки**: `TaskStore` получает функцию `columns()` в конструкторе и не хранит колонки сам.
  `columnId(kind)` — id первой колонки с таким `kind` (нет — сам `kind` как запасной вариант),
  `columnKind(id)` — обратное. `moveTask` отвергает неизвестный id колонки.
- **Удаление кастомной колонки**: `setColumns` сначала сохраняет новый набор, затем все задачи
  из исчезнувших колонок переводит в колонку `kind=backlog` (`store.reassignColumn(fromId, toId)`),
  чтобы на доске не осталось задач с несуществующим статусом.
- **Воркер** (`worker.ts`, `startWorker`): роль ищется по `task.roleId` в `ctx.roles` (нет → ошибка),
  агент — `getAgent(role.agent)`, модель — `role.model` уходит в `invoke(..., { model })`.
  Перед стартом `task.agent` обновляется по роли: роль могли перенастроить после создания задачи.
- **Координатор** (`startCoordinator`): запускается агентом роли `coordinator` с её моделью;
  если такой роли нет — `claude` без модели.
- **Флаг модели** (`packages/core/src/agents.ts`, `modelFlag`): пустая модель — без флага.

  | Агент | Флаг модели |
  |---|---|
  | `claude` | `--model <model>` |
  | `codex` | `-m <model>` |
  | `cursor` (`cursor-agent`) | `--model <model>` |
  | `gemini` | `-m <model>` |
  | `opencode` | `--model <model>` |
  | `amp`, `copilot`, `goose`, `shell` | игнорируют (модель задаётся у самого агента) |

- **Проверки** (`src/main/agents.ts`): `pickRole(roles, agents, requested)` — указанная роль должна
  существовать, её агент — пройти `assertAgentUsable` (известен, установлен, включён в проекте);
  без `--role` роль берётся только если она в проекте одна, иначе ошибка со списком ролей.
  `task.create` по сокету и `tasks:create` из UI идут через `pickRole`; `--agent` в `task.create`
  отвергается с подсказкой про `--role`. `worker.start` (сокет и UI) заново проверяет роль задачи
  и её агента: роль могли удалить, агента — выключить.
- **Сокет**: `roles.list` → роли плюс `agentEnabled` (включён ли агент роли в проекте);
  `columns.list` → колонки в порядке показа; `task.update {task, title?, spec?}` → `store.editTask`
  (без `--title`/`--spec` — ошибка; см. «Редактирование задачи»).

## CLI (минимум для координатора)

```
orca-board run create --objective "..."
orca-board agents list                      # [{id,title,installed,enabled,version?}]
orca-board roles list                       # [{id,title,agent,model?,agentEnabled}]
orca-board columns list                     # [{id,title,color,kind}]
orca-board task create --title ... --spec ... --role <id> [--dep <id>] [--run <id>]
orca-board task move --task <id> --status <id колонки>
orca-board task update --task <id> [--title ...] [--spec ...]   # не для задач в in_progress
orca-board worker start --task <id>
orca-board check --wait --types worker_done,question --timeout-ms 900000 [--run <id>]
orca-board check --follow [--types ...] [--run <id>]   # поток: строка JSON на событие, до SIGINT/SIGTERM
orca-board runs list
orca-board runs close [--run <id>]
orca-board worker read --dispatch <id>
orca-board gate create --task <id> --question "..." --options a,b
```

`--run` у `task create`, `check` и `runs close` по умолчанию берётся из `$ORCA_RUN_ID` и уходит как
`params.run`: задачи (в т.ч. ревью), созданные координатором, наследуют его прогон
(`packages/cli/bin/orca-board.js`). `runs close` без прогона — ошибка до обращения к сокету.
`check --follow` (важнее `--wait`) шлёт `follow: true` и печатает `JSON.stringify(result.event)` на
каждую строку ответа; SIGINT/SIGTERM → закрыть сокет, код 0; ошибка сервера или разрыв соединения → код 1.

## CLI (для воркера, внутри его PTY)

```
orca-board done --summary "..." --files a.ts,b.ts
orca-board ask --question "..." --options a,b      # блокирует до ответа
```

## Как воркер получает контекст

При старте PTY в env кладутся `ORCA_TASK_ID`, `ORCA_DISPATCH_ID`, `ORCA_SOCKET`, `ORCA_PROJECT`,
а в `PATH` — папка с `orca-board`. Команда запуска берётся из реестра по агенту роли задачи:
`AGENTS[role.agent].invoke(инструкция, задание, {permissionMode, shell, model: role.model})` → `{command, args}`
(`worker.ts`). Инструкция — `skills/worker.md`, задание — `# Задача: <title>` + spec + замечания ревью.

Координатор (`startCoordinator`): каждый запуск создаёт прогон `store.createRun(objective)`, после спавна —
`setRunPty(runId, ptyId)`. В env: `ORCA_ROLE=coordinator`, `ORCA_RUN_ID=<runId>` и таймауты Bash-инструмента
Claude Code `BASH_DEFAULT_TIMEOUT_MS=1800000`, `BASH_MAX_TIMEOUT_MS=3600000` (долгое ожидание воркеров).
Воркерам эти переменные не ставятся.

| Агент | Бинарник | Как передаются инструкция и задание | Флаг модели |
|---|---|---|---|
| `claude` | `claude` | инструкция через `--append-system-prompt`, задание — позиционный аргумент; плюс `--permission-mode`, `--allowedTools "Bash(orca-board:*)"` | `--model` |
| `codex`, `cursor` (`cursor-agent`) | по id | склейка `инструкция\n\n---\n\nзадание` одним позиционным аргументом | `-m` / `--model` |
| `amp` | `amp` | та же склейка позиционным аргументом | нет |
| `opencode` | `opencode` | склейка в `--prompt` | `--model` |
| `gemini` | `gemini` | склейка в `-i` (интерактив с начальным промптом) | `-m` |
| `copilot` | `copilot` | склейка в `-i` | нет |
| `goose` | `goose` | `run --interactive --text <склейка>` | нет |
| `shell` | `$SHELL` (для детекта — `sh`) | ничего: пустой терминал в worktree | нет |

Координатор запускается агентом роли `coordinator` (fallback — `claude` без модели)
с `skills/coordinator.md` и целью.

## Агенты (`packages/core/src/agents.ts`, `src/main/agents.ts`)

- **Реестр** `AGENTS` в core: `{id, title, bin, versionArgs?, modelHints?, effortOptions, invoke}`. Из него выводятся
  `AgentKind`, `AGENT_IDS`, `AGENT_TITLES` (для UI), `DEFAULT_AGENT = 'claude'`, `modelHints(agent)`
  (`ModelHint[] = {value, label?}` — подсказки для datalist в редакторе ролей, не ограничение; у claude
  алиасы `opus`/`sonnet`/`haiku` с подписью + `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`),
  `effortOptions(agent)` (claude: `low…max` включая `xhigh`; codex: `low`/`medium`/`high`; остальные — `[]`).
- **Запуск** `invoke(system, prompt, {permissionMode, shell, model?, effort?})`: модель — флагом агента;
  `effort` — claude `--effort <e>`, codex `-c model_reasoning_effort=<e>`, у прочих игнорируется;
  пустое значение — флаг не добавляется. `worker.ts` передаёт `role.model`/`role.effort` и воркеру, и координатору.
- **Дефолты агента** (`agentDefaults` в `src/main/agents.ts`): для codex — `model` и `model_reasoning_effort`
  из `~/.codex/config.toml` (построчно, только ключи верхнего уровня до первой секции `[..]`; нет файла /
  ошибка → `{}`), для остальных — нет. Попадают в `AgentInfo.defaults {model?, effort?}`.
  Новый агент — одна запись в массиве, остальное (типы, детект, UI, проверки) подхватывается само.
- **Детект** (`detectAgents`): ищем `bin` как исполняемый файл в `PATH` процесса плюс стандартных папках
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `~/.bun/bin`) —
  Electron из Finder получает урезанный PATH. Сам агент не запускается; только для найденного бинарника
  читается версия `<bin> <versionArgs>` с таймаутом 3 с (первая строка, до 60 символов; ошибка → без версии).
  Результат кэшируется на процесс, `detectAgents(true)` пересканирует (кнопка «Обновить» в «О проекте»).
- **`Project.enabledAgents?: AgentKind[]`** (`projects.ts`): какие агенты включены в проекте; `undefined` —
  все установленные. `agentInfos(enabledAgents)` собирает `AgentInfo[]`:
  `enabled = installed && (enabledAgents === undefined || включён)`. Меняется через IPC `projects:setEnabledAgents`.
- **Где проверяется** (`assertAgentUsable`: неизвестный / не установлен / выключен → ошибка с текстом для CLI и UI):
  агент проверяется не сам по себе, а через роль — `pickRole` при `task.create`/`tasks:create`
  и повторная проверка роли задачи при `worker.start` (см. «Роли и колонки»). `pickAgent` удалён.
- **Сокет `agents.list`** → `[{id, title, installed, enabled, version?, defaults?}]` в порядке реестра;
  IPC `agents:list(refresh?)` — то же для активного проекта.
- **Логотипы** (`renderer/src/AgentLogo.tsx`): `<AgentLogo agent size?>` — inline SVG 24×24 с `fill="currentColor"`,
  окрашенный в брендовый цвет из таблицы `COLORS` (claude `#d97757`, codex `#10a37f`, gemini `#4e8df5`,
  amp `#ff5543`, goose `#f6b93b`, shell серый; монохромные cursor/copilot/opencode — белый). Неизвестный id
  (`isAgentKind` false) рисуется как `shell`. SVG лежат в `renderer/src/logos/<id агента>.svg`
  (simple-icons, CC0; `goose.svg` нарисован вручную), импортируются строками через Vite `?raw`,
  тип модуля `*.svg?raw` объявлен в `renderer/src/env.d.ts`. `inner()` срезает обёртку `<svg>` и `<title>`,
  внутренности вставляются через `dangerouslySetInnerHTML` в свой `<svg>`. Используется на карточке (28),
  в шапке модалки задачи (28), в списке агентов «О проекте» (20) и в списке терминалов (16).

## UI: доска и «О проекте»

- **Состояние по проектам** (`App.tsx`): вкладка (`Канбан` / `Терминалы` / `О проекте`) и выбранный
  терминал — свои у каждого проекта: `views: Record<projectId, ProjectView { tab, activePty }>`,
  запись через `updateView(projectId, patch)` (функциональный апдейтер, безопасен из обработчиков событий).
  Вкладка дублируется в `localStorage` ключом `orca.tab.<projectId>` (`storedTab` / `storeTab`,
  ошибки localStorage глотаются) и переживает перезапуск; `activePty` — только в памяти.
  Без активного проекта ключ `''` — вкладки работают, но не сохраняются. Если `activePty` проекта
  указывает на закрытый терминал или не выбран — берётся первый терминал проекта.
- **Смена проекта** (`useEffect` по `active?.id`: сайдбар или `projects:focus`) сбрасывает выбранную
  задачу и закрывает модалку задачи (`openTaskId = null`) — чужая задача в модалке не остаётся.
- **Колонки доски** (`Board.tsx`) рендерятся из `Project.columns` (порядок, название, цвет заголовка, иконка по `kind`).
  Все проверки статуса на доске — по `kind` колонки, а не по её id.
- **Карточка** компактная: слева `AgentLogo` (28), справа заголовок (до 2 строк, `-webkit-line-clamp: 2`)
  и строка «роль · агент · модель» (`role.title` по `task.roleId`, `AGENT_TITLES[task.agent]`, `role.model`
  если задана). Ниже чипы: ветка (mono), зависимости `← <название>`, `● терминал` (есть живой PTY),
  `вышел без done` / `упал` (по `outcome` последнего dispatch'а), `молчит` (`stuckNotified` без `endedAt`).
  Кнопки «Запустить» (только если `kind` `ready`/`backlog` или последний dispatch `unknown`/`failed`,
  и нет живого терминала) и «Удалить» (с `confirm`) — в правом верхнем углу, видны при наведении/фокусе/
  `selected`, на touch — всегда. Строка `Завершено: …` в колонке `done` (из `doneAt`), `Обновлено: …` при
  сортировке «по обновлению». `task.feedback` — одной строкой `↩ …` вне колонки `review`.
  В колонке `review` — краткий блок «Ждёт ревью: N файлов» + «Открыть»; на каждый открытый вопрос —
  блок с текстом вопроса + «Открыть». Полные формы ревью и ответа на вопрос живут только в модалке задачи.
  Клик по карточке или «Открыть» → `onSelect` + `onOpenTask` (модалка).
- **Фикс обрезки** (`styles.css`): у `.card` нет `overflow: hidden` (только `overflow-wrap: anywhere`),
  `.card` и все `.col-body > *` — `flex-shrink: 0`, чтобы карточки не сжимались по высоте;
  скроллится только `.col-body` (`overflow-y: auto`), цепочка `min-height: 0`:
  `.content → .board-wrap → .board → .column → .col-body`. Ширина колонки фиксирована (300px).
- **Сортировка карточек** внутри колонки: переключатель «Сортировка: по созданию / по завершению /
  по обновлению» (`createdAt` / `doneAt` / `updatedAt`), выбор хранится в `localStorage`
  ключом `orca.board.sort`.
- **Прогоны на доске** (`runs.tsx`, `Board.tsx`): у задачи с `runId` среди чипов — метка прогона `RunBadge`
  (первые 3 слова цели, до 24 символов с `…`, полная цель в `title`). Цвет — `.run-c0…7` по индексу прогона
  в списке, отсортированном по `createdAt` (`runColorIndex`, по модулю 8); закрытый прогон (`closedAt`) —
  приглушённая пунктирная метка. В тулбаре доски (если прогоны есть) select «Прогон»: «Все прогоны», прогоны
  (первые слова цели, «(закрыт)»), «Без прогона» — фильтрует карточки во всех колонках. Фильтр хранит `App`
  в памяти по `projectId` (`runFilters`), не персистится; исчезнувший прогон в фильтре → «все».
- **Модалка задачи** (`TaskModal.tsx`): `App` хранит `openTaskId` и на каждый снимок находит задачу по id,
  так что модалка всегда показывает актуальное. Закрытие — Esc, клик по фону, крестик. Содержимое:
  - шапка: `AgentLogo` + название (input, если можно редактировать, иначе `<h3>`);
  - мета: роль · агент · модель, колонка (чип цветом колонки), зависимости, ветка, worktree, «терминал открыт»;
  - «Задание для агента»: textarea + «Сохранить» (активна при изменениях и непустом названии) →
    `window.orca.tasks.update(id, {title, spec})` (IPC `tasks:update`). Для задачи в колонке `kind=in_progress`
    поля только для чтения с подписью «Задача в работе — название и описание редактировать нельзя»;
    ошибку от main (например, пустое название) модалка показывает рядом с кнопкой;
  - «Замечания после ревью» (`task.feedback`), «Ревью» (`ReviewBlock`, только в `kind=review`; accept/reject
    закрывают модалку), «Вопросы» (все вопросы задачи: варианты кнопками + свободный ответ, отвеченные —
    с ответом и датой), «История запусков» (dispatch'и по убыванию `startedAt`: даты, исход
    `готово`/`упал`/`вышел без done`/`работает`/`без исхода`, `молчит`, summary, файлы);
  - подвал: «Удалить» (с `confirm`), «Открыть терминал» (вкладка «Терминалы» + PTY активного dispatch'а
    или любой терминал задачи), «Запустить» (те же условия, что на карточке).
- **Вкладка «Терминалы»** (`App.tsx`, `.term-page`): грид `220px + xterm`. Слева список открытых PTY:
  точка «жив/завершился» (по `pty:exit`), `AgentLogo` (16), название и роль (по задаче из снимка;
  координатор — «координатор»/роль `coordinator`; голая оболочка — «оболочка»), крестик — `pty.kill` +
  удаление из списка. Список, бейдж на вкладке и счётчик в «О проекте» показывают только терминалы
  активного проекта (`projectTerminals` — фильтр `terminals` по `projectId === active.id`). Справа `Terminal`
  рендерится на **каждый** PTY всех проектов; неактивные и чужие скрыты через `.hidden`, не размонтируются —
  при возврате на проект вывод и состояние xterm сохранены.
  Терминалы появляются по `worker:opened` (из UI и через CLI координатора; вкладка при CLI-запуске
  не переключается; если у проекта терминала ещё нет — новый становится его `activePty`), исчезают
  по `worker:closed` (`dropTerminal`: только функциональные апдейтеры, потому что события приходят пачкой;
  если закрыт активный терминал проекта — выбирается соседний терминал того же проекта) или по крестику.
  Завершившийся сам PTY остаётся в списке с серой точкой, пока его не закроют.
- **`showTerminal(ptyId?, projectId = active.id)`**: проект терминала берётся из списка терминалов,
  иначе переданный `projectId` (PTY только что создан, `worker:opened` ещё не пришёл), иначе активный.
  В запись этого проекта пишутся `tab: 'terminals'` и `activePty`. Активный проект **не переключается**:
  если терминал принадлежит другому проекту (пользователь успел переключиться, пока шёл `await`
  запуска), вкладка и терминал просто запоминаются до перехода на тот проект. `openShell`, `startTask`
  и старт координатора фиксируют `projectId` до `await`; `startTask` выделяет задачу, только если
  проект всё ещё активен (`activeIdRef`).
- **«О проекте»**, разделы:
  - «Агенты» — кто установлен (логотип, название, версия), чекбоксы включения (`enabledAgents`).
  - «Роли» (`RolesEditor.tsx`) — список ролей: id, название, агент (только из реестра),
    модель (свободный ввод с подсказками `modelHints`, `value` + `label`; у агента с `defaults.model` (codex) она
    идёт первой подсказкой и в плейсхолдере «по умолчанию: <model>», иначе «по умолчанию агента»),
    усилие — select из `effortOptions` агента, первая опция «по умолчанию» (пусто → `effort` не сохраняется;
    с `defaults.effort` — «по умолчанию: <effort>»), у агента без effort — задизейбленный прочерк; при смене агента
    `effort`, которого нет в новом списке, сбрасывается. Сохраняется через `projects:setRoles`.
  - «Колонки» (`ColumnsEditor.tsx`) — порядок, название, цвет из `COLUMN_COLORS`, kind;
    системные колонки нельзя удалить, кастомные — можно (задачи уедут в backlog).
    Сохраняется через `projects:setColumns`.
  - «Прогоны» (`RunsSection` в `runs.tsx`) — свежие сверху: метка, дата создания, «задач N / закрыто M»
    (задачи с этим `runId`, закрыто — в колонках `kind=done`), статус «идёт» / «закрыт <дата>», полная цель.
    У идущего прогона кнопка «Закрыть» (`confirm` → IPC `runs:close`). Пусто — заглушка.
  - «Разрешения агентов» — `permissionMode` проекта (см. «Разрешения Claude Code»).
  - «Настройки по умолчанию» — «Сохранить настройки этого проекта как дефолт» (`projects:setDefaults`
    с permissionMode/enabledAgents/roles/columns проекта, `confirm`), «Применить дефолт к этому проекту»
    (`projects:applyDefaults`, `confirm`; после — `refreshProjects` и пересоздание редакторов через `settingsRev`),
    «Редактировать дефолт» — открывает `DefaultsModal`.
- **Редакторы ролей/колонок** (`RolesEditor`, `ColumnsEditor`) не знают о проекте: `storageKey` (ключ `useAutoSave`
  и id datalist) + начальные `roles`/`columns` + `onSave`. В «О проекте» `storageKey = active.id`, в дефолте — `'defaults'`.
- **Модалка дефолта** (`DefaultsModal.tsx`): открывается из подвала сайдбара («Настройки по умолчанию») и из «О проекте».
  Грузит `getDefaults()`, показывает агентов (галочка «Все установленные» = `enabledAgents: undefined`), роли, колонки,
  `permissionMode`; каждое изменение — `setDefaults(patch)`, ошибка main — под разделом. В ролях «включён» считается
  по дефолту, а не по активному проекту. Закрытие — Esc, фон, крестик.

## IPC (`src/main/index.ts` → `registerIpc`, типы — `shared/ipc.ts` `OrcaApi`, мост — `preload/index.ts`)

- `invoke`: `app:info`; `projects:list`, `projects:add`, `projects:setActive`, `projects:remove`,
  `projects:setPermissionMode`, `projects:setEnabledAgents`, `projects:setRoles`, `projects:setColumns`,
  `projects:getDefaults`, `projects:setDefaults(patch)`, `projects:applyDefaults(id)`; `agents:list(refresh?)`;
  `board:get` (snapshot с `runs`); `runs:list`, `runs:close(id)`; `tasks:create`, `tasks:move`, `tasks:update`, `tasks:remove`; `questions:answer`; `pty:spawn`;
  `worker:start`; `coordinator:start`; `review:info`, `review:accept`, `review:reject`.
- `send` (renderer → main, без ответа): `pty:write`, `pty:resize`, `pty:kill`.
- События main → renderer: `board:changed {projectId, snapshot}`, `worker:opened`, `worker:closed`,
  `projects:focus` (клик по уведомлению), `pty:data:<id>`, `pty:exit:<id>`.

## Протокол сокета

Одна строка JSON-запроса `{id, method, params, dispatchId?, taskId?, projectId?}`, одна строка ответа
`{id, ok, result | error}`. `check --wait` и `ask` держат соединение открытым до события.
`check` с `follow: true` — исключение: сервер пишет по строке `{id, ok: true, result: {event}}` на каждое
событие, пока клиент не закроет соединение.
События помечаются `consumedBy`, повторно `check` их не отдаёт.

## Разрешения Claude Code

Координатор и воркеры запускаются с `--permission-mode <режим проекта>` и
`--allowedTools "Bash(orca-board:*)"`. Режим хранится в `Project.permissionMode`
(вкладка «О проекте»), по умолчанию `auto`: Claude Code сам одобряет обычные действия и
спрашивает только про опасные. `bypassPermissions` — вообще без вопросов, `acceptEdits` —
только правки файлов без вопросов, остальной Bash спросит в терминале приложения.

## Ревью и мерж (`src/main/review.ts`, `src/main/git.ts`)

- `review info`: `git diff --stat base...branch`, `git log base..branch`, плюс незакоммиченное в worktree.
- `review accept`: незакоммиченное коммитится от `orca-board`, затем `git merge --no-ff` в текущую
  ветку репозитория, `git worktree remove --force`, `git branch -D`; задача → колонка `kind=done`
  (`store.columnId('done')`, проставляется `doneAt`). Конфликт → `merge --abort` и ошибка в UI.
- `review reject --feedback`: задача → колонка `kind=ready`, `task.feedback` добавляется в промпт при следующем старте.

## Редактирование задачи и автозакрытие терминалов (`src/main/index.ts`)

- `store.editTask(id, {title?, spec?})` (core) — единая точка для IPC `tasks:update` (модалка задачи)
  и сокета `task.update` (CLI `orca-board task update`): задача в колонке `kind=in_progress` отвергается
  с ошибкой (воркер уже получил задание в промпт), пустое название после trim — тоже. Внутри — `updateTask`,
  так что `updatedAt` и `board:changed` идут как обычно.
- **Автозакрытие**: main в `projects.onChange` (любой `commit` store) вызывает `closeDoneWorkers`:
  у задач в колонке `kind=done` закрываются dispatch'и (`store.closeDispatches` ставит `endedAt`/`outcome=unknown`
  незакрытым — иначе `ptyExited` принял бы kill за падение), живые PTY убиваются (`killPty`), renderer получает
  `worker:closed { ptyId, taskId, projectId }` (`window.orca.worker.onClosed` в preload). Ловятся все пути в done:
  `review accept`, `task move`, `tasks:move` из UI. После `orca-board done` dispatch уже закрыт, а PTY жив —
  поэтому проверяется и живость PTY у закрытых dispatch'ей (`isAlive`).
- **Перезапуск** (`runWorker`, общий путь для IPC `worker:start` и сокета `worker.start`): задача в
  `kind=in_progress` отвергается, роль и агент перепроверяются, затем старые терминалы задачи закрываются
  тем же `closeTaskWorkers` с `worker:closed`, и только потом стартует новый PTY (`worker:opened`).
- PTY координатора не привязан к dispatch и ни в одном сценарии приложением не закрывается
  (только крестиком в списке терминалов).

## Детектор тишины

`pty.ts` хранит `lastOutputAt` на сессию. Раз в минуту main проверяет живые dispatch'и:
нет вывода дольше `ORCA_STUCK_MINUTES` (по умолчанию 10) → одно событие `escalation` на dispatch
(`Dispatch.stuckNotified`), на карточке чип «молчит».

## Подготовка worktree

Если worktree только что создан и есть lock-файл, агент запускается через
`$SHELL -c "<setup>; exec <agent> ..."` — установка идёт в том же терминале, что видит пользователь.

## Проекты (`src/main/projects.ts`)

`ProjectManager` хранит список репозиториев в `userData/projects.json` (вместе с `permissionMode`,
`enabledAgents`, `roles`, `columns`), доску каждого — в `userData/boards/<id>.json`
(`id` = sha1 от корня репозитория). `userData` фиксирован: `~/Library/Application Support/orca-board`.
`TaskStore` проекта создаётся с `() => this.columns(id)`, поэтому смена колонок видна store сразу.
UI работает с активным проектом; агенты получают `ORCA_PROJECT` в env, и CLI кладёт его в запрос,
поэтому воркер продолжает писать в свою доску, даже если пользователь переключился на другой проект.

**Формат `projects.json`**: `{ projects: Project[], activeId, defaults?: Partial<ProjectDefaults> }`.
`ProjectDefaults { permissionMode, enabledAgents?, roles, columns }` (`projects.ts`, дубль типа —
`shared/ipc.ts`). Файл без `defaults` (старый формат) читается как есть; `defaults` не-объект → удаляется при `load()`.

**Настройки по умолчанию**:
- `defaults()` — глобальный дефолт с подстановкой встроенных значений для незаданных полей
  (`permissionMode` → `auto`, `enabledAgents` → нет поля = все установленные, `roles` → `DEFAULT_ROLES`,
  `columns` → `DEFAULT_COLUMNS`); массивы и объекты — копии.
- `setDefaults(patch)` — мерж патча в `data.defaults`: `permissionMode` проверяется по `PERMISSION_MODES`
  (`isPermissionMode`), роли/колонки — `validateRoles` / `validateColumns`, `enabledAgents` фильтруется
  через `isAgentKind`; явный ключ `enabledAgents: null/undefined` — сброс в «все установленные».
  Не объект → ошибка. Возвращает `defaults()`.
- `add(root)`: новый проект получает копию дефолта — `permissionMode`, `enabledAgents` (если задан),
  `roles`, `columns`. Уже добавленный репозиторий возвращается как есть, дефолт к нему не применяется.
  Проекты, созданные раньше, не меняются при правке дефолта.
- `applyDefaults(id)` — переписывает настройки существующего проекта дефолтом: `permissionMode`,
  `enabledAgents` (нет в дефолте → поле удаляется), затем `setRoles` и `setColumns` — последний, как и при
  ручной правке, переводит задачи из исчезнувших колонок в колонку `kind=backlog` (`store.reassignColumn`).
  Задачи с `roleId` удалённой роли остаются как есть — `worker.start` для них вернёт ошибку.

## Уведомления

`ProjectManager.onEvents` отдаёт новые события store; main показывает `Notification`
для `question`, `escalation`, `worker_done` (в подзаголовке — название колонки задачи).
Клик по уведомлению фокусирует окно и переключает проект.

## Сборка

`electron-builder.yml`: `extraResources` копирует `packages/cli/bin` в `Resources/cli`,
`cliBinDir()` в проде берёт его оттуда. `npmRebuild: true` пересобирает node-pty под Electron.
`pnpm run pack` (не `pnpm pack` — это встроенная команда pnpm).

## Грабли разработки

- `git reset --hard` в скриптах тестирования дважды стёр незакоммиченные правки. Правило:
  коммит сразу после зелёного typecheck, тесты — только read-only git-командами.

## Открытые вопросы

- Удалённый запуск по SSH, мобильный просмотр.
- SQLite вместо JSON, если событий станет много.
- Подпись и нотаризация .app.
