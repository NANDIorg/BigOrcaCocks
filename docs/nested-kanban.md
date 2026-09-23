# Двухуровневый канбан: глобальные задачи и подзадачи

Контракт слоя данных и API для UI (renderer пишется отдельно). Верхний уровень доски — **глобальные
задачи**, внутри каждой — своя доска **подзадач** (обычных `Task`, на которых работают воркеры).
Обе доски используют **реальные колонки проекта** (`Project.columns`, `columns list`), а не фиксированный
набор: макет Planning / In Progress / AI Review / Human Review / Done — это просто пример колонок проекта.
Локальный канбан подзадач показывает все колонки проекта; **глобальный — колонки `kind` backlog,
in_progress, needs_input и done** (`GLOBAL_BOARD_KINDS`, `globalBoardColumns` в `packages/core/src/global-tasks.ts`).
Хранится карточка только в backlog / in_progress / done (`GLOBAL_COLUMN_KINDS`, `globalStoredColumns`);
needs_input — **вычисляемая** колонка: там карточка, пока у прогона есть `pending`-запросы к человеку
(см. «Ответы и ожидание человека»). Готовы / Ревью (и пользовательские `custom`) — этапы подзадач, глобальной задаче там делать нечего.

## Модель: глобальная задача = прогон (`Run`)

Отдельной сущности нет. Прогон (`Run`, `packages/core/src/types.ts`) уже был «набором задач одного
координатора» со своим жизненным циклом (`closedAt`, `run_done`, `runs finish`), а связь задача → прогон
(`Task.runId`) уже хранилась, была неизменяемой и учитывалась в фильтре событий. Поэтому:

- **глобальная задача** — это `Run`; **подзадачи** — задачи с `task.runId === run.id`;
- id глобальной задачи = id прогона (`run_…`); `ORCA_RUN_ID` координатора = его глобальная задача;
- история и lifecycle прогонов сохраняются без изменений: `worker_done`, `question`, `run_done`,
  `check --run`, `runs close/finish` работают как раньше.

Новые поля `Run` (все опциональны в JSON, старые доски читаются):

| Поле | Смысл |
|---|---|
| `objective` | (было) описание глобальной задачи; для координатора — его цель |
| `title?` | название карточки; нет — первая строка `objective` (≤ 80 символов), у «Входящих» — `Входящие` (`globalTaskTitle`) |
| `status?` | id колонки глобального канбана (kind backlog / in_progress / done), где стоит карточка. После миграции есть всегда |
| `inbox?` | служебная глобальная задача «Входящие» (одна на проект) |
| `priority?` | приоритет карточки — та же шкала, что у подзадач (`TaskPriority`: `urgent` / `high` / `normal` / `low`). Новые — `normal`, после миграции есть всегда. Влияет только на порядок показа, не на цель координатора и не на приоритет подзадач |
| `updatedAt?` | последняя правка карточки |
| `reopenedAt?` | прогон переоткрыт и ещё ни одна подзадача не дошла до done после этого (см. «Жизненный цикл») |

Хранение — как раньше, `userData/boards/<projectId>.json` (`StoreSnapshot.runs`, `.tasks`): связь
переживает перезапуск.

### Инварианты

1. **У каждой задачи есть глобальная.** `store.createTask` без `runId` кладёт задачу во «Входящие»
   (создаются лениво); с `runId` несуществующей глобальной — ошибка `run not found`. Так работают старый
   `task create` без `--run` и старый IPC `tasks:create`.
2. **Изоляция.** Зависимость (`deps`) из другой глобальной задачи — ошибка при создании. `runId` задачи
   не меняется (`updateTask` его игнорирует). Проекты изолированы и раньше: у каждого свой store, id чужого
   проекта даёт `run not found`.
3. **Глобальная карточка — не подзадача.** `worker start --task <run_id>` / IPC `worker:start` → ошибка
   «глобальная задача, воркер на ней не запускается» (`startWorker`, `apps/desktop/src/main/worker.ts`).
4. **Нет сирот.** Удаление глобальной задачи с подзадачами — только каскадом (см. `delete`).

### Миграция (в конструкторе `TaskStore`, `migrateGlobalTasks`)

- Прогон без `status`: `closedAt` есть → колонка `kind=done`, иначе `kind=in_progress`; `updatedAt = createdAt`.
- Прогон в колонке подзадач сводится к колонке глобального канбана (`globalTaskStatus` / `globalColumnKind`):
  `ready` → `backlog` (ещё не начата), `needs_input` / `review` / `custom` → `in_progress`, неизвестная колонка → `backlog`.
  То же сведение делает `toGlobalTask` при каждом чтении — карточка не пропадает, если колонки проекта
  поменяли на ходу (kind колонки сменился).
- Задачи без `runId` (или со ссылкой на несуществующий прогон) → во «Входящие» (существующие или новые,
  `createdAt` = самой ранней из них). Статус «Входящих»: все в done → `done` и `closedAt` (без `run_done`),
  иначе `in_progress`.
- Прогон без `priority` или с неизвестным значением → `normal` (`migrateRunPriority`). `toGlobalTask` тоже читает
  такой прогон как `normal`: renderer строит карточки из снапшота, который мог прислать ещё не перезапущенный main.
- Если что-то мигрировало — снапшот сохраняется сразу (id «Входящих» стабилен между перезапусками).
  Повторная загрузка ничего не меняет.

## Жизненный цикл и статус

Статус карточки (`run.status`) и статусы подзадач **независимы**: ручное перемещение карточки не трогает
подзадачи. Жизненный цикл прогона оно меняет только на границе `kind=done` (см. строку «Ручной перенос» ниже).
Автоматика меняет статус карточки только в этих случаях:

| Событие | Что происходит |
|---|---|
| Создание (`createGlobalTask`, `createRun`) | `status` = переданная колонка (только глобального канбана) или первая `kind=backlog` |
| Координатор запущен на прогоне (`setRunPty`) | закрытый прогон переоткрывается; карточка → `kind=in_progress` |
| Все подзадачи в `kind=done` (`closeFinishedRuns`) | `closedAt`, событие `run_done` (у «Входящих» — без события: нет координатора), карточка → `kind=done` |
| `runs finish` на незакрытом прогоне, где все подзадачи в `kind=done` (`finishRun`) | то же закрытие (`closedAt`, `reopenedAt` снят, `run_done` сразу помечен потреблённым) + `finishedAt` |
| Ручной перенос карточки в `kind=done` (`moveGlobalTask`, UI и `global move`) | открытый прогон закрывается: `closedAt`, `reopenedAt` снят, событие `run_done {runId, objective, manual: true}` (у «Входящих» — без события); подзадачи не трогаются. Уже закрытый — без изменений и без второго события. Координатор получает `run_done`, а `coordinatorsToClose` закрывает его терминал после короткой тишины, даже без `runs finish` |
| Ручной перенос карточки из `kind=done` в другую колонку (`moveGlobalTask`) | закрытый прогон переоткрывается (как ниже: `reopenedAt`, старые `run_done` погашены), карточка — в выбранную колонку |
| Ручное закрытие (`closeRun`, `runs close`) | `closedAt` без `run_done`; карточка из `kind=in_progress` → `kind=done`, из других колонок остаётся |
| Новая подзадача в закрытой глобальной (`createTask`) | прогон переоткрыт (`closedAt`/`finishedAt` сброшены); карточка из `kind=done` → `kind=in_progress`, иначе остаётся |

Переоткрытие ставит `reopenedAt`: пока ни одна подзадача не вошла в done после этого, прогон не
закрывается автоматически — иначе повторный запуск координатора на полностью готовой глобальной задаче
тут же получил бы `run_done`. Метку снимает первый вход подзадачи в done (`setStatus`).
Переоткрытие также гасит непотреблённые `run_done` этого прогона (`consumedBy: 'reopen'`) — новый
координатор не получит устаревший. Удаление колонки переносит и карточки
(`reassignColumn`).

`coordinatorsToClose` теперь берёт **последний** `run_done` прогона — прогон мог закрываться несколько раз.

## Ответы и ожидание человека

Всё, что ждёт человека, — запрос `HumanRequest` со статусом `pending` (модель, таблица переходов и события —
`docs/human-requests.md`). Три вида: вопрос воркера (`question`), сданный ответ задачи-ответа (`answer`) и воркер,
вышедший без `done` (`escalation`). Адресат фиксируется при создании запроса и не пересчитывается от того,
жив ли сейчас координатор.

**Задача-ответ** (`Task.answerFor: 'human' | 'coordinator'`) — подзадача, чей результат не код, а текст:
«посмотри», «разберись», «предложи». Создаётся `task create --answer-for …` / `global add-task --answer-for …`,
из UI — выбором «Результат: ответ для меня» (`answerFor: 'human'`).
- Воркер получает в промпте блок «Результат — ответ, а не код» (`workerTaskPrompt`) и сдаёт
  `done --summary "..." --answer-file <файл.md>`: CLI читает файл и шлёт текст в `params.answer`.
  Без ответа `finishDispatch` — ошибка; предел — `MAX_ANSWER_LENGTH` (200 000 символов).
  Ответ хранится в `Dispatch.answer`, событие `worker_done` несёт `answerFor` и `answer` — последним полем,
  обрезанным до `EVENT_ANSWER_LIMIT` (2000 символов) с `answerTruncated: true`: строка события в мониторе
  координатора обрезается. Полный текст — `orca-board task answer --task <id>` (`store.taskAnswer`).
- `answerFor: 'coordinator'` — задача уходит в review, координатор читает ответ и сам делает `review accept`.
- `answerFor: 'human'` — `finishDispatch` создаёт запрос `answer` (`body` — ответ), задача в `kind=needs_input`,
  событие `request_created` идёт следом за `worker_done`. Координатор ничего не делает. Человек **принимает**
  (`accept`, необязательное «Решение / что делать дальше» — `decision`) или **уточняет** (`clarify`).
- Ревью кода задаче-ответу не нужно: ревьюера координатор не создаёт (`skills/coordinator.md`).

**Вопрос воркера** (`orca-board ask`, `store.ask`). Адресат решает main в момент вопроса (`coordinatorAlive`
в `socket.ts`: PTY координатора жив, прогон не закрыт и нет `runs finish`):
- координатор жив — вопрос ждёт его, запроса нет, задача остаётся в работе. Координатор отвечает сам
  (`question answer`) или передаёт человеку (`question forward --question <id> [--note "..."]`: создаётся запрос
  `question`, `note` попадает в его `body`);
- координатора нет («Входящие», умер, закончил) — запрос `question` создаётся сразу. Умер позже — его открытые
  вопросы уходят человеку явным переходом `escalateOpenQuestions(runId)`: по выходу PTY координатора
  (`worker.ts`) и при открытии проекта после перезапуска приложения (`projects.ts`).

**Колонка «Нужен ответ».** Глобальная карточка — в `kind=needs_input`, пока у прогона есть `pending`-запросы
(`GlobalTask.waiting` = их число, `pendingRequestsOf(requests, {runId})`). Подзадача — в `kind=needs_input`,
пока `pending`-запрос есть у неё: его ставит `createRequest`, снимает решение последнего запроса (`settleTask`:
живой воркер → in_progress, иначе ready). Одно условие на обе доски, счётчики и уведомления.

**Решение человека** — одна операция `resolveRequest` (из UI — IPC `requests:resolve`, из CLI — `request resolve`,
в main — `resolveHumanRequest`), процесс идёт дальше сам, координатору ничего писать не нужно:
- **Ответил на вопрос** (вариант и/или текст) → `question_answered {taskId, questionId, requestId, question, answer, workerLive, status}`.
  Живой воркер получает ответ через свой `ask` (или повтор той же команды после таймаута инструмента);
  `ask` уже не ждёт — main пишет в терминал пинок `[orca] на вопрос q_… ответили: orca-board request get --request req_…`
  (`deliverAnswers`, `answerNudge`). Воркер мёртв (`workerLive: false`, задача в ready) — координатор делает
  `worker start`, ответы попадают в промпт (раздел «Ответы на твои вопросы»).
- **Принял ответ** → git-часть приёмки (`acceptReview` в `src/main/review.ts`: коммиты ветки сливаются,
  worktree и ветка удаляются; конфликт — ошибка, ветка остаётся), задача → done, событие
  `answer_accepted {taskId, decision?, summary?, requestId?, dispatchId, answerFor, answer, answerTruncated?}`
  (`decision` сразу после `taskId`, `answer` — последним и обрезанным). Если это последняя подзадача — `run_done`
  приходит следом; координатор сначала решает по ответу (новая подзадача переоткрывает прогон).
- **Уточнил** → `feedback`, задача → ready, событие `answer_clarified {taskId, feedback, requestId, dispatchId}`,
  main сразу стартует воркера; промпт получает прошлый ответ и уточнение. Воркер не стартовал — запрос всё равно
  решён, координатору `escalation {startFailed: true}`.
- **Эскалация**: «Перезапустить» (`restart`: задача → ready, main стартует воркера) или «Скрыть» (`dismiss`:
  задача → ready) → `request_resolved {taskId, action, requestId, kind}`.

Решённый или отменённый запрос повторно не решается («уже решено»). Запросы отменяются (`cancelled`) новым
запуском задачи, сдачей работы, удалением задачи и ручным переносом глобальной карточки в done — тогда
карточка в «Нужен ответ» не показывается, а отвечать больше не на что.

При загрузке снапшота все dispatch без `endedAt` закрываются (`closeStaleDispatches`, outcome `unknown`): PTY не
переживают перезапуск. Снапшот до появления запросов мигрирует один раз (`migrateRequests`): сданные ответы для
человека → запросы `answer`, открытые вопросы текущих запусков → запросы `question`, прочие задачи в needs_input
с упавшим воркером → `escalation`.

`Run.status` запросы **не меняют**: человек решил последний — карточка сама возвращается в свою колонку.
Поставить карточку в needs_input вручную нельзя (`moveGlobalTask`/`createGlobalTask` — ошибка «заполняется сама»,
на `GlobalBoard` колонка не принимает drop).

## Координатор и повторный запуск

- `coordinator start --objective "..."` / IPC `coordinator.start` — как раньше: новый прогон = новая
  глобальная задача (название — из цели), его подзадачи попадают в неё через `ORCA_RUN_ID`.
- **Повторный запуск на существующей**: `coordinator start --global <id>` = `global start --global <id>`,
  IPC `globalTasks.startCoordinator(id, cols, rows, images?)`. Новый прогон **не создаётся** — тот же id,
  подзадачи идут туда же (дублей глобальной задачи нет). Проверки (`resumeObjective`, `worker.ts`):
  нет такой → ошибка; «Входящие» → ошибка; жив прежний координатор этой глобальной (`coordinatorPtyId`) → ошибка.
  Цель (`resumeCoordinatorObjective`, `packages/core/src/prompts.ts`) — описание (пусто → название) плюс
  строка «Повторный запуск: …» со ссылкой на одноимённый раздел `skills/coordinator.md` и список уже
  созданных подзадач `- <id> [<колонка>] <название>`. Правила продолжения живут в разделе инструкции
  (системный промпт), цель на него ссылается и не противоречит: сверься через `global tasks`/`task list`,
  дубли не создавай. Старые вложения этой глобальной удаляются перед записью
  новых. Если спавн упал — существующая глобальная задача не закрывается.
- **Повторный запуск без новой работы**: все подзадачи уже в done, новых координатор не создаёт —
  автозакрытия не будет (`reopenedAt`), `run_done` не придёт. Поэтому раздел «Повторный запуск»
  `skills/coordinator.md` (исключение из «не вызывай runs finish до run_done») и цель велят в этом случае
  не ставить монитор, написать сводку и выполнить `orca-board runs finish`: `finishRun` сам закроет прогон
  (`closedAt`, карточка → done, новый `run_done`, `finishedAt`), и `coordinatorsToClose` закроет терминал
  Codex. То же, если новую подзадачу удалили. `runs finish` на прогоне с незавершёнными подзадачами или
  на свежем прогоне без подзадач — по-прежнему ошибка `run not closed … — дождись run_done`.

## API

Все ответы — JSON. Ошибки: сокет `{ok:false, error}`, CLI — `ошибка: …` в stderr и код 1, IPC — reject.

### Тип `GlobalTask` (`packages/core/src/global-tasks.ts`)

```ts
interface GlobalTask {
  id: string                 // = Run.id
  title: string              // globalTaskTitle(run)
  description: string        // = Run.objective
  status: string             // id колонки проекта; needs_input — вычислено из waiting
  priority: TaskPriority     // = Run.priority; нет поля или мусор — normal
  inbox: boolean
  createdAt: number
  updatedAt: number          // правка карточки
  activityAt: number         // max(updatedAt, updatedAt подзадач) — «время» на карточке
  closedAt?: number          // run_done или ручное закрытие
  finishedAt?: number        // координатор прислал runs finish
  coordinatorPtyId?: string  // живость — по реестру терминалов (TerminalInfo.runId); в global list/get —
                             // вычисляемое coordinatorAlive (isAlive в реестре PTY, в store не хранится)
  coordinatorAgent?: AgentKind
  waiting: number            // pending-запросы к человеку этого прогона (HumanRequest)
  progress: {
    total: number            // подзадач
    done: number             // из них в kind=done
    byStatus: Record<string, number>          // по id колонки, только непустые
    byKind: Partial<Record<ColumnKind, number>> // по kind колонки
  }
  ownActiveMs?: number       // основное время: сама глобальная была в работе (= Run.activeMs), закрытые отрезки, мс
  ownActiveSince?: number    // начало идущего отрезка основного времени (= Run.activeSince); нет — стоит
  subtasksActiveMs: number   // сумма закрытых отрезков подзадач (Task.activeMs), мс
  subtasksActiveSince: number[] // начала идущих отрезков подзадач в работе; пусто — сумма стоит
}
```

У глобальной задачи **два времени**:

- **Основное** (`ownActiveMs`/`ownActiveSince`, длительность — `globalOwnDuration(g, now)`) — сколько сама карточка
  была в работе. Отрезок открыт, пока карточка **показана** в колонке `kind=in_progress`
  (`globalTaskInProgress`: хранимый `Run.status` в in_progress и нет pending-запросов прогона). В «Нужен ответ»
  время стоит — это ожидание человека, как у подзадач в needs_input; в бэклоге и done — тоже. Хранится в
  `Run.activeMs`/`Run.activeSince` и пересчитывается одним проходом в `TaskStore.commit` → `syncRunActiveTime`
  (`trackActiveTime`), а не в каждом присваивании `run.status`: статус прогона меняют перенос, запуск координатора,
  reopen, автозакрытие, удаление колонки, а «Нужен ответ» зависит ещё и от запросов.
  Нет полей — своё время неизвестно: карточка от старого main или прогон от кода до этих полей (см. миграцию).
- **Сумма подзадач** (`subtasksActiveMs`/`subtasksActiveSince`, `globalSubtasksTime`, длительность —
  `globalSubtasksDuration(g, now)`): тикает, только пока хоть одна подзадача в `kind=in_progress`, параллельные
  подзадачи складываются (трудозатраты агентов, а не календарное время). Статус глобальной на неё не влияет.

Миграция (`migrateRunActiveTime` при загрузке, после статусов и запросов): прошлые отрезки прогона не
восстановить — смены его статуса не журналируются, а сумма подзадач — другая величина. Прогон, который сейчас
в работе (и не ждёт человека), получает открытый отрезок от `updatedAt` (нет — `createdAt`); остальные остаются
без полей до следующего входа в работу. UI без основного времени показывает только сумму подзадач.

Renderer (`duration.ts`): `globalTaskDuration(g, 'own' | 'subtasks', now)`, `globalTaskTicking`, `globalTimeLabel`,
`globalTimeParts` (какие времена где показывать). Компонент — `GlobalDuration` в `GlobalBoard.tsx`, каждое время
тикает само:
- **Карточка глобального канбана** (`variant="chip"`) — только основное: «⏱ 1 ч», «⏸ 1 ч», у закрытой «за 1 ч».
  Сумма подзадач на карточку не выводится. Основное неизвестно (старый main с прежними `activeMs`/`activeSince` —
  это была сумма подзадач — или прогон от кода до этих полей) — карточка показывает сумму «Σ ⏸ 3 ч», как раньше.
- **Внутри глобальной задачи** (`variant="line"`: шапка экрана подзадач `GlobalTaskView.tsx` и модалка
  `GlobalTaskModal.tsx`) — два подписанных времени: «В работе: ⏱ 1 ч · Сумма подзадач: ⏸ 3 ч». Основное
  неизвестно — только «Сумма подзадач: …».

Чистые функции для renderer (без IPC): `toGlobalTasks(runs, tasks, columns, requests?)`,
`toGlobalTask`, `globalTaskProgress`, `globalSubtasksTime`, `globalSubtasksDuration`, `globalOwnDuration`,
`globalDisplayStatus`, `globalTaskInProgress`, `globalTaskTitle`, `isPendingRequest`, `pendingRequestsOf`, `hasPendingRequest`,
`INBOX_TITLE` — экспортируются из `@orca-board/core`. Без `requests` `waiting` = 0.
Живой UI может строить карточки из `board:changed` (`snapshot.runs` + `snapshot.tasks` + `snapshot.requests`) без лишних запросов.

### IPC — `window.orca.globalTasks` (активный проект; типы — `apps/desktop/src/shared/ipc.ts`)

| Метод | Канал | Результат | Ошибки |
|---|---|---|---|
| `list()` | `globalTasks:list` | `GlobalTask[]` в порядке создания (нет проекта → `[]`) | — |
| `get(id)` | `globalTasks:get` | `GlobalTask` | `run not found` |
| `create({title?, description?, status?, priority?})` | `globalTasks:create` | `GlobalTask` | нет ни названия, ни описания; неизвестная колонка; колонка не глобального канбана; неизвестный приоритет |
| `update(id, {title?, description?, priority?})` | `globalTasks:update` | `GlobalTask` | пустой патч; пустое название; неизвестный приоритет (карточка не меняется) |
| `move(id, status)` | `globalTasks:move` | `GlobalTask` | неизвестная колонка; колонка не глобального канбана (ready / needs_input / review / custom) |
| `remove(id, {cascade?})` | `globalTasks:remove` | `{deleted, tasks: string[]}` | есть подзадачи без `cascade`; подзадача с живым dispatch; жив координатор |
| `tasks(id)` | `globalTasks:tasks` | `Task[]` только этой глобальной | `run not found` |
| `createTask(id, {title, spec?, deps?, roleId?})` | `globalTasks:createTask` | `Task` (`runId = id`) | пустое название; роль (`pickRole`); deps из другой глобальной; `run not found` |
| `startCoordinator(id, cols, rows, images?)` | `globalTasks:startCoordinator` | `ptyId` | см. «Повторный запуск» |

Изменения приходят как раньше в `board.onChange` (`board:changed {projectId, snapshot}`). Старые
`tasks.*`, `runs.*`, `coordinator.start`, `worker.start` не менялись (кроме: `tasks.create` → во «Входящие»).
`remove` при `cascade` после удаления закрывает оставшиеся живые терминалы подзадач (`removeGlobalTask`, `index.ts`).

### Сокет и CLI

| CLI | Метод сокета | Параметры | Результат |
|---|---|---|---|
| `global list` | `global.list` | — | `GlobalTask[]` + `coordinatorAlive` |
| `global get [--global <id>]` | `global.get` | `global` | `GlobalTask` + `coordinatorAlive` |
| `global create [--title] [--description] [--status <col>] [--priority …]` | `global.create` | `title?`, `description?`, `status?`, `priority?` | `GlobalTask` |
| `global update --global <id> [--title] [--description] [--priority …]` | `global.update` | `global`, `title?`, `description?`, `priority?` | `GlobalTask` |
| `global move --global <id> --status <col>` | `global.move` | `global`, `status` | `GlobalTask` |
| `global delete --global <id> [--cascade]` | `global.delete` | `global`, `cascade?: true` | `{deleted, tasks}` |
| `global tasks [--global <id>]` | `global.tasks` | `global` | `Task[]` |
| `global add-task [--global <id>] --title … [--spec …] --role <id> [--dep <id>]… [--priority …]` | `global.add-task` | `global`, как `task.create` | `Task` |
| `global start --global <id>` | `global.start` | `global` | `{ptyId}` |
| `coordinator start --global <id>` | `coordinator.start` | `global` (важнее `objective`) | `{ptyId}` |
| `task list [--run <id>]` | `task.list` | `run?` | с `run` — только подзадачи, без — все задачи (как раньше) |

`--global` у `global get`, `global tasks`, `global add-task` по умолчанию = `$ORCA_RUN_ID` (координатор
видит свою глобальную задачу); у `update`/`move`/`delete`/`start` — только явно. `--global` без значения —
ошибка до обращения к сокету. `--priority urgent|high|normal|low` у `global create`/`global update`: значение
проверяет store (`приоритет: ожидается …, получено «…»`), флаг без значения — ошибка сокета; приоритет глобальной
меняется в любой колонке и подзадач не касается (у них свой, `task update --priority`). Совместимость: `task create [--run]`, `check`, `runs list/close/finish`,
`done`, `worker start`, `review *` — без изменений (`ask` расширен, `question forward` получил `--note`, добавлены
`request list|get|resolve` — `docs/human-requests.md`) (`runs.list` дополнительно покажет «Входящие»,
если в проекте есть задачи без прогона).

## Что учесть UI

- Колонки внутренней доски — `Project.columns` (порядок, `title`, `color`, `kind`); верхнего уровня —
  `globalBoardColumns(Project.columns)` (только backlog / in_progress / done). Счётчик колонки верхнего
  уровня — число карточек с `status === column.id` (`GlobalTask.status` уже сведён к видимой колонке).
- Карточка: `title`, `description` (кратко), статус, `progress.done/total`, `activityAt`.
- Внутренняя доска — `tasks(id)` или `snapshot.tasks.filter(t => t.runId === id)`; создание — только
  `createTask(id, …)`; drag подзадач — прежний `tasks.move`, drag карточек — `globalTasks.move`.
- Кнопка «Запустить» на карточке — `startCoordinator`, не `worker.start`. Живой координатор — терминал
  с `role: 'coordinator'` и `runId === id` в реестре.
- «Входящие» (`inbox: true`) — показывать как обычную карточку; координатора на ней не запускать.

## Проверки

- `packages/core/src/global-tasks.test.ts` — CRUD, реальные колонки, колонки глобального канбана и сведение
  статусов из скрытых колонок, прогресс, изоляция, удаление,
  lifecycle (run_done, повторный запуск с новой подзадачей и без неё → `runs finish` закрывает прогон
  и терминал, ручное закрытие, «Входящие» без run_done), сохранение и миграция старого снапшота.
- `packages/core/src/coordinator-close.test.ts` — последний `run_done` переоткрытого прогона.
- `packages/core/src/answers.test.ts`, `requests.test.ts` — задачи-ответы, запросы к человеку: создание, решения,
  отмена, миграция, колонка «Нужен ответ» только по `pending`.
- `packages/core/src/prompts.test.ts` — встроенный промпт координатора содержит раздел «Повторный запуск»
  с исключением для `runs finish`; `resumeCoordinatorObjective` добавляет список и ссылку только при наличии подзадач;
  skills описывают события запросов и флаги `ask`; команды `orca-board …` в skills и `docs/human-requests.md`
  есть в справке CLI.
- `packages/cli/test/cli.test.js` — запросы CLI к фейковому сокету: старые команды и `global *`.
- `pnpm typecheck`, `pnpm test`.

## Реализация UI (renderer)

- `GlobalBoard.tsx` — вкладка «Канбан» без открытой задачи: карточки `toGlobalTasks(snapshot.runs, snapshot.tasks, …)`
  по колонкам Бэклог / В работе / Сделано проекта (`globalBoardColumns`; счётчик, цветная верхняя линия), drag —
  `globalTasks.move` (бросить можно только в показанные колонки), карточка: название и
  описание по 2 строки, чип колонки, бейдж приоритета (`PriorityBadge`, у `normal` его нет — как у подзадач),
  живой координатор, вопросы/ревью подзадач, прогресс done/total, `activityAt`.
  Сортировка в тулбаре — те же режимы, что у доски подзадач (`BOARD_SORT_OPTIONS`): по созданию / по завершению
  (`closedAt`) / по обновлению (`activityAt`) / по приоритету (`compareGlobals` → `compareSorted`: сначала выше
  приоритет, при равном — по `createdAt`; карточка без `priority` от старого main — как `normal`). Выбор —
  в `localStorage` ключом `orca.globalBoard.sort` (`GLOBAL_BOARD_SORT_KEY`), отдельно от доски подзадач.
  Кнопки на карточке: запуск координатора (не у «Входящих» и не при живом), правка, удаление (каскадом при подзадачах).
- `GlobalTaskView.tsx` — экран открытой глобальной задачи: крошки «← Глобальные задачи / название», описание,
  прогресс, бейдж приоритета (правка — через «Изменить»), «Изменить», «Запустить координатора» / «Координатор работает» (переход к терминалу) и `Board` только
  с `task.runId === id` (прежние действия подзадач: drag `tasks.move`, модалка задачи, запуск воркера, вопросы, ревью).
- `GlobalTaskModal.tsx` — создание (`globalTasks.create`, колонка глобального канбана и приоритет на выбор, по умолчанию
  «обычный») и правка (`globalTasks.update`, только изменённые поля, приоритет — тоже). У «Входящих» приоритета в модалке нет.
  Старый main (прогоны в снимке без `priority`, `runsKnowPriority` в `taskPriority.ts`) приоритет не сохранит:
  вместо выбора — текущий приоритет и просьба перезапустить приложение, в `create`/`update` поле не уходит.
  «Новая подзадача» в шапке открыта задачей → `NewTaskModal` с зависимостями только из её подзадач и приоритетом (по умолчанию «обычный») → `globalTasks.createTask`.
- Открытая глобальная задача — в `ProjectView.globalId` (по проекту, `localStorage` `orca.global.<projectId>`):
  переживает перезагрузку; id, которого нет в снимке активного проекта, показывает общую доску.
- Клавиатура: карточка фокусируется Tab, Enter/Space открывает; на экране задачи фокус на «назад», Esc (вне полей и
  модалок) возвращает, фокус — обратно на карточку. Повторный клик по вкладке «Канбан» тоже возвращает.
