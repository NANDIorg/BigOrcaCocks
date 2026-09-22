# Двухуровневый канбан: глобальные задачи и подзадачи

Контракт слоя данных и API для UI (renderer пишется отдельно). Верхний уровень доски — **глобальные
задачи**, внутри каждой — своя доска **подзадач** (обычных `Task`, на которых работают воркеры).
Обе доски используют **реальные колонки проекта** (`Project.columns`, `columns list`), а не фиксированный
набор: макет Planning / In Progress / AI Review / Human Review / Done — это просто пример колонок проекта.

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
| `status?` | id колонки проекта, где стоит карточка. После миграции есть всегда |
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
- Задачи без `runId` (или со ссылкой на несуществующий прогон) → во «Входящие» (существующие или новые,
  `createdAt` = самой ранней из них). Статус «Входящих»: все в done → `done` и `closedAt` (без `run_done`),
  иначе `in_progress`.
- Если что-то мигрировало — снапшот сохраняется сразу (id «Входящих» стабилен между перезапусками).
  Повторная загрузка ничего не меняет.

## Жизненный цикл и статус

Статус карточки (`run.status`) и статусы подзадач **независимы**: ручное перемещение карточки не трогает
подзадачи и не закрывает/не открывает прогон. Автоматика меняет статус карточки только в этих случаях:

| Событие | Что происходит |
|---|---|
| Создание (`createGlobalTask`, `createRun`) | `status` = переданная колонка или первая `kind=backlog` |
| Координатор запущен на прогоне (`setRunPty`) | закрытый прогон переоткрывается; карточка → `kind=in_progress` |
| Все подзадачи в `kind=done` (`closeFinishedRuns`) | `closedAt`, событие `run_done` (у «Входящих» — без события: нет координатора), карточка → `kind=done` |
| `runs finish` на незакрытом прогоне, где все подзадачи в `kind=done` (`finishRun`) | то же закрытие (`closedAt`, `reopenedAt` снят, `run_done` сразу помечен потреблённым) + `finishedAt` |
| Ручное закрытие (`closeRun`, `runs close`) | `closedAt` без `run_done`; карточка из `kind=in_progress` → `kind=done`, из других колонок остаётся |
| Новая подзадача в закрытой глобальной (`createTask`) | прогон переоткрыт (`closedAt`/`finishedAt` сброшены); карточка из `kind=done` → `kind=in_progress`, иначе остаётся |

Переоткрытие ставит `reopenedAt`: пока ни одна подзадача не вошла в done после этого, прогон не
закрывается автоматически — иначе повторный запуск координатора на полностью готовой глобальной задаче
тут же получил бы `run_done`. Метку снимает первый вход подзадачи в done (`setStatus`).
Переоткрытие также гасит непотреблённые `run_done` этого прогона (`consumedBy: 'reopen'`) — новый
координатор не получит устаревший. Удаление колонки переносит и карточки
(`reassignColumn`).

`coordinatorsToClose` теперь берёт **последний** `run_done` прогона — прогон мог закрываться несколько раз.

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
  status: string             // id колонки проекта
  inbox: boolean
  createdAt: number
  updatedAt: number          // правка карточки
  activityAt: number         // max(updatedAt, updatedAt подзадач) — «время» на карточке
  closedAt?: number          // run_done или ручное закрытие
  finishedAt?: number        // координатор прислал runs finish
  coordinatorPtyId?: string  // живость — по реестру терминалов (TerminalInfo.runId)
  coordinatorAgent?: AgentKind
  progress: {
    total: number            // подзадач
    done: number             // из них в kind=done
    byStatus: Record<string, number>          // по id колонки, только непустые
    byKind: Partial<Record<ColumnKind, number>> // по kind колонки
  }
}
```

Чистые функции для renderer (без IPC): `toGlobalTasks(runs, tasks, columnKind, fallbackStatus?)`,
`toGlobalTask`, `globalTaskProgress`, `globalTaskTitle`, `INBOX_TITLE` — экспортируются из `@orca-board/core`.
Живой UI может строить карточки из `board:changed` (`snapshot.runs` + `snapshot.tasks`) без лишних запросов.

### IPC — `window.orca.globalTasks` (активный проект; типы — `apps/desktop/src/shared/ipc.ts`)

| Метод | Канал | Результат | Ошибки |
|---|---|---|---|
| `list()` | `globalTasks:list` | `GlobalTask[]` в порядке создания (нет проекта → `[]`) | — |
| `get(id)` | `globalTasks:get` | `GlobalTask` | `run not found` |
| `create({title?, description?, status?})` | `globalTasks:create` | `GlobalTask` | нет ни названия, ни описания; неизвестная колонка |
| `update(id, {title?, description?})` | `globalTasks:update` | `GlobalTask` | пустой патч; пустое название |
| `move(id, status)` | `globalTasks:move` | `GlobalTask` | неизвестная колонка |
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

- Колонки обеих досок — `Project.columns` (порядок, `title`, `color`, `kind`); счётчик колонки верхнего
  уровня — число карточек с `status === column.id`.
- Карточка: `title`, `description` (кратко), статус, `progress.done/total`, `activityAt`.
- Внутренняя доска — `tasks(id)` или `snapshot.tasks.filter(t => t.runId === id)`; создание — только
  `createTask(id, …)`; drag подзадач — прежний `tasks.move`, drag карточек — `globalTasks.move`.
- Кнопка «Запустить» на карточке — `startCoordinator`, не `worker.start`. Живой координатор — терминал
  с `role: 'coordinator'` и `runId === id` в реестре.
- «Входящие» (`inbox: true`) — показывать как обычную карточку; координатора на ней не запускать.

## Проверки

- `packages/core/src/global-tasks.test.ts` — CRUD, реальные колонки, прогресс, изоляция, удаление,
  lifecycle (run_done, повторный запуск с новой подзадачей и без неё → `runs finish` закрывает прогон
  и терминал, ручное закрытие, «Входящие» без run_done), сохранение и миграция старого снапшота.
- `packages/core/src/coordinator-close.test.ts` — последний `run_done` переоткрытого прогона.
- `packages/core/src/prompts.test.ts` — встроенный промпт координатора содержит раздел «Повторный запуск»
  с исключением для `runs finish`; `resumeCoordinatorObjective` добавляет список и ссылку только при наличии подзадач.
- `packages/cli/test/cli.test.js` — запросы CLI к фейковому сокету: старые команды и `global *`.
- `pnpm typecheck`, `pnpm test`.
