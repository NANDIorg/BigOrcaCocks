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
- `Role { id, title, agent, model? }` — кто выполняет задачу: агент из реестра и модель
  (пусто — модель агента по умолчанию). `DEFAULT_ROLES`: `coordinator`, `developer`, `reviewer`, `qa`;
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
  `undefined` — `DEFAULT_ROLES` / `DEFAULT_COLUMNS` (`ProjectManager.roles(id)`, `columns(id)`).
  Меняются через IPC `projects:setRoles` / `projects:setColumns` (вкладка «О проекте»).
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
  `columns.list` → колонки в порядке показа.

## CLI (минимум для координатора)

```
orca-board run create --objective "..."
orca-board agents list                      # [{id,title,installed,enabled,version?}]
orca-board roles list                       # [{id,title,agent,model?,agentEnabled}]
orca-board columns list                     # [{id,title,color,kind}]
orca-board task create --title ... --spec ... --role <id> [--dep <id>]
orca-board task move --task <id> --status <id колонки>
orca-board task update --task <id> [--title ...] [--spec ...]   # не для задач в in_progress
orca-board worker start --task <id>
orca-board check --wait --types worker_done,question --timeout-ms 900000
orca-board worker read --dispatch <id>
orca-board gate create --task <id> --question "..." --options a,b
```

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

- **Реестр** `AGENTS` в core: `{id, title, bin, versionArgs?, modelHints?, invoke}`. Из него выводятся
  `AgentKind`, `AGENT_IDS`, `AGENT_TITLES` (для UI), `DEFAULT_AGENT = 'claude'`, `modelHints(agent)`
  (подсказки для datalist в редакторе ролей, не ограничение).
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
- **Сокет `agents.list`** → `[{id, title, installed, enabled, version?}]` в порядке реестра;
  IPC `agents:list(refresh?)` — то же для активного проекта.

## UI: доска и «О проекте»

- **Колонки доски** рендерятся из `Project.columns` (порядок, название, цвет заголовка);
  карточка показывает название роли по `task.roleId`.
- **Сортировка карточек** внутри колонки: переключатель «Сортировка: по созданию / по завершению /
  по обновлению» (`createdAt` / `doneAt` / `updatedAt`), выбор хранится в `localStorage`
  ключом `orca.board.sort`. На карточках в колонке `done` показывается строка «Завершено: …» из `doneAt`.
- **«О проекте»**, разделы:
  - «Агенты» — кто установлен, версия, чекбоксы включения (`enabledAgents`).
  - «Роли» (`RolesEditor.tsx`) — список ролей: id, название, агент (только из реестра),
    модель (свободный ввод с подсказками `modelHints`). Сохраняется через `projects:setRoles`.
  - «Колонки» (`ColumnsEditor.tsx`) — порядок, название, цвет из `COLUMN_COLORS`, kind;
    системные колонки нельзя удалить, кастомные — можно (задачи уедут в backlog).
    Сохраняется через `projects:setColumns`.

## Протокол сокета

Одна строка JSON-запроса `{id, method, params, dispatchId?, taskId?, projectId?}`, одна строка ответа
`{id, ok, result | error}`. `check --wait` и `ask` держат соединение открытым до события.
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

- `store.editTask(id, {title?, spec?})` (core) — единая точка для IPC `tasks:update` и сокета `task.update`:
  задача в колонке `kind=in_progress` отвергается с ошибкой (воркер уже получил задание в промпт),
  пустое название — тоже. Внутри — `updateTask`, так что `updatedAt` и `board:changed` идут как обычно.
- **Автозакрытие**: main в `projects.onChange` (любой `commit` store) вызывает `closeDoneWorkers`:
  у задач в колонке `kind=done` закрываются dispatch'и (`store.closeDispatches` ставит `endedAt`/`outcome=unknown`
  незакрытым — иначе `ptyExited` принял бы kill за падение), живые PTY убиваются, renderer получает
  `worker:closed { ptyId, taskId, projectId }` (`onWorkerClosed` в preload). Ловятся все пути в done:
  `review accept`, `task move`, `tasks:move` из UI. После `orca-board done` dispatch уже закрыт, а PTY жив —
  поэтому проверяется и живость PTY у закрытых dispatch'ей.
- **Перезапуск** (`runWorker`, общий путь для UI и `worker.start`): перед стартом нового PTY старые
  терминалы задачи закрываются тем же `closeTaskWorkers` с `worker:closed`.
- PTY координатора не привязан к dispatch и ни в одном сценарии не закрывается.

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
