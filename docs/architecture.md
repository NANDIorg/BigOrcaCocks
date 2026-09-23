# Архитектура orca-board

Правила разработки (что нельзя, что обязательно, проверки) — в [CLAUDE.md](../CLAUDE.md).

## Процессы

```
Electron main ───── node-pty ───── PTY: claude (координатор)
   │                                   └─ bash: orca-board task create ...
   │                                          │ unix socket (win32: named pipe) / JSON-RPC
   ├── JSON (tasks, runs, events) ◄───────────┘
   ├── node-pty ───── PTY: claude (воркер задачи #12, worktree ../wt/task-12)
   ├── node-pty ───── PTY: codex  (воркер задачи #13, worktree ../wt/task-13)
   └── renderer (React): доска + xterm.js на каждый PTY
```

- Все агенты — дочерние процессы приложения. Никакого API: агент логинится сам.
- CLI `orca-board` — тонкий клиент к сокету приложения. Его вызывают агенты
  через свой Bash. Приложение — единственный владелец состояния.
- Сокет: `$ORCA_SOCKET`, иначе `~/.orca-board/orca.sock`, на Windows — `\\.\pipe\orca-board`
  (см. «Кроссплатформенность»).

## Модель (`packages/core/src/types.ts`)

- `Task { id, title, spec, status, deps[], runId?, roleId, agent, worktree?, branch?, dispatchId?, feedback?, answerFor?, createdAt, updatedAt, startedAt?, activeMs?, activeSince?, doneAt? }`.
  - `status` — **id колонки доски** (`TaskStatus = string`), не фиксированный enum.
  - `roleId` — роль проекта (см. «Роли и колонки»); агент и модель берутся из неё при старте.
    `agent` — снимок `AgentKind` на момент создания/запуска, `worker.ts` синхронизирует его с ролью.
  - `runId` — прогон (= глобальная задача), к которому относится задача (см. «Прогоны»); задаётся только при создании,
    `updateTask` его не меняет. Без прогона задача попадает во «Входящие» (`docs/nested-kanban.md`).
  - `startedAt` — первый `startDispatch`; `doneAt` — момент попадания в колонку `kind=done`
    (при выходе из неё сбрасывается, `store.setStatus`).
  - **Время работы** (`activeMs`, `activeSince`, `packages/core/src/active-time.ts`) копится только пока задача в
    колонке `kind=in_progress`: `setStatus` → `trackActiveTime` открывает отрезок при входе (`activeSince = now`,
    `activeMs ??= 0`) и прибавляет его к `activeMs` при выходе в любую другую колонку (review, needs_input, ready,
    done, backlog — перенос, `done`, падение/остановка воркера, reopen). Повторный вход продолжает от набранного.
    Нет обоих полей — задача не бывала в работе. `updateTask` их не принимает. Показ — `taskActiveTime` +
    `activeDuration` (renderer: `taskDuration`/`taskTicking` в `duration.ts`): живой тик только при `activeSince`,
    иначе застывшее значение. Задача без полей от старого main — прежний расчёт от `startedAt` до `doneAt`/now.
    Миграция при загрузке (`migrateActiveTime`, до `closeStaleDispatches`): `activeMs` = сумма закрытых dispatch
    задачи; задача в `in_progress` получает `activeSince` = начало живого dispatch (нет — `updatedAt`), и
    `closeStaleDispatches` закрывает этот отрезок при возврате в ready. Ограничение: dispatch, не переживший
    перезапуск приложения, закрывается моментом загрузки — время простоя приложения попадает в отрезок.
  - `answerFor` — задача-ответ (`human` | `coordinator`): результат — markdown в `Dispatch.answer`, а не код;
    см. «Ответы и ожидание человека» в `docs/nested-kanban.md`.
- `Role { id, title, description?, agent, model?, effort?, systemPrompt? }` — кто выполняет задачу: агент из реестра, модель
  и уровень рассуждений `effort` (пусто — по умолчанию у агента; `validateRoles` обрезает пробелы,
  пустая строка → поле не сохраняется); `description` — назначение роли для координатора: он видит его в `roles list`
  и по нему выбирает `--role` (`skills/coordinator.md`); `systemPrompt` — пользовательские инструкции роли (см. «Системный промпт роли»). `DEFAULT_ROLES`: `coordinator`, `assistant`, `developer`, `reviewer`, `qa`
  (с заполненным `description`; пустое назначение системной роли — в т.ч. у ролей, созданных до появления поля, —
  подставляется из дефолта: `withDefaultDescriptions` при чтении `projects.json` и в `validateRoles`);
  `DEFAULT_ROLE_ID = 'developer'` — его получают задачи без `roleId` при миграции старой доски.
- `BoardColumn { id, title, color, kind }`. `kind` — системный (`backlog`, `ready`, `in_progress`,
  `needs_input`, `review`, `done`) либо `custom`. По `kind` store делает автоматические переходы,
  по `id` — хранит статус задачи. `color` — hex из `COLUMN_COLORS` (8 предустановленных).
- `DEFAULT_COLUMNS`: `id === kind` (`backlog`…`done`), поэтому старые доски со строковыми
  статусами открываются без миграции.
- `TASK_STATUSES` и `STATUS_TITLES` — только дефолт, помечены `@deprecated`: реальные колонки
  живут в настройках проекта.
- `Run { id, objective, title?, status?, inbox?, createdAt, updatedAt?, reopenedAt?, closedAt?, coordinatorPtyId?, activeMs?, activeSince?, ... }` — прогон:
  один запуск координатора со своим набором задач; в проекте их может быть несколько. Хранятся в доске (`StoreSnapshot.runs`).
  Прогон — это же **глобальная задача** двухуровневой доски (статус-колонка, название, «Входящие» для задач без прогона);
  контракт и миграция — `docs/nested-kanban.md`.
  - `activeMs`/`activeSince` — **собственное время** глобальной задачи (по образцу `Task`, `trackActiveTime`): отрезок
    открыт, пока карточка показана в `kind=in_progress` (в «Нужен ответ» стоит). Пересчёт — `syncRunActiveTime` в
    `commit()`, миграция — `migrateRunActiveTime`. В `GlobalTask` — `ownActiveMs`/`ownActiveSince`, рядом сумма
    подзадач `subtasksActiveMs`/`subtasksActiveSince` (`docs/nested-kanban.md`, «Тип GlobalTask»).
- `Dispatch { id, taskId, ptyId, startedAt, endedAt?, outcome?, summary?, files?, answer?, stuckNotified? }` — `answer` — ответ задачи-ответа.
- `Question { id, taskId, dispatchId?, question, options: RequestOption[], context?, answer?, forHuman?, createdAt, answeredAt? }` —
  вопрос воркера (`ask`); `RequestOption { id, label, hint?, recommended? }` (`id` — номер варианта). `forHuman` — вопрос
  адресован человеку и по нему есть `HumanRequest`. Ответить можно один раз, у запуска — не больше одного открытого вопроса.
- `HumanRequest { id, runId, taskId, dispatchId?, kind, status, title, body?, options[], questionId?, resolution?, createdAt, resolvedAt? }` —
  запрос к человеку: `kind` `question` | `answer` | `escalation`, `status` `pending` | `resolved` | `cancelled`.
  Единственный источник «ждёт человека» (колонка «Нужен ответ», Инбокс, уведомления); модель, переходы и события —
  `docs/human-requests.md`. Хранится в `StoreSnapshot.requests`.
- `Event { id, type, taskId?, dispatchId?, payload, createdAt, consumedBy? }`
  типы (`EVENT_TYPES`): `task_ready`, `worker_done`, `question`, `escalation`, `question_answered`, `answer_accepted`, `run_done`,
  `request_created`, `request_resolved`, `answer_clarified`. Payload короткие: в `worker_done`/`answer_accepted` `answer` —
  последнее поле, обрезан до 2000 символов (`answerTruncated: true`), полный ответ и `decision` — `orca-board task answer --task <id>`;
  тексты в `question`/`request_created`/`answer_clarified` — до 300 символов, целиком — `question get` / `request get`.
- Автопереходы (`store.ts`, по `kind`): `backlog → ready`, когда все `deps` в `done`;
  `in_progress` при старте воркера; `review` после `done`; `needs_input` — пока у задачи есть `pending` `HumanRequest`
  (вопрос к человеку, ответ для человека, выход PTY без `done`); решили последний — обратно в поток.
  При загрузке снапшота dispatch без `endedAt` закрываются (`unknown`), их задачи из `in_progress` → `ready`.

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
- **Дефолтные роли**: `coordinator`, `assistant`, `developer`, `reviewer`, `qa` — все на `claude`, модель пустая, `description` заполнен.
  `coordinator` и `assistant` — служебные (`SERVICE_ROLE_IDS`, `isTaskRole` в `packages/core/src/prompts.ts`): в «Новой задаче»
  их нет, в редакторе ролей они в группе «Системная».
- **Удаление системных ролей**: любую роль, в том числе из `DEFAULT_ROLES`, можно удалить, кроме последней
  (`validateRoles`). Удалённая роль не возвращается сама: `?? DEFAULT_ROLES` срабатывает только у проекта без поля
  `roles`, а сохранённый массив всегда непустой. Редактор ролей (`RolesEditor.tsx`, логика — `renderer/src/roleRemoval.ts`)
  перед удалением системной роли или роли с задачами показывает подтверждение со списком последствий
  (`removalConsequences`); под списком ролей — «Вернуть системные роли» (`restoreSystemRoles`: недостающие из
  `DEFAULT_ROLES` с настройками по умолчанию, на свои места). Без роли: `task create --role <id>` и `worker start` —
  ошибка `missingRoleMessage` (`src/main/agents.ts`: список ролей и, для системной, как её вернуть); координатор
  не запускается (см. ниже); без `reviewer` координатор не создаёт задачи ревью (`skills/coordinator.md`).
- **Валидация ролей** (`validateRoles`): хотя бы одна роль; непустые уникальные `id`, непустые
  `title`; `agent` — известный `AgentKind`; `model` и `effort` — строки или отсутствуют (пустые после trim → удаляются);
  `description` и `systemPrompt` — строки или отсутствуют, хранятся как введены (без trim), из одних пробелов → удаляются;
  у системных ролей (id из `DEFAULT_ROLES`) пустое `description` заменяется назначением по умолчанию.
- **Валидация колонок** (`validateColumns`): хотя бы одна; непустые уникальные `id` и `title`;
  каждый системный `kind` ровно один раз (удалить или продублировать системную колонку нельзя),
  остальные — `custom`; пустой `color` → первый из `COLUMN_COLORS`. Порядок массива = порядок на доске.
- **Store и колонки**: `TaskStore` получает функцию `columns()` в конструкторе и не хранит колонки сам.
  `columnId(kind)` — id первой колонки с таким `kind` (нет — сам `kind` как запасной вариант),
  `columnKind(id)` — обратное. `moveTask` отвергает неизвестный id колонки.
- **Удаление кастомной колонки**: `setColumns` сначала сохраняет новый набор, затем все задачи
  из исчезнувших колонок переводит в колонку `kind=backlog` (`store.reassignColumn(fromId, toId)`),
  чтобы на доске не осталось задач с несуществующим статусом.
- **Воркер** (`worker.ts`, `startWorker`): роль ищется по `task.roleId` в `ctx.roles` (нет → ошибка `missingRoleMessage`),
  агент — `getAgent(role.agent)`, модель и усилие — `role.model` / `role.effort` уходят в `invoke(..., { model, effort })`.
  Перед стартом `task.agent` обновляется по роли: роль могли перенастроить после создания задачи.
- **Координатор** (`startCoordinator`): запускается агентом роли `coordinator` с её моделью и усилием;
  если такой роли нет (удалили в «О проекте») — ошибка «координатор не запустится: …» до создания прогона.
- **Ассистент** (`startAssistant`): роли — из настроек по умолчанию (`projects.defaults()`), не из проекта;
  роль `assistant`, без неё — агент, модель и effort роли `coordinator` (без её инструкций, `assistantRole`),
  нет и её — `claude` без модели. См. «Ассистент».
- **Системный промпт роли** (`Role.systemPrompt`, `withRoleInstructions` в `packages/core/src/types.ts`):
  при старте воркера и координатора к служебной инструкции Orca (`skills/worker.md` / `coordinator.md`)
  дописывается блок `# Инструкции роли «<title>»` с текстом роли (trim по краям, внутри — как есть).
  Служебные инструкции (done, ask, ревью) не заменяются. Берётся текст именно роли задачи (`task.roleId`)
  или роли `coordinator`; нет поля/пусто — инструкция прежняя. Модель и effort роли передаются как раньше.
  Канал — тот же, что у служебной инструкции: у `claude` — `--append-system-prompt` (настоящий system prompt),
  у остальных агентов отдельного system-канала нет — блок попадает в склейку «инструкция --- задание»
  стартового промпта (см. таблицу в «Агенты»). Текст идёт отдельным элементом argv, без shell-интерполяции
  (в пути с подготовкой worktree — `sh -c` с `shellQuote`); ограничение Windows-fallback через `cmd.exe`
  (переводы строк → пробел, лимит длины) касается и его. Применяется при следующем запуске, уже идущие агенты не меняются.
- **Правила агентов доски** (`Project.agentRules?: string`, `withAgentRules` в `packages/core/src/types.ts`):
  правила, которые получают **только** агенты, запущенные доской (воркеры всех ролей и координатор), — не
  CLAUDE.md/AGENTS.md и не обычные сессии агента в репозитории. Два уровня:
  - общие правила проекта — `Project.agentRules` (markdown одной строкой, `ProjectManager.agentRules(id)` / `setAgentRules(id, text)`);
  - правила роли — **это существующий `Role.systemPrompt`**, отдельного поля нет: он уже доходит и до воркера
    (роль задачи), и до координатора (роль `coordinator`), редактируется в «О проекте → Роли» и сохраняется через `projects:setRoles`.
  Системный промпт: служебная инструкция Orca → `# Правила проекта` + текст (если непустой) →
  `# Инструкции роли «<title>»` (если непустой). Пусто/одни пробелы — блока нет, trim только по краям, текст как есть.
  Хранится как введено (без trim, как `systemPrompt`); из одних пробелов → поле удаляется; не строка → ошибка
  `правила проекта должны быть строкой`. Старые `projects.json` без поля читаются как «правил нет», не-строка
  отбрасывается в `load()`. Правила проекта передаются в `WorkerEnvContext.agentRules` (`ctx()` в `src/main/index.ts`)
  и применяются при следующем запуске агента. Ассистент их не получает (`AssistantContext` без `agentRules`: он один на
  приложение и не работает в репозитории проекта); свой `systemPrompt` роли `assistant` — получает, как раньше.
  Меняются: IPC `projects:getAgentRules` / `projects:setAgentRules`, сокет `rules.get` / `rules.set`,
  CLI `orca-board rules get|set`. Есть и в глобальном дефолте (`ProjectDefaults.agentRules`, см. «Проекты»).
- **Встроенные промпты в UI** (`packages/core/src/prompts.ts`, `src/main/prompts.ts`): тексты `skills/*.md` импортирует
  только `src/main/prompts.ts` (`BUILTIN_PROMPTS`); их же берёт `worker.ts` при запуске и отдаёт IPC `prompts:builtin`
  для раздела «Роли». Там по кнопке «Инструкции» (свёрнуто по умолчанию) видны: встроенная инструкция роли только для чтения
  (`builtinPromptKind`: `coordinator` → coordinator.md, остальные → worker.md), редактируемый `systemPrompt` (хранит только
  дополнения, встроенный текст в него не попадает) и шаблон стартового сообщения с ‹плейсхолдерами›, собранный теми же
  `coordinatorPrompt` / `workerTaskPrompt`. Канал доставки (`promptChannel`) выводится из `invoke` реестра агентов.
- **Флаг модели** (`packages/core/src/agents.ts`, `modelFlag`): пустая модель — без флага. Флаги усилия — в «Агенты».

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

## Прогоны (`packages/core/src/store.ts`, `src/main/worker.ts`, `src/main/socket.ts`)

Прогон (`Run`) отделяет задачи и события одного координатора от других: в проекте может одновременно
работать несколько координаторов, и каждый должен видеть только свои `worker_done`/`question`.

- **Создание**: `coordinator start` (IPC `coordinator:start`, сокет `coordinator.start`) → `startCoordinator`
  → `store.createRun(objective)`, затем `setRunPty` с PTY координатора; `ORCA_RUN_ID` уходит в env
  (см. «Как воркер получает контекст»). Отдельной команды создания прогона нет.
- **Наследование**: CLI для `task.create`, `check`, `runs.close`, `runs.finish` подставляет `params.run = $ORCA_RUN_ID`,
  если `--run` не передан явно (`packages/cli/bin/orca-board.js`, `RUN_METHODS`). Сервер env не читает —
  `task.create` просто пишет `runId: params.run` в задачу. Так задачи координатора, включая задачи ревью,
  попадают в его прогон. Задачи без прогона (`tasks:create` из UI, `task create` без `--run`) — во «Входящие».
- **Глобальные задачи** (`docs/nested-kanban.md`): прогон со статусом-колонкой и подзадачами; повторный запуск
  координатора на существующем прогоне — `coordinator start --global <id>` (новый прогон не создаётся).
- **Фильтр событий** (`store.consumeEvents(types, consumer, runId?)`): с `runId` — только события прогона:
  по задаче с этим `runId` или с `payload.runId === runId` (так ловится `run_done`). В сокете `check`
  consumer = `params.consumer ?? runId ?? 'coordinator'`, поэтому прогоны не «съедают» события друг друга
  (`consumedBy` у события один). Без `runId` — старое поведение: все события, consumer `coordinator`.
- **Автозакрытие** (`closeFinishedRuns`, вызывается из каждого `commit()`): открытый прогон, у которого есть
  задачи и все они в колонке `kind=done`, получает `closedAt` и событие `run_done {runId, objective}`.
  Ловит любой путь в done и удаление задач. Прогон без задач автоматически не закрывается; закрытый —
  повторно не закрывается и `run_done` не шлёт.
- **Ручной done** (`moveGlobalTask` в колонку `kind=done`: IPC `globalTasks:move`, сокет `global.move`): открытый
  прогон закрывается так же, но событие — `run_done {runId, objective, manual: true}`, подзадачи не трогаются.
  Повтор — без изменений и без второго события; перенос из done в другую колонку переоткрывает прогон (`reopenRun`).
- **Закрытие терминала координатора** (`coordinatorsToClose` в `packages/core/src/coordinator-close.ts`,
  опрос раз в 5 с — `watchFinishedCoordinators` в `apps/desktop/src/main/index.ts`): интерактивный CLI
  координатора (Claude Code и Codex) после финальной сводки ждёт ввода и сам не выходит.
  Тишина терминала ≠ завершение (агент может ждать подтверждения команды, человек — читать ответ), поэтому
  нужен положительный сигнал: координатор последней командой вызывает `orca-board runs finish`
  (`store.finishRun` → `Run.finishedAt`). На незакрытом прогоне — ошибка, кроме переоткрытого повторным
  запуском прогона, где все подзадачи уже в `kind=done`: тогда `finishRun` сам закрывает его (`closedAt`,
  `run_done` сразу потреблён, см. `docs/nested-kanban.md`). PTY закрывается `killPty` (вкладка уходит
  по `terminals:changed`) у любого агента, если прогон закрыт именно `run_done`, все задачи прогона и сейчас
  в `kind=done`, по ним нет открытых вопросов и терминал неактивен `COORDINATOR_FINISH_GRACE_MS` (15 с) после сигнала.
  Без сигнала — страховка только для агентов с `lingersAfterAnswer` (Codex): `COORDINATOR_ABANDONED_MS` (30 мин)
  неактивности с `run_done`. Ручной done (`run_done.payload.manual`) — решение человека: подзадачи и вопросы
  не проверяются, терминал любого агента закрывается после `COORDINATOR_FINISH_GRACE_MS` тишины с `run_done`
  (и с сигнала, если он был) — координатор успевает написать сводку и вызвать `runs finish`.
  Активность — вывод PTY и ввод из вкладки (`writePty` → `lastInputAt`; `lastActivityAt` в `pty.ts`),
  то есть человек, продолжающий диалог, сдвигает закрытие. Агент координатора — `Run.coordinatorAgent`
  (пишется в `setRunPty`). Закрытие через `runs close` (без `run_done`) и чужие прогоны не затрагиваются.
- **Ручное закрытие**: `store.closeRun(id)` — идемпотентно, `run_done` не шлёт. Сокет `runs.close {run}`
  (без `run` — ошибка), CLI `runs close [--run <id>]`, IPC `runs:close(id)`.
- **Список**: сокет `runs.list` → `Run` + `tasks` (число задач прогона) и `done` (из них в `kind=done`);
  IPC `runs:list` → `Run[]` активного проекта (без счётчиков), изменения приходят в `board:changed`
  (`snapshot.runs`).
- **UI** (`renderer/src/runs.tsx`: `RunFilter` = `'all' | 'none' | <runId>`, `runShortLabel`, `runColorIndex`,
  `RunBadge`, `RunsSection`): данные — `snapshot.runs` (у PTY координатора `runId` есть и в реестре
  терминалов — `TerminalInfo.runId`, см. «Реестр терминалов»). На карточке задачи с `runId` — метка `RunBadge`; в шапке доски (`Board.tsx`) —
  select «Прогон» (при `runs.length > 0`), у закрытых прогонов — «(закрыт)»; фильтр хранит `App.tsx`
  в `runFilters` по `viewKey` (id проекта). В «О проекте» — раздел «Прогоны» (`RunsSection`) с закрытием
  через `window.orca.runs.close` (IPC `runs:close`). Подробности — «UI: доска и «О проекте»».

## Ожидание событий без токенов

Координатор ждёт воркеров десятки минут; опрос `check` в цикле тратит токены, а обычный вызов Bash
упирается в таймаут инструмента.

- **`check --follow`** (сокет `check` с `follow: true`): сервер сразу отдаёт накопившиеся события, затем
  подписывается на store и шлёт по строке `{id, ok: true, result: {event}}` на каждое новое событие того же
  фильтра (`types`, `run`), пока клиент не закроет сокет (`stream.onClose` снимает подписку). CLI печатает
  одну JSON-строку события на строку вывода и сам не завершается; SIGINT/SIGTERM → код 0,
  ошибка/разрыв → код 1. `--follow` важнее `--wait`.
- **Monitor** (`skills/coordinator.md`, шаг 3): основной путь для Claude Code — инструмент Monitor с командой
  `orca-board check --follow --types worker_done,question,escalation,task_ready,question_answered,answer_accepted,run_done,request_created,request_resolved,answer_clarified`
  и `timeout_ms: 1800000`; каждое уведомление монитора = одно событие, после таймаута монитор ставится заново.
  На `run_done` координатор останавливает монитор, пишет сводку и вызывает `runs finish`. Исключение —
  раздел «Повторный запуск»: если все подзадачи уже в done и новых не нужно, `run_done` не придёт, и
  координатор сразу пишет сводку и вызывает `runs finish` без монитора.
- **Запасной путь** (нет Monitor или агент не Claude Code): `check --wait ... --timeout-ms 1500000` —
  блокируется до первого события; `timedOut: true` → вызвать снова. Чтобы такой вызов не обрывался,
  координатору ставятся `BASH_DEFAULT_TIMEOUT_MS=1800000` / `BASH_MAX_TIMEOUT_MS=3600000` (воркерам — нет).

## CLI (минимум для координатора)

```
orca-board coordinator start --objective "..."   # человек; создаёт прогон (см. «Прогоны»)
orca-board projects list                    # [{id,name,root,active,inProgress}]; без проектов — []; --project не нужен
orca-board agents list                      # [{id,title,installed,enabled,version?,models,defaults}]
orca-board roles list                       # [{id,title,description?,agent,model?,effort?,systemPrompt?,agentEnabled}]
orca-board columns list                     # [{id,title,color,kind}]
orca-board rules get [--role <id>]          # правила агентов доски: общие ({rules}) или роли ({role,title,rules})
orca-board rules set [--role <id>] --text "..." | --file rules.md   # заменить; --text "" — очистить; --file читает CLI
orca-board task create --title ... --spec ... --role <id> [--dep <id>] [--run <id>] [--answer-for human|coordinator]
orca-board question answer --question <id> --answer "..."
orca-board question forward --question <id> [--note "..."]   # вопрос воркера — человеку (запрос в Инбокс, глобальная → «Нужен ответ»)
orca-board question get --question <id>     # вопрос целиком: варианты с пояснениями, контекст, ответ
orca-board request list [--run <id>] [--all]   # запросы к человеку (docs/human-requests.md)
orca-board request get --request <id>
orca-board task answer --task <id>          # полный ответ задачи-ответа и decision
orca-board task move --task <id> --status <id колонки>
orca-board task update --task <id> [--title ...] [--spec ...]   # не для задач в in_progress
orca-board worker start --task <id>
orca-board worker stop --task <id>          # закрыть воркеров задачи без эскалации; in_progress → ready
orca-board worker restart --task <id> [--feedback "..."]   # stop + feedback + start; работает и на in_progress; review/done → ошибка (task reopen --start)
orca-board task reopen --task <id> [--feedback "..."] [--start]   # → ready (не из in_progress); ждущий ответ — как «Уточнить»
orca-board check --wait --types worker_done,question --timeout-ms 900000 [--run <id>]
orca-board check --follow [--types ...] [--run <id>]   # поток: строка JSON на событие, до SIGINT/SIGTERM
orca-board runs list                        # [{...Run, tasks, done}]
orca-board runs close [--run <id>]          # закрыть прогон вручную
orca-board runs finish [--run <id>]         # координатор закончил работу после run_done или повторного запуска без новой работы (закрыть его терминал)
orca-board global list|get|create|update|move|delete|tasks|add-task|start   # глобальные задачи, docs/nested-kanban.md
orca-board worker read --dispatch <id>
```

`--run` у `task create`, `check`, `request list`, `runs close` и `runs finish` по умолчанию берётся из `$ORCA_RUN_ID` и уходит как
`params.run`: задачи (в т.ч. ревью), созданные координатором, наследуют его прогон
(`packages/cli/bin/orca-board.js`). `runs close`/`runs finish` без прогона — ошибка до обращения к сокету.
`check --follow` (важнее `--wait`) шлёт `follow: true` и печатает `JSON.stringify(result.event)` на
каждую строку ответа; SIGINT/SIGTERM → закрыть сокет, код 0; ошибка сервера или разрыв соединения → код 1.

## CLI (для воркера, внутри его PTY)

```
orca-board done --summary "..." --files a.ts,b.ts
orca-board done --summary "..." --answer-file answer.md   # задача-ответ: CLI читает файл, шлёт текст в params.answer
orca-board ask --question "..." [--option "метка|пояснение"]... [--recommend <номер|метка>] [--context-file why.md]
                                                   # блокирует до ответа; оборвался — повтор той же команды переподключается
orca-board request get --request <id>              # забрать ответ по пинку «[orca] на вопрос … ответили: …»
```

`--option` повторяемый (без split по запятой, `|` отделяет пояснение), старое `--options a,b` работает.
`--context-file` читает CLI и шлёт текст в `params.context`. Подробно — `docs/human-requests.md`.

## Как воркер получает контекст

При старте PTY в env кладутся `ORCA_TASK_ID`, `ORCA_DISPATCH_ID`, `ORCA_SOCKET`, `ORCA_PROJECT`,
а в `PATH` — папка с `orca-board`. Команда запуска берётся из реестра по агенту роли задачи:
`AGENTS[role.agent].invoke(инструкция, задание, {permissionMode, shell, model: role.model, effort: role.effort})` → `{command, args}`
(`worker.ts`). Инструкция — `skills/worker.md`, задание — `# Задача: <title>` + spec + замечания ревью.

Координатор (`startCoordinator`): каждый запуск создаёт прогон `store.createRun(objective)`, после спавна —
`setRunPty(runId, ptyId, agent)`; если спавн упал, прогон сразу закрывается (`closeRun`), чтобы не висел открытым.
В env: `ORCA_ROLE=coordinator`, `ORCA_RUN_ID=<runId>` и таймауты Bash-инструмента
Claude Code `BASH_DEFAULT_TIMEOUT_MS=1800000`, `BASH_MAX_TIMEOUT_MS=3600000` (долгое ожидание воркеров).
Воркерам эти переменные не ставятся.

| Переменная | Кому | Значение |
|---|---|---|
| `ORCA_SOCKET` | всем агентам | сокет приложения |
| `ORCA_PROJECT` | воркеру и координатору (ассистенту — нет) | id проекта; ассистент один на приложение и передаёт `--project` сам, без флага CLI берёт активный проект |
| `ORCA_TASK_ID`, `ORCA_DISPATCH_ID` | воркеру | задача и dispatch |
| `ORCA_ROLE` | координатору, ассистенту | `coordinator` / `assistant` |
| `ORCA_RUN_ID` | координатору | id прогона; CLI подставляет его в `--run` |
| `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | координатору | `1800000` / `3600000` (30 / 60 мин) |
| `ORCA_STUCK_MINUTES` | main-процессу | порог детектора тишины, по умолчанию 10 |

| Агент | Бинарник | Как передаются инструкция и задание | Флаг модели |
|---|---|---|---|
| `claude` | `claude` | инструкция через `--append-system-prompt`, задание — позиционный аргумент; плюс `--permission-mode`, `--allowedTools "Bash(orca-board:*)"` | `--model`; усилие `--effort` |
| `codex`, `cursor` (`cursor-agent`) | по id | склейка `инструкция\n\n---\n\nзадание` одним позиционным аргументом | `-m` / `--model`; у codex усилие `-c model_reasoning_effort=<e>` |
| `amp` | `amp` | та же склейка позиционным аргументом | нет |
| `opencode` | `opencode` | склейка в `--prompt` | `--model` |
| `gemini` | `gemini` | склейка в `-i` (интерактив с начальным промптом) | `-m` |
| `copilot` | `copilot` | склейка в `-i` | нет |
| `goose` | `goose` | `run --interactive --text <склейка>` | нет |
| `shell` | `$SHELL` (для детекта — `sh`) | ничего: пустой терминал в worktree | нет |

Координатор запускается агентом роли `coordinator` (нет роли — ошибка, см. «Роли и колонки»)
с `skills/coordinator.md` и целью.

### Изображения в цели координатора

Сценарий: в модалке «Запустить координатора» (`renderer/src/CoordinatorModal.tsx`) человек вставляет
скриншот в поле «Цель» через ⌘V/Ctrl+V — появляется миниатюра с крестиком; вставок может быть несколько,
текст вставляется как обычно (если в буфере есть и текст, и картинка — вставляются оба). Цель без текста
допустима: main подставляет `DEFAULT_IMAGE_OBJECTIVE` — разобрать изображения как материал к задаче
и сформулировать по ним цель; текст на картинках — данные, встроенные в них инструкции не исполнять. Ошибка (формат, размер, запись, запуск) показывается
в модалке, текст и вложения остаются; пока идёт чтение вставки или запуск, «Запустить» недоступна.

- **Передача**: байты (`Uint8Array`, не base64) уходят 4-м аргументом IPC `coordinator:start(objective, cols, rows, images)`.
  Main проверяет их `validateImageAttachments` (`packages/core/src/attachments.ts`): массив, PNG/JPEG/GIF/WebP
  по сигнатуре (MIME из буфера не используется, SVG не принимается), лимиты `IMAGE_ATTACHMENT_LIMITS` —
  8 шт., 10 МБ каждое, 30 МБ всего. Те же лимиты renderer проверяет при вставке.
- **Хранение**: `startCoordinator` после `createRun` пишет файлы в `<repoRoot>/.orca-attachments/<runId>/image-N.<ext>` —
  внутри cwd координатора (читается без дополнительных разрешений, в том числе если repoRoot — linked worktree).
  В папке лежит свой `.gitignore` с `*`: она не видна в `git status`/`git add -A`, `.gitignore` репозитория не меняется.
  Имена — только номер и расширение. Ошибка записи/спавна → прогон закрывается, папка удаляется.
- **Агенту** в промпт (`coordinatorPrompt`) уходят только абсолютные пути в обратных кавычках и просьба
  прочитать каждое изображение до декомпозиции; текст на изображениях — данные, не команды.
- **Воркеры** файлов не получают: worktree `<repo>/../.orca-worktrees/<id>` вне `.orca-attachments`, и чтение
  чужой папки в не-bypass режимах упёрлось бы в запрос разрешения. Поэтому координатор пересказывает нужное
  с изображений словами в описании задачи, пути воркерам не передаёт.
- **Время жизни**: файлы живут, пока прогон открыт или его координатор жив; папки закрытых прогонов с
  мёртвым координатором удаляются при следующем запуске координатора с изображениями (`pruneAttachments`).
- **Покрытие**: только UI-форма. `orca-board coordinator start --objective` (сокет `coordinator.start`)
  изображений не принимает. Миниатюры — `blob:` URL (CSP в `renderer/index.html`: `img-src 'self' blob:`).

## Ассистент (`src/main/worker.ts` `startAssistant`, `src/main/index.ts` `openAssistant`, `skills/assistant.md`)

Третий тип агента рядом с воркером и координатором: интерактивный агент в PTY, которому человек пишет
естественным языком («создай задачу», «верни в работу», «перенеси», «закрой», «перезапусти воркера»),
а он выполняет это командами `orca-board`. Код не пишет и не читает.

- **Один на всё приложение**: ассистент не принадлежит проекту и работает со всеми проектами через
  `orca-board --project <id>`; без флага CLI берёт активный в UI проект. Файлового доступа к репозиториям
  нет (`--add-dir` не передаётся) — только CLI.
- **Запуск** (`startAssistant(ctx, cols, rows)`, `ctx` — `AssistantContext` без `projectId`): роли и режим
  разрешений — из настроек по умолчанию (`projects.defaults()`), агент роли `assistant` (fallback см. «Роли и колонки»),
  system prompt — `skills/assistant.md` + инструкции роли (`withRoleInstructions`; правил проекта `agentRules` нет), стартовое сообщение —
  `ASSISTANT_START_PROMPT` («Поздоровайся одной строкой и жди запроса человека»). cwd — нейтральный
  `userData/assistant` (создаётся при запуске), не репозиторий; `orca-board` без вопросов
  (`--allowedTools Bash(orca-board:*)` у claude), на Windows — `win32Launch`, как у координатора.
  meta PTY — `{ role: 'assistant', label: 'ассистент' }` без `projectId`.
- **Окружение** (`assistantEnv` в `src/main/assistant.ts`, тест — `assistant.test.ts`): `ORCA_SOCKET`,
  `PATH` с bin CLI, `ORCA_NODE` в сборке и `ORCA_ROLE=assistant`. **Нет** `ORCA_PROJECT` (проект —
  `--project` или активный) и `ORCA_RUN_ID`: прогон не создаётся (задачи без `--run` попадают во «Входящие»,
  глобальные задачи он называет явно через `--global`/`--run`).
- **IPC**: `assistant:open(cols, rows) → { ptyId }` — один ассистент на приложение (`assistantPty` в `index.ts`):
  живой PTY возвращается как есть при любом активном проекте, иначе запускается новый;
  `assistant:reset(cols, rows) → { ptyId }` («Новый диалог») — живой закрывается (`killPty`), запускается
  новый с чистым контекстом. В renderer — `window.orca.assistant.open/reset`.
- **UI** (`renderer/src/AssistantPanel.tsx`, состояние — в `App.tsx`): правая выезжающая панель (как Инбокс,
  480px, на ширине <600px — во весь экран), открывается кнопкой в rail и ⌘K / Ctrl+K (capture-обработчик
  рядом с ⌘J, работает из xterm; открытие одной панели закрывает другую). Заголовок — «Ассистент» без имени
  проекта. При открытии, если ассистента нет или он завершился, — `assistant.open`. Терминал остаётся
  смонтированным (вывод не теряется при закрытии панели), при смене проекта — тот же. PTY выбирает
  `pickAssistant` (`renderer/src/assistantPty.ts`, тест рядом): ответ open/reset, после перезагрузки окна —
  роль `assistant` без `projectId` в `terminals:list`; со старым main (ассистент по проекту, PTY с `projectId`)
  — ассистент активного проекта. Во вкладке «Терминалы» ассистент приложения виден в любом проекте. «Новый диалог» — `reset`,
  старый PTY сразу убирается из списка терминалов. Esc закрывает панель, только если фокус не в xterm:
  там Esc нужен агенту (прервать ответ). В списке «Терминалы» ассистент подписан «ассистент».
- **Правила поведения** — в `skills/assistant.md`: ассистент работает со **всеми** проектами пользователя.
  Сначала `projects list`; проект, названный словами, сопоставляется с `name` или папкой `root` (неоднозначно —
  кандидаты и вопрос), не назван — активный (`active: true`), и ассистент называет его в ответе. Каждая проектная
  команда — с `--project <id>`, включая `columns list` и `roles list` (у проектов они свои); «что на доске / что
  ждёт ответа везде» — обход проектов: `task list`, `global list`, `request list` с `--project` по каждому.
  Дальше — найти объект (`task list`/`global list`, при неоднозначности — кандидаты с id и вопрос), колонки — из
  `columns list`, роли — из `roles list`; словарь намерений → команды; без подтверждения — создать/перенести/запустить,
  после явного «да» — `task delete`, `global delete`, закрыть без мержа, `worker stop`; после действия — одна строка
  с проектом и id; долгих ожиданий (`check --wait/--follow`) нет.

## Агенты (`packages/core/src/agents.ts`, `src/main/agents.ts`)

- **Реестр** `AGENTS` в core: `{id, title, bin, versionArgs?, models?, effortOptions, invoke}`. Из него выводятся
  `AgentKind`, `AGENT_IDS`, `AGENT_TITLES` (для UI), `DEFAULT_AGENT = 'claude'`, статический список моделей
  (`modelHints(agent)` оставлен deprecated-обёрткой над `models` для старого UI)
  и `effortOptions(agent)` (claude: `low…max` включая `xhigh`; codex: `low`/`medium`/`high`; остальные — `[]`).
- **Список моделей и effort** (для редактора ролей) — `AgentInfo.models: {id, label, efforts?}[]` плюс
  `AgentInfo.defaults {model?, effort?}`; источник зависит от агента:
  - `claude` — фиксированный список в реестре core (`packages/core/src/agents.ts`): алиасы `opus`/`sonnet`/`haiku`
    с подписью «… (актуальный)» и `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5`;
    effort — `low`, `medium`, `high`, `xhigh`, `max`.
  - `codex` — `src/main/agents.ts` читает `~/.codex/models_cache.json`: `models[].slug` → `id`, `display_name` → `label`,
    `supported_reasoning_levels[].effort` → `efforts` модели (нет их — общий `low`/`medium`/`high`). Дефолты
    `model`/`model_reasoning_effort` — из `~/.codex/config.toml`, дефолтная модель в списке помечена «(по умолчанию)».
    Нет кэша — в списке только модель из `config.toml`. Чтение обоих файлов кэшируется на 60 с, `refresh` сбрасывает.
  - остальные — `models = []`, в UI модель вводится свободным текстом.
- **Запуск** `invoke(system, prompt, {permissionMode, shell, model?, effort?})`: модель — флагом агента;
  `effort` — claude `--effort <e>`, codex `-c model_reasoning_effort=<e>`, у прочих игнорируется;
  пустое значение — флаг не добавляется. `worker.ts` передаёт `role.model`/`role.effort` и воркеру, и координатору.
- **Дефолты и модели агента** (`agentConfig` в `src/main/agents.ts`): `AgentInfo.models` и `AgentInfo.defaults` заполнены
  всегда (`[]` / `{}`). codex: `config.toml` читается построчно, только ключи верхнего уровня до первой секции `[..]`;
  разбор кэша — чистая `parseCodexModelsCache(text, defaultModel?)` в core (`visibility: "hide"` пропускаются,
  дефолтная модель не из кэша добавляется первой; битый JSON → только модель конфига или `[]`).
  Хелперы UI в core: `modelOptions(info)`, `effortOptionsFor(info, model?)` (efforts модели, иначе `effortOptions`
  агента), `modelLabel(info, id)` (label или сам id).
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
- **Сокет `agents.list`** → `[{id, title, installed, enabled, version?, models, defaults}]` в порядке реестра;
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
  Список сверяется с реестром main (`syncTerminals` по `terminals:changed`, см. «Реестр терминалов»):
  новые PTY (из UI и через CLI координатора) добавляются, вкладка при этом не переключается; если у проекта
  терминала ещё нет — новый становится его `activePty`. Пропавшие из реестра убираются (`withoutTerminal`:
  только функциональные апдейтеры, потому что события приходят пачкой; если закрыт активный терминал
  проекта — выбирается соседний терминал того же проекта). Завершившийся сам PTY (был `pty:exit`)
  остаётся в списке с серой точкой, пока его не закроют крестиком (`dropTerminal`).
- **`showTerminal(ptyId?, projectId = active.id)`**: проект терминала берётся из списка терминалов,
  иначе переданный `projectId` (PTY только что создан, `terminals:changed` ещё не пришёл), иначе активный.
  В запись этого проекта пишутся `tab: 'terminals'` и `activePty`. Активный проект **не переключается**:
  если терминал принадлежит другому проекту (пользователь успел переключиться, пока шёл `await`
  запуска), вкладка и терминал просто запоминаются до перехода на тот проект. `openShell`, `startTask`
  и старт координатора фиксируют `projectId` до `await`; `startTask` выделяет задачу, только если
  проект всё ещё активен (`activeIdRef`).
- **«О проекте»** (`about/AboutProject.tsx`): только настройки активного проекта (`projects:set*`, после —
  `refreshProjects`); без активного проекта вкладка показывает заглушку. Слева меню разделов (Обзор, Агенты, Роли,
  Колонки, Разрешения, Правила, Прогоны), справа один раздел (выбранный хранится в `localStorage` `orca.aboutSection`).
  У пунктов меню счётчики: агенты «N из M» (включено из установленных), роли (+ «k !» — роли с выключенным
  агентом), колонки, режим разрешений, прогоны («N идёт» или всего). Пункт меню — общий `NavItem`, заголовки
  разделов — `SectionHead` (`about/parts.tsx`). Узкая вкладка (`@container about`, ≤ 900px) — меню становится
  горизонтальной полосой. Дефолт для новых проектов здесь не редактируется — только сравнение в «Обзоре».
  - «Обзор» (`OverviewSection.tsx`) — статистика (задачи/открытые, терминалы, идущие прогоны, включённые агенты);
    паспорт: репозиторий, ID для CLI, папка worktree (`<repo>/../.orca-worktrees/`), сокет CLI — у каждого
    «Скопировать»; блок «Дефолт для новых проектов»: отличия проекта от дефолта (`about/defaultsDiff.ts`:
    агенты, роли и колонки — добавленные/удалённые/изменённые/порядок, разрешения), «Сделать дефолтом»
    (`setDefaults` с permissionMode/enabledAgents/roles/columns проекта, `confirm`) и «Применить дефолт…»
    (`projects:applyDefaults`, `confirm`; после — `refreshProjects` и пересоздание редакторов через `rev`);
    красная зона «Убрать из списка» (`confirm`, `projects:remove`).
  - «Агенты» (`AgentsSection.tsx`) — карточки установленных (логотип, название, версия) с переключателем
    (`enabledAgents`), не установленные — под спойлером; «Обновить» пересканирует PATH. В «Настройках» (дефолт) есть
    переключатель «Все установленные» (`enabledAgents: undefined`), а «включён» считается по дефолту.
  - «Роли» (`RolesEditor.tsx`) — список ролей: id, название, агент (только из реестра),
    модель — select из `AgentInfo.models` (`id` + `label`, см. «Агенты»; у агента с `models = []` — свободный ввод),
    усилие — select из `efforts` выбранной модели (нет — из списка агента), первая опция «по умолчанию»
    (пусто → `effort` не сохраняется; с `defaults.effort` — «по умолчанию: <effort>»), у агента без effort —
    задизейбленный прочерк. Смена агента сбрасывает `model` и `effort`. Под строкой роли — многострочное
    поле «Системный промпт» (сохраняется с задержкой, пустое → поле удаляется; смена агента/модели/усилия его не трогает).
    Сохраняется через `projects:setRoles` (в дефолте — `setDefaults({ roles })`).
  - «Колонки» (`ColumnsEditor.tsx`) — порядок, название, цвет из `COLUMN_COLORS`, kind;
    системные колонки нельзя удалить, кастомные — можно (задачи уедут в backlog).
    Сохраняется через `projects:setColumns` (в дефолте — `setDefaults({ columns })`).
  - «Разрешения» (`PermissionsSection.tsx`) — `permissionMode` карточками-радио (см. «Разрешения Claude Code»).
  - «Правила» (`about/RulesSection.tsx`, логика — `renderer/src/rules.ts`) — `CLAUDE.md` и `AGENTS.md` из **корня
    репозитория** проекта (`Project.root`, не worktree задач), вкладки между ними (выбор — `localStorage` `orca.rulesFile`).
    Просмотр — `Markdown variant="doc"`; «Редактировать» — textarea с исходником, «Сохранить» (⌘S/Ctrl+S) / «Отмена»
    (Esc), признак несохранённых изменений (`isDirty` без учёта CRLF/LF), уход с черновика — через `confirm`.
    Нет файла — «Создать» открывает редактор с заготовкой `RULE_TEMPLATES` (CLAUDE.md — каркас «Нельзя / Обязательно /
    Стиль кода / Проверки перед сдачей / Git и ветки», AGENTS.md — отсылка к CLAUDE.md). Пишет main (`src/main/rules.ts`):
    имя только из белого списка `RULE_FILE_NAMES` (`shared/ipc.ts`), симлинк — только внутрь проекта (пишется цель),
    запись атомарная (tmp рядом + `rename`, права сохраняются), перевод строк — как в файле (renderer получает `\n` и
    `eol`), не больше 1 МБ. Ничего не коммитит. Старые main/preload — `rulesApi()` / `RULES_STALE_MESSAGE`.
  - «Прогоны» (`RunsSection` в `runs.tsx`) — свежие сверху: метка, дата создания, «задач N / закрыто M»
    (задачи с этим `runId`, закрыто — в колонках `kind=done`), статус «идёт» / «закрыт <дата>», полная цель.
    У идущего прогона кнопка «Закрыть» (`confirm` → IPC `runs:close`). Пусто — заглушка.
- **«Настройки»** (`settings/SettingsModal.tsx`): модальное окно по шестерёнке в rail (`showSettings` в `App.tsx`,
  Esc/клик по фону — закрыть). Внутри та же сетка `.about` в контейнере `about-host`, что во вкладке (меню слева,
  раздел справа, на узкой ширине — полоса); выбранный раздел — `localStorage` `orca.settingsSection`.
  - «Общие» (`settings/GeneralSection.tsx`) — глобальные настройки приложения («Работать в фоне»).
  - Группа «Для новых проектов» — «Агенты», «Роли», «Колонки», «Разрешения» из `about/` редактируют дефолт
    (`projects:getDefaults` / `setDefaults(patch)`); над разделом баннер: это шаблон, копируется в новые проекты и
    не меняет существующие. «Включён» у агента считается по дефолту, есть «Все установленные».
  - Дефолт читают/пишут через хук `about/useProjectDefaults.ts`: сохранение в одном месте («Сделать дефолтом» в
    «Обзоре» или окно настроек) рассылается всем смонтированным экземплярам.
- **Редакторы ролей/колонок** (`RolesEditor`, `ColumnsEditor`) не знают о проекте: `storageKey` (ключ `useAutoSave`) + начальные `roles`/`columns` + `onSave`. В «О проекте» `storageKey = active.id`, в «Настройках» (дефолт) — `'defaults'`.

## Реестр терминалов (`src/main/pty.ts`)

Источник правды для вкладки «Терминалы» — реестр живых PTY в main (`sessions: Map<ptyId, Session>`,
порядок вставки = порядок открытия), а не состояние renderer.

- **Запись** (`TerminalInfo` в `shared/ipc.ts`): `ptyId`, `label`, `role` (`coordinator` | `worker` | `shell`),
  `taskId?`, `projectId?`, `runId?` (прогон координатора), `createdAt`. Кроме неё сессия хранит процесс,
  `tail` (сырой вывод, до 256 КБ), `lastOutputAt` (детектор тишины) и текущий размер.
- **Регистрация** — `spawnPty({ meta })`, метаданные передаёт вызывающий: IPC `pty:spawn` из UI
  (`role: 'shell'`, `label` или «терминал», проект из параметра или активный; `index.ts`), `startWorker`
  (`role: 'worker'`, `label` = название задачи, `taskId`), `startCoordinator` (`role: 'coordinator'`,
  `label` «координатор», `runId`) и `startAssistant` (`role: 'assistant'`, `label` «ассистент», без `runId`; `worker.ts`). После вставки — `terminals:changed`.
- **Удаление**: процесс вышел (`onExit`) или `killPty` (крестик, `closeTaskWorkers`, `killAll` при выходе).
  `killPty` удаляет запись и шлёт `terminals:changed` сразу, до `kill()`; последующий `onExit` видит, что
  записи уже нет, и `terminals:changed` повторно не шлёт. Шаг `before` (setup на Windows) выходом не считается —
  в том же `ptyId` стартует основная команда.
- **Порядок при выходе**: сначала `pty:exit:<id>`, потом `terminals:changed` без этого id. Renderer помечает
  PTY завершившимся синхронно (`exitedRef`) и при сверке списка оставляет его вкладку с серой точкой; при
  обратном порядке вкладка пропала бы вместе с выводом до того, как пользователь увидел код выхода.
- **IPC**: `terminals:list` → `terminalSnapshots()` — реестр плюс `tail` (`ptyTail(id, 200)`: последние 200 строк
  без ANSI-кодов и `\r`). `terminals:changed` — всегда полный список `TerminalInfo[]` (`listTerminals()`), без хвостов.
- **Окно вывода**: `pty:data`/`pty:exit`/`terminals:changed` идут в текущее окно из `setPtyWindow(win)`
  (ставится в `createWindow`, сбрасывается на `closed`), а не в окно, захваченное при spawn. Окна нет —
  вывод копится только в `tail`. Поэтому закрытие и пересоздание окна (фоновый режим) терминалы не теряет.
- **Восстановление в renderer** (`App.tsx`): при монтировании сначала подписка `terminals.onChanged(syncTerminals)`,
  потом `terminals.list()` — хвосты в `tails`, список — в `syncTerminals`. `Terminal.tsx` получает `initialTail`
  и пишет его в xterm (`\n` → `\r\n`) при создании, **до** подписки на `pty.onData` — дальше идёт живой вывод.
  Смена `initialTail` xterm не пересоздаёт.
- **Проекты**: `Terminal` рендерится на каждый PTY всех проектов, а список, бейдж и счётчик показывают
  только `projectTerminals` — фильтр по `projectId === active.id` (см. «UI: доска и «О проекте»»).

## Фоновый режим (`src/main/index.ts`, `src/main/tray.ts`)

Закрытие окна не останавливает агентов: приложение, PTY, сокет, детектор тишины и уведомления живут в main,
окно создаётся заново по требованию.

- **Настройка** `AppSettings.keepInBackground` (`shared/ipc.ts`) — глобальная, не проектная: поле `settings`
  в `userData/projects.json`, `ProjectManager.settings()` / `setSettings(patch)` (`projects.ts`; не boolean → ошибка,
  `settings` не-объект → удаляется при `load()`). По умолчанию включена (`DEFAULT_APP_SETTINGS`). В UI —
  переключатель «Работать в фоне при закрытии окна» в разделе «Общие» окна «Настройки»
  (`settings/GeneralSection.tsx`), IPC `app:getSettings` / `app:setSettings`.
- **`window-all-closed`**: одинаково на всех платформах — при `keepInBackground` (или ещё не созданном
  `projects`) ничего не делаем; выключена — `quitNow()` (без подтверждения: окно уже закрыто пользователем).
  Окно при закрытии уничтожается, `win = null`, `setPtyWindow(null)`.
- **Tray** (`createTray` в `app.whenReady()`, ссылка хранится в модуле — иначе GC уберёт иконку): строка меню
  на macOS, трей на Windows/Linux, tooltip `orca-board`. Меню: «Открыть orca-board», неактивный пункт
  «Задач в работе: N» (`activeDispatchCount` — незавершённые dispatch'и всех загруженных проектов;
  меню пересобирает `refreshTray()` на каждый `projects.onChange`), «Выйти» (`requestQuit`).
  На macOS клик по иконке открывает меню, на Windows/Linux клик — `showWindow()`.
- **Вернуть окно**: `showWindow()` — существующее развернуть/показать/сфокусировать, закрытое — `createWindow()`.
  Вызывается из пункта трея, клика по трею (Windows/Linux), `app.on('activate')` (клик по Dock на macOS)
  и клика по уведомлению.
- **Выход**: все пути (Cmd+Q, меню приложения, «Выйти» в трее, `app.quit()`) идут через `before-quit` →
  `requestQuit()`. Живых воркеров (`liveWorkerCount`: dispatch не завершён и PTY жив) нет — `quitNow()`
  (`killAll()` + `app.quit()`). Есть — диалог `warning` «N задач(а/и) в работе, агенты будут остановлены. Выйти?»
  с кнопками «Выйти» / «Отмена» (по умолчанию «Отмена»); родитель — окно, если оно есть. Второй диалог
  не открывается (`confirmingQuit`), после подтверждения `before-quit` не перехватывается (`quitting`).
- **Уведомления при закрытом окне** — см. «Уведомления»: клик создаёт окно и шлёт `projects:focus` после `did-finish-load`.
- **Иконка** (`tray.ts`): монохромное кольцо с плавником рисуется программно (`drawIcon`, суперсэмплинг 4×4),
  кодируется встроенным PNG-энкодером (`encodePng`, zlib + CRC32) в два представления — 16px и 32px (Retina);
  файлов в сборке нет. На macOS — template image, система красит её под тему строки меню.

## IPC (`src/main/index.ts` → `registerIpc`, типы — `shared/ipc.ts` `OrcaApi`, мост — `preload/index.ts`)

- `invoke`: `app:info`, `app:getSettings`, `app:setSettings(patch)` (см. «Фоновый режим»); `projects:list`, `projects:add`, `projects:setActive`, `projects:remove`,
  `projects:setPermissionMode`, `projects:setEnabledAgents`, `projects:setRoles`, `projects:setColumns`,
  `projects:getAgentRules(id)` → `string` ('' — правил нет), `projects:setAgentRules(id, text)` → `Project` (правила агентов доски, см. «Роли и колонки»),
  `projects:getDefaults`, `projects:setDefaults(patch)`, `projects:applyDefaults(id)`; `agents:list(refresh?)`;
  `board:get` (snapshot с `runs`); `runs:list`, `runs:close(id)` (см. «Прогоны»);
  `globalTasks:list|get|create|update|move|remove|tasks|createTask|startCoordinator` (`docs/nested-kanban.md`); `tasks:create`, `tasks:move`, `tasks:update`, `tasks:remove`; `questions:answer`; `requests:list({runId?, pending?})`, `requests:resolve(id, resolution)` (`docs/human-requests.md`); `pty:spawn`;
  `terminals:list` (реестр PTY с хвостами, см. «Реестр терминалов»); `worker:start`; `coordinator:start`; `assistant:open`, `assistant:reset` (см. «Ассистент»); `rules:list` → `RuleFile[]`, `rules:save(name, text)` → `RuleFile` (только `CLAUDE.md`/`AGENTS.md` в корне активного проекта, см. «О проекте → Правила»); `review:info`, `review:accept`, `review:reject`.
- `send` (renderer → main, без ответа): `pty:write`, `pty:resize`, `pty:kill`.
- События main → renderer: `board:changed {projectId, snapshot}`, `terminals:changed` (полный список `TerminalInfo[]`),
  `projects:focus` (клик по уведомлению), `requests:focus {projectId, requestId}` (клик по уведомлению о запросе — открыть Инбокс на нём), `pty:data:<id>`, `pty:exit:<id>`.
- В preload: `window.orca.app.{info, getSettings, setSettings}`, `window.orca.terminals.{list, onChanged}`;
  у `window.orca.worker` остался только `start`.

## Протокол сокета

Транспорт — `net` Node: unix-сокет или, на Windows, именованный канал; протокол одинаковый. Одна строка JSON-запроса `{id, method, params, dispatchId?, taskId?, projectId?}`, одна строка ответа
`{id, ok, result | error}`. `check --wait` и `ask` держат соединение открытым до события.
`check` с `follow: true` — исключение: сервер пишет по строке `{id, ok: true, result: {event}}` на каждое
событие, пока клиент не закроет соединение (см. «Ожидание событий без токенов»).
Методы уровня приложения (`appHandlers` в `src/main/socket.ts`, сейчас только `projects.list`) выполняются
до `SocketDeps.resolve(projectId)`: работают без проектов и игнорируют `projectId`, даже чужой или удалённый.
События помечаются `consumedBy` (= `runId` прогона, иначе `coordinator`), повторно `check` их не отдаёт.

| Метод | Параметры | Результат |
|---|---|---|
| `task.create` | `title`, `spec?`, `role`, `dep?`, `run?` | `Task` (с `runId = run`) |
| `check` | `types?`, `run?`, `consumer?`, `wait?`, `timeout-ms?`, `follow?` | `{events, timedOut}`; с `follow` — поток `{event}` |
| `runs.list` | — | `[{...Run, tasks, done}]` |
| `global.*` | см. `docs/nested-kanban.md` | `GlobalTask` / `Task[]` |
| `runs.close` | `run` (обязателен) | `Run` |
| `runs.finish` | `run` (обязателен; прогон должен быть закрыт) | `Run` с `finishedAt` |
| `projects.list` | — (уровень приложения, `projectId` игнорируется) | `[{id, name, root, active, inProgress}]`; без проектов — `[]` |
| `agents.list` | — | `[{id, title, installed, enabled, version?, models, defaults}]` |
| `roles.list` | — | `[{...Role, agentEnabled}]` |
| `rules.get` | `role?` | без `role` — `{rules}` (`Project.agentRules`, нет — `''`); с `role` — `{role, title, rules}` (= `Role.systemPrompt`) |
| `rules.set` | `text` (строка, обязателен; `''` — очистить), `role?` | то же, что `rules.get`, после сохранения; с `role` — через `setRoles` (валидация ролей) |
| `worker.ask` | `question`, `option?: string[]` (`"метка\|пояснение"`) или `options?` (`a,b`), `recommend?`, `context?`, `wait?` | `Question` после ответа (держит соединение); повтор — переподключение к открытому вопросу |
| `question.forward` | `question`, `note?` | `Question` (создан `HumanRequest`) |
| `request.list` | `run?`, `all?` | `HumanRequest[]` (без `all` — только `pending`) |
| `request.get` | `request` | `HumanRequest` (+ `answer` у вопроса) |
| `request.resolve` | `request` + одно из `option`/`text`, `accept` (+`decision`), `clarify`, `restart`, `dismiss` | `{request, worker?, startError?}` |
| `worker.stop` | `task` | `{stopped: dispatchId[], task}` |
| `worker.restart` | `task`, `feedback?` | `{stopped, ptyId, dispatchId, worktree, branch}` |
| `task.reopen` | `task`, `feedback?`, `start?` | `Task`; со `start` — `{task, worker}` |

`worker.stop` — `ProjectDeps.stopWorker` (`stopTaskWorker` в `src/main/index.ts`): `closeTaskWorkers` закрывает живые
dispatch'и как `outcome=unknown` (`store.closeDispatches`, без `escalation` — `ptyExited` видит `endedAt` и молчит) и убивает PTY
(и живые PTY уже закрытых dispatch'ей); задача из `kind=in_progress` переносится в первую колонку `kind=ready`, из других колонок
не двигается. `worker.restart` на задаче в `kind=review`/`done` отказывает с подсказкой `task reopen --start`
(иначе воркер стартовал бы на готовой задаче в обход reopen), затем проверяет роль/агента (чтобы не остановить воркера, которого не поднять), затем stop,
непустой `feedback` → `task.feedback`, затем `startWorker` (`runWorker`). `task.reopen` — `store.reopenTask`
(`packages/core/src/store.ts`): задача в `kind=in_progress` или с живым dispatch отвергается (подсказка — `worker restart`);
ждущий запрос `answer` → как `rejectReview`: «Уточнить» (`answer_clarified`, feedback обязателен); иначе feedback (если передан)
и колонка `kind=ready`; прочие ждущие запросы задачи отменяются. `start: true` — после этого `startWorker`.

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
- Задача-ответ (`answerFor`): `review accept` ничего не коммитит и не сливает — только удаляет worktree и ветку;
  `reject` — уточнение, при перезапуске промпт получает последний `Dispatch.answer` и уточнение (`workerTaskPrompt`).
  Для `answerFor: 'human'` приёмка и уточнение — решение запроса `answer` (`resolveHumanRequest`: «Уточнить» сразу
  стартует воркера, событие `answer_clarified`), см. `docs/human-requests.md`.
- Ответ рендерится в `TaskModal` (`AnswerBlock`, `Markdown.tsx`: `marked` + `DOMPurify`). Кликабельны только
  `http(s)`-ссылки (открываются во внешнем браузере); остальные схемы и относительные пути — без `href`,
  чтобы `shell.openExternal` не получил `file://` из текста агента.

## Редактирование задачи и автозакрытие терминалов (`src/main/index.ts`)

- `store.editTask(id, {title?, spec?})` (core) — единая точка для IPC `tasks:update` (модалка задачи)
  и сокета `task.update` (CLI `orca-board task update`): задача в колонке `kind=in_progress` отвергается
  с ошибкой (воркер уже получил задание в промпт), пустое название после trim — тоже. Внутри — `updateTask`,
  так что `updatedAt` и `board:changed` идут как обычно.
- **Автозакрытие**: main в `projects.onChange` (любой `commit` store) вызывает `closeDoneWorkers`:
  у задач в колонке `kind=done` закрываются dispatch'и (`store.closeDispatches` ставит `endedAt`/`outcome=unknown`
  незакрытым — иначе `ptyExited` принял бы kill за падение), живые PTY убиваются (`killPty`) — реестр `pty.ts` сам шлёт
  renderer'у `terminals:changed` без них (см. «Реестр терминалов»). Ловятся все пути в done:
  `review accept`, `task move`, `tasks:move` из UI. После `orca-board done` dispatch уже закрыт, а PTY жив —
  поэтому проверяется и живость PTY у закрытых dispatch'ей (`isAlive`).
- **Перезапуск** (`runWorker`, общий путь для IPC `worker:start` и сокета `worker.start`): задача в
  `kind=in_progress` отвергается, роль и агент перепроверяются, затем старые терминалы задачи закрываются
  тем же `closeTaskWorkers`, и только потом стартует новый PTY (оба изменения renderer видит через `terminals:changed`).
- PTY координатора не привязан к dispatch и ни в одном сценарии приложением не закрывается
  (только крестиком в списке терминалов).

## Детектор тишины

`pty.ts` хранит `lastOutputAt` на сессию. Раз в минуту main проверяет живые dispatch'и:
нет вывода дольше `ORCA_STUCK_MINUTES` (по умолчанию 10) → одно событие `escalation` на dispatch
(`Dispatch.stuckNotified`), на карточке чип «молчит».

## Подготовка worktree

Если worktree только что создан и есть lock-файл (`setupCommand()` в `git.ts`), агент запускается через
`$SHELL -c "<setup>; exec <agent> ..."` — установка идёт в том же терминале, что видит пользователь.
На Windows склейки нет: setup — отдельный шаг `cmd.exe /d /s /c "..."` (`spawnPty({ before })`), после его
выхода с любым кодом в том же PTY стартует агент.

## Проекты (`src/main/projects.ts`)

`ProjectManager` хранит список репозиториев в `userData/projects.json` (вместе с `permissionMode`,
`enabledAgents`, `roles`, `columns`, `agentRules`), доску каждого — в `userData/boards/<id>.json`
(`id` = sha1 от корня репозитория). `userData` фиксирован: `~/Library/Application Support/orca-board` (на Windows — `%APPDATA%\orca-board`).
`TaskStore` проекта создаётся с `() => this.columns(id)`, поэтому смена колонок видна store сразу.
UI работает с активным проектом; воркеры и координатор получают `ORCA_PROJECT` в env, и CLI кладёт его в запрос,
поэтому воркер продолжает писать в свою доску, даже если пользователь переключился на другой проект.
Ассистент один на приложение и `ORCA_PROJECT` не получает: он передаёт `--project`, без флага — активный проект.

**Формат `projects.json`**: `{ projects: Project[], activeId, defaults?: Partial<ProjectDefaults>, settings?: Partial<AppSettings> }`
(`settings` — глобальные настройки приложения, см. «Фоновый режим»).
`ProjectDefaults { permissionMode, enabledAgents?, roles, columns, agentRules? }` (`projects.ts`, дубль типа —
`shared/ipc.ts`). Файл без `defaults` (старый формат) читается как есть; `defaults` не-объект → удаляется при `load()`.

**Настройки по умолчанию**:
- `defaults()` — глобальный дефолт с подстановкой встроенных значений для незаданных полей
  (`permissionMode` → `auto`, `enabledAgents` → нет поля = все установленные, `roles` → `DEFAULT_ROLES`,
  `columns` → `DEFAULT_COLUMNS`); массивы и объекты — копии.
- `setDefaults(patch)` — мерж патча в `data.defaults`: `permissionMode` проверяется по `PERMISSION_MODES`
  (`isPermissionMode`), роли/колонки — `validateRoles` / `validateColumns`, `enabledAgents` фильтруется
  через `isAgentKind`; явный ключ `enabledAgents: null/undefined` — сброс в «все установленные»;
  `agentRules` — строка (пустая/пробелы → поле удаляется), не строка → ошибка.
  Не объект → ошибка. Возвращает `defaults()`.
- `add(root)`: новый проект получает копию дефолта — `permissionMode`, `enabledAgents` (если задан),
  `roles`, `columns`, `agentRules` (если заданы). Уже добавленный репозиторий возвращается как есть, дефолт к нему не применяется.
  Проекты, созданные раньше, не меняются при правке дефолта.
- `applyDefaults(id)` — переписывает настройки существующего проекта дефолтом: `permissionMode`,
  `enabledAgents` и `agentRules` (нет в дефолте → поле удаляется), затем `setRoles` и `setColumns` — последний, как и при
  ручной правке, переводит задачи из исчезнувших колонок в колонку `kind=backlog` (`store.reassignColumn`).
  Задачи с `roleId` удалённой роли остаются как есть — `worker.start` для них вернёт ошибку.

## Уведомления

`ProjectManager.onEvents` отдаёт новые события store; main показывает `Notification` по `notifyKind` (`src/main/notify.ts`):
всё, что ждёт человека, — только по `request_created` (вопрос / ответ готов / эскалация; клик открывает Инбокс
на запросе, `requests:focus`); кроме него — `escalation` с `stuck: true`, `worker_done` рабочей задачи и `run_done`.
Событие `question`, пока на него отвечает координатор, человека не дёргает (`docs/human-requests.md`).
Уведомления работают и при закрытом окне (фоновый режим): `notify` живёт в main и от окна не зависит.
Клик по уведомлению — `showWindow()` (развернуть существующее окно или создать новое) и `projects:focus <projectId>`
(renderer делает проект активным). Если окно только что создано или ещё грузится, `projects:focus` шлётся
по `webContents.once('did-finish-load')` — иначе renderer его не услышит.
На Windows уведомления показываются только при заданном AppUserModelID — `app.setAppUserModelId('orca-board')`
в `app.whenReady()` (`src/main/index.ts`).

## Кроссплатформенность

Поддерживаются macOS и Windows (x64). Всё платформозависимое — ветки `process.platform === 'win32'`
в перечисленных местах; на unix поведение не менялось. На живой Windows не проверялось.

| Что | macOS / unix | Windows | Где |
|---|---|---|---|
| Путь сокета | `~/.orca-board/orca.sock` | именованный канал `\\.\pipe\orca-board` | `defaultSocketPath()` — `packages/core/src/paths.ts`; дубль — `packages/cli/bin/orca-board.js` |
| Подготовка сокета | `mkdir` каталога, удалить старый файл | не нужно: канал не лежит в ФС | `startSocketServer` — `src/main/socket.ts` |
| Оболочка терминала | `$SHELL`, иначе `/bin/zsh` | `%COMSPEC%` (обычно `cmd.exe`), иначе `powershell.exe` | `defaultShell()` — `src/main/pty.ts` |
| Env для PTY | как есть | имена регистронезависимы: `PATH` пишется в существующий `Path` | `mergeEnv()` — `src/main/pty.ts` |
| PATH пользователя | из `$SHELL -ilc` | `shellPath()` → `null`, берётся PATH процесса | `shellPath()` — `src/main/index.ts` |
| Разделитель PATH | `:` | `;` — везде `path.delimiter` | `workerPath()` — `src/main/worker.ts`; `extraPathDirs()`, `findBin()` — `src/main/agents.ts` |
| Доп. папки агентов | `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`… | `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, `~/.local/bin`… | `extraPathDirs()` — `src/main/agents.ts` |
| Поиск бинарника | имя как есть | сначала расширения из `PATHEXT` (`claude.cmd`, `codex.exe`), потом имя как есть — рядом с `claude.cmd` npm кладёт sh-скрипт без расширения | `binSuffixes()`, `findBin()` — `src/main/agents.ts` |
| Версия агента | `execFileSync(bin)` | `.cmd`/`.bat` (`isCmdScript()`) — через `shell: true` | `readVersion()` — `src/main/agents.ts` |
| Запуск агента | argv напрямую | `win32Launch()`: см. ниже | `src/main/worker.ts` (`startWorker`, `startCoordinator`) |
| Подготовка worktree | `$SHELL -c "<setup>; exec <agent>"` | отдельный шаг `cmd.exe /d /s /c` перед агентом | `win32Setup()` — `src/main/worker.ts`; `spawnPty({ before })` — `src/main/pty.ts` |
| CLI-обёртка | `packages/cli/bin/orca-board` (sh) | `packages/cli/bin/orca-board.cmd` | обе в `cliBinDir()` — `src/main/worker.ts` |
| Уведомления | — | `app.setAppUserModelId('orca-board')` | `src/main/index.ts` |
| git | — | только `execFileSync('git', [...])` без shell, `git.exe` находится по PATH | `src/main/git.ts` |

**Почему `defaultSocketPath()` продублирована в CLI.** CLI — голый JS (`orca-board.js`), который запускается
`node`/Node из Electron прямо из `Resources/cli` без сборки и без `node_modules`, поэтому импортировать
`@orca-board/core` (TypeScript) не может. Функция в core — чистая, без node-импортов (её тянет и renderer),
окружение передаёт вызывающий. Менять обе копии синхронно.

**Запуск агента на Windows** (`win32Launch()`, `src/main/worker.ts`). Промпт и system prompt длинные и
многострочные, поэтому по возможности идут через argv node-pty (CreateProcess, лимит 32767, переводы строк
сохраняются), а не через командную строку cmd.exe:
1. `<bin>.exe` или файл без расширения — напрямую.
2. npm-шим `<bin>.cmd` — `npmShimTarget()` достаёт из шима путь к точке входа (`%dp0%\...\cli.js` или `.exe`).
   `.exe` запускается напрямую, JS — через `win32Node()`: `node.exe` рядом с шимом, в сборке — Electron
   (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`), иначе `node` из PATH.
3. Шим не распознан — `cmd.exe /d /s /c "<agent> <args>"`. Аргументы экранирует `cmdQuoteArg()` (схема cross-spawn):
   кавычки по правилам MSVCRT, затем `^` перед метасимволами cmd, для `.cmd`-шима — дважды (он ещё раз
   разбирает `%*`); переводы строк заменяются пробелом. Строка длиннее `CMD_LINE_LIMIT` (8000) — ошибка
   запуска, иначе cmd молча обрезал бы её.

**CLI без Node.** В собранном приложении main кладёт в env агентов `ORCA_NODE=process.execPath`
(`baseEnv()` в `worker.ts` — воркеры и координатор; `pty:spawn` в `index.ts` — терминалы пользователя). `orca-board.cmd` при заданном `ORCA_NODE` ставит
`ELECTRON_RUN_AS_NODE=1` и запускает им `orca-board.js`, иначе ищет `node` в PATH. Сообщения в `.cmd` —
латиницей (консоль в OEM-кодировке); `.gitattributes` держит `*.cmd` с CRLF.

## Сборка

`electron-builder.yml`: `extraResources` копирует `packages/cli/bin` в `Resources/cli`,
`cliBinDir()` в проде берёт его оттуда. `npmRebuild: true` пересобирает node-pty под Electron.
`pnpm run pack` (не `pnpm pack` — это встроенная команда pnpm).

Скрипты `apps/desktop/package.json`: `dist:mac` (= `dist`) — `electron-builder --mac`, dmg arm64 + x64;
`dist:win` — `electron-builder --win`. Цели win в `electron-builder.yml`: `nsis` x64 (не one-click, с выбором
папки) → `orca-board-<версия>-x64.exe` и `portable` x64 → `orca-board-<версия>-portable-x64.exe`
(отдельный `artifactName`, иначе portable перезаписывал бы установщик). В `Resources/cli` попадают
обе обёртки CLI — `orca-board` и `orca-board.cmd`. Windows-сборка делается кросс с macOS; тестировать
на Windows негде, поэтому она не проверена вживую.

Сборка под x64 пересобирает node-pty для Intel прямо в `node_modules`, после чего dev-приложение
на arm64 падает с `posix_spawnp failed` (spawn-helper не той архитектуры). Поэтому скрипты
`dist`/`pack` в конце вызывают `electron-builder install-app-deps` — пересборку под текущую машину.

## Грабли разработки

- `git reset --hard` в скриптах тестирования дважды стёр незакоммиченные правки. Правило:
  коммит сразу после зелёного typecheck, тесты — только read-only git-командами.
- Повторяемый флаг CLI (`REPEATABLE_FLAGS`, сейчас `option`) приходит в сокет массивом **всегда**, даже
  из одного вхождения. Хендлер, которому нужно одно значение (`request.resolve --option`), должен принимать
  и строку, и массив — `str()` на массиве даёт `undefined` (`singleOption` в `src/main/request-params.ts`).

## Открытые вопросы

- Удалённый запуск по SSH, мобильный просмотр.
- SQLite вместо JSON, если событий станет много.
- Подпись и нотаризация .app.
