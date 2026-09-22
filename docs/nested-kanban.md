# Двухуровневый канбан: глобальные задачи и подзадачи

Контракт слоя данных и API для UI (renderer пишется отдельно). Верхний уровень доски — **глобальные
задачи**, внутри каждой — своя доска **подзадач** (обычных `Task`, на которых работают воркеры).
Обе доски используют **реальные колонки проекта** (`Project.columns`, `columns list`), а не фиксированный
набор: макет Planning / In Progress / AI Review / Human Review / Done — это просто пример колонок проекта.
Локальный канбан подзадач показывает все колонки проекта; **глобальный — колонки `kind` backlog,
in_progress, needs_input и done** (`GLOBAL_BOARD_KINDS`, `globalBoardColumns` в `packages/core/src/global-tasks.ts`).
Хранится карточка только в backlog / in_progress / done (`GLOBAL_COLUMN_KINDS`, `globalStoredColumns`);
needs_input — **вычисляемая** колонка: там карточка, пока подзадачи ждут человека (см. «Ответы и ожидание
человека»). Готовы / Ревью (и пользовательские `custom`) — этапы подзадач, глобальной задаче там делать нечего.

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

**Задача-ответ** (`Task.answerFor: 'human' | 'coordinator'`) — подзадача, чей результат не код, а текст:
«посмотри», «разберись», «предложи». Создаётся `task create --answer-for …` / `global add-task --answer-for …`,
из UI — выбором «Результат: ответ для меня» (`answerFor: 'human'`).
- Воркер получает в промпте блок «Результат — ответ, а не код» (`workerTaskPrompt`) и сдаёт
  `done --summary "..." --answer-file <файл.md>`: CLI читает файл и шлёт текст в `params.answer`.
  Без ответа `finishDispatch` — ошибка; предел — `MAX_ANSWER_LENGTH` (200 000 символов).
  Ответ хранится в `Dispatch.answer`, событие `worker_done` несёт `answerFor` и `answer`.
- `answerFor: 'coordinator'` — координатор читает `answer` из события и сам делает `review accept`.
  `answerFor: 'human'` — координатор ничего не делает; человек в `TaskModal` видит ответ (markdown) и
  **принимает** (`review accept`: у задачи-ответа ничего не сливается, worktree и ветка удаляются —
  `src/main/review.ts`) или **уточняет** (`review reject` + перезапуск воркера; промпт получает прошлый
  ответ и уточнение).
- Ревью кода задаче-ответу не нужно: ревьюера координатор не создаёт (`skills/coordinator.md`).

**Вопрос человеку.** Вопрос воркера (`ask`) сначала решает координатор: ответить сам или передать
человеку `question forward --question <id>` (`Question.forHuman = true`, `store.forwardQuestion`).
Без координатора — «Входящие», нет `coordinatorPtyId` или уже был `runs finish` — вопрос адресован
человеку сразу (`questionForHuman`).

**Колонка «Нужен ответ» глобального канбана.** Подзадача ждёт человека (`waitingForHuman`), если это
задача-ответ для человека в колонке `kind=needs_input` (`kind=review` — старые данные) или у неё открыт
вопрос, адресованный человеку.

Сама подзадача при этом тоже стоит в `kind=needs_input`, а не в review (`store.ts`):
- `finishDispatch` задачи-ответа `answerFor: 'human'` → needs_input (остальные — review, как раньше);
  принять (`review accept`) → done, уточнить (`review reject` + перезапуск) → ready → in_progress.
- `ask` → needs_input (как и раньше), `forwardQuestion` тоже ставит needs_input (кроме done).
  `answer` последнего открытого вопроса возвращает в поток: живой dispatch — in_progress, иначе ready.
  Сданный ответ для человека (`humanAnswerReady`) остаётся в needs_input.
- При загрузке снапшота такой ответ, застрявший в review, переезжает в needs_input (`migrateHumanAnswers`):
  `electron-vite dev` не пересобирает main-процесс на лету, и приложение, запущенное до фикса, клало ответ в review.
**Процесс идёт дальше сам** — после ответа человека координатору ничего писать не нужно:
- **Принял ответ** (`review accept` → `store.acceptTask`): задача → done и событие
  `answer_accepted {taskId, dispatchId, answerFor, summary, answer, decision?}` в прогон координатора (только для
  `answerFor: 'human'` и только при первом переходе в done). `decision` — необязательное поле «Решение / что делать
  дальше» у «Принять» (`AnswerBlock`, `review accept --decision`): по нему координатор заводит задачи. Коммиты
  в ветке задачи-ответа при приёмке сливаются, как у рабочей (`acceptReview` в `src/main/review.ts`);
  незакоммиченные черновики — нет. Конфликт мержа — ошибка, ветка и worktree остаются. Если это последняя подзадача — `run_done` приходит
  следом; координатор сначала решает по ответу (новая подзадача переоткрывает прогон, `run_done` не обрабатывается).
- **Уточнил**: UI делает `review reject` и сразу `worker start`; воркер сдаёт новый ответ → снова `worker_done`.
- **Ответил на вопрос** (`store.answer`): `question_answered {taskId, questionId, question, answer, workerLive, status}`.
  Воркер жив и его `ask` ещё держит соединение — ответ уходит через сокет. `ask` уже оборван (таймаут инструмента
  агента: человек отвечает дольше) или был `--no-wait` — main вписывает ответ одной строкой в терминал живого
  воркера (`deliverAnswers` в `src/main/index.ts`, `askWaiting` в `socket.ts`, текст — `questionAnswerMessage`).
  Воркер не жив (`workerLive: false`, задача в ready) — координатор делает `worker start`; ответы на прошлые
  вопросы задачи попадают в промпт (`workerTaskPrompt`, раздел «Ответы на твои вопросы»).

`toGlobalTask` считает таких подзадач `GlobalTask.waiting`; если их > 0 и карточка не в `kind=done`,
её `status` — колонка `kind=needs_input` проекта (если такая колонка есть). `Run.status` при этом **не
меняется**: человек ответил или принял ответ — карточка сама возвращается в свою колонку. Поставить
карточку в needs_input вручную нельзя (`moveGlobalTask`/`createGlobalTask` — ошибка «заполняется сама»,
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
  inbox: boolean
  createdAt: number
  updatedAt: number          // правка карточки
  activityAt: number         // max(updatedAt, updatedAt подзадач) — «время» на карточке
  closedAt?: number          // run_done или ручное закрытие
  finishedAt?: number        // координатор прислал runs finish
  coordinatorPtyId?: string  // живость — по реестру терминалов (TerminalInfo.runId)
  coordinatorAgent?: AgentKind
  waiting: number            // подзадачи, ждущие человека (waitingForHuman)
  progress: {
    total: number            // подзадач
    done: number             // из них в kind=done
    byStatus: Record<string, number>          // по id колонки, только непустые
    byKind: Partial<Record<ColumnKind, number>> // по kind колонки
  }
}
```

Чистые функции для renderer (без IPC): `toGlobalTasks(runs, tasks, columns, questions?)`,
`toGlobalTask`, `globalTaskProgress`, `globalTaskTitle`, `waitingForHuman`, `questionForHuman`, `INBOX_TITLE` —
экспортируются из `@orca-board/core`. Без `questions` вопросы не учитываются в `waiting`.
Живой UI может строить карточки из `board:changed` (`snapshot.runs` + `snapshot.tasks`) без лишних запросов.

### IPC — `window.orca.globalTasks` (активный проект; типы — `apps/desktop/src/shared/ipc.ts`)

| Метод | Канал | Результат | Ошибки |
|---|---|---|---|
| `list()` | `globalTasks:list` | `GlobalTask[]` в порядке создания (нет проекта → `[]`) | — |
| `get(id)` | `globalTasks:get` | `GlobalTask` | `run not found` |
| `create({title?, description?, status?})` | `globalTasks:create` | `GlobalTask` | нет ни названия, ни описания; неизвестная колонка; колонка не глобального канбана |
| `update(id, {title?, description?})` | `globalTasks:update` | `GlobalTask` | пустой патч; пустое название |
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
| `global list` | `global.list` | — | `GlobalTask[]` |
| `global get [--global <id>]` | `global.get` | `global` | `GlobalTask` |
| `global create [--title] [--description] [--status <col>]` | `global.create` | `title?`, `description?`, `status?` | `GlobalTask` |
| `global update --global <id> [--title] [--description]` | `global.update` | `global`, `title?`, `description?` | `GlobalTask` |
| `global move --global <id> --status <col>` | `global.move` | `global`, `status` | `GlobalTask` |
| `global delete --global <id> [--cascade]` | `global.delete` | `global`, `cascade?: true` | `{deleted, tasks}` |
| `global tasks [--global <id>]` | `global.tasks` | `global` | `Task[]` |
| `global add-task [--global <id>] --title … [--spec …] --role <id> [--dep <id>]…` | `global.add-task` | `global`, как `task.create` | `Task` |
| `global start --global <id>` | `global.start` | `global` | `{ptyId}` |
| `coordinator start --global <id>` | `coordinator.start` | `global` (важнее `objective`) | `{ptyId}` |
| `task list [--run <id>]` | `task.list` | `run?` | с `run` — только подзадачи, без — все задачи (как раньше) |

`--global` у `global get`, `global tasks`, `global add-task` по умолчанию = `$ORCA_RUN_ID` (координатор
видит свою глобальную задачу); у `update`/`move`/`delete`/`start` — только явно. `--global` без значения —
ошибка до обращения к сокету. Совместимость: `task create [--run]`, `check`, `runs list/close/finish`,
`done`, `ask`, `worker start`, `review *` — без изменений (`runs.list` дополнительно покажет «Входящие»,
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
- `packages/core/src/prompts.test.ts` — встроенный промпт координатора содержит раздел «Повторный запуск»
  с исключением для `runs finish`; `resumeCoordinatorObjective` добавляет список и ссылку только при наличии подзадач.
- `packages/cli/test/cli.test.js` — запросы CLI к фейковому сокету: старые команды и `global *`.
- `pnpm typecheck`, `pnpm test`.

## Реализация UI (renderer)

- `GlobalBoard.tsx` — вкладка «Канбан» без открытой задачи: карточки `toGlobalTasks(snapshot.runs, snapshot.tasks, …)`
  по колонкам Бэклог / В работе / Сделано проекта (`globalBoardColumns`; счётчик, цветная верхняя линия), drag —
  `globalTasks.move` (бросить можно только в показанные колонки), карточка: название и
  описание по 2 строки, чип колонки, живой координатор, вопросы/ревью подзадач, прогресс done/total, `activityAt`.
  Кнопки на карточке: запуск координатора (не у «Входящих» и не при живом), правка, удаление (каскадом при подзадачах).
- `GlobalTaskView.tsx` — экран открытой глобальной задачи: крошки «← Глобальные задачи / название», описание,
  прогресс, «Изменить», «Запустить координатора» / «Координатор работает» (переход к терминалу) и `Board` только
  с `task.runId === id` (прежние действия подзадач: drag `tasks.move`, модалка задачи, запуск воркера, вопросы, ревью).
- `GlobalTaskModal.tsx` — создание (`globalTasks.create`, колонка глобального канбана на выбор) и правка (`globalTasks.update`, только изменённые поля).
  «Новая подзадача» в шапке открыта задачей → `NewTaskModal` с зависимостями только из её подзадач → `globalTasks.createTask`.
- Открытая глобальная задача — в `ProjectView.globalId` (по проекту, `localStorage` `orca.global.<projectId>`):
  переживает перезагрузку; id, которого нет в снимке активного проекта, показывает общую доску.
- Клавиатура: карточка фокусируется Tab, Enter/Space открывает; на экране задачи фокус на «назад», Esc (вне полей и
  модалок) возвращает, фокус — обратно на карточку. Повторный клик по вкладке «Канбан» тоже возвращает.
