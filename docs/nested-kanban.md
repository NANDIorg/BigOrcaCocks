# Двухуровневый канбан: глобальные задачи и подзадачи

Контракт слоя данных и API для UI (renderer пишется отдельно). Верхний уровень доски — **глобальные
задачи**, внутри каждой — своя доска **подзадач** (обычных `Task`, на которых работают воркеры).
Обе доски используют **реальные колонки проекта** (`Project.columns`, `columns list`), а не фиксированный
набор: макет Planning / In Progress / AI Review / Human Review / Done — это просто пример колонок проекта.
Локальный канбан подзадач показывает все колонки проекта, кроме «Готовы» (kind ready): её карточки лежат в «Бэклоге» — готовые к запуску сверху, ждущие зависимостей ниже с меткой «⧗ ждёт: …» (`localBoardColumns`, `renderer/src/boardColumns.ts`; статус ready в модели остаётся, см. «UI: доска» в `docs/architecture.md`); **глобальный — колонки `kind` backlog,
in_progress, needs_input, review и done** (`GLOBAL_BOARD_KINDS`, `globalBoardColumns` в `packages/core/src/global-tasks.ts`).
Хранится карточка только в backlog / in_progress / review / done (`GLOBAL_COLUMN_KINDS`, `globalStoredColumns`);
needs_input — **вычисляемая** колонка: там карточка, пока у прогона есть `pending`-запросы к человеку
(см. «Ответы и ожидание человека»). Системная колонка `review` на глобальном канбане называется
**«Проверка»** (`GLOBAL_REVIEW_TITLE`; id и цвет — от колонки проекта): работа закрыта и ждёт приёмки человеком
(см. «Проверка»). Отдельный kind не заводится — `review` есть в каждом проекте (`validateColumns`), миграция
колонок не нужна. Готовы (и пользовательские `custom`) — этапы подзадач, глобальной задаче там делать нечего.

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
| `status?` | id колонки глобального канбана (kind backlog / in_progress / review / done), где стоит карточка. После миграции есть всегда |
| `returns?` | уточнения человека при «Вернуть в работу» с «Проверки», по порядку: `{at, text}[]`. `objective` они не меняют — попадают в цель повторного запуска координатора |
| `summary?` | итоговая сводка координатора `{at, text}` (markdown) из `runs finish --summary`: блок «Что сделал» на «Проверке». Одна, последняя — следующая непустая заменяет |
| `inbox?` | служебная глобальная задача «Входящие» (одна на проект) |
| `typeId?` | тип задачи (`TaskType`, `packages/core/src/task-types.ts`): роли, граф, правила агентов доски и разрешения прогона. Роли берутся из библиотеки по `typeId` «вживую» (`resolveRunType`). Нет — «Входящие» или прогон до типов: тип проекта по умолчанию. У «Входящих» типа нет никогда |
| `taskType?` | снимок типа при создании `{id, title, roles, agentRules?, permissionMode?}` — если тип удалят, прогон доработает на нём |
| `workflow?` | снимок графа типа при создании; правка типа идущие задачи не ломает |
| `startedAt?` | первый вход карточки в работу (`kind=in_progress`: перенос, запуск координатора) — ставится в `commit()` вместе с открытием отрезка времени (`syncRunActiveTime`) и не снимается. Прогоны от кода до поля — миграция `migrateRunStarted`: есть координатор, подзадачи, своё время, `closedAt` или карточка не в бэклоге → `startedAt = updatedAt` |
| `priority?` | приоритет карточки — та же шкала, что у подзадач (`TaskPriority`: `urgent` / `high` / `normal` / `low`). Новые — `normal`, после миграции есть всегда. Влияет только на порядок показа, не на цель координатора и не на приоритет подзадач |
| `updatedAt?` | последняя правка карточки |
| `reopenedAt?` | прогон переоткрыт и ещё ни одна подзадача не дошла до done после этого (см. «Жизненный цикл») |
| `runDoneAt?` | все подзадачи в done, координатору отправлен `run_done`, прогон ещё не закрыт: координатор решает, нужна ли новая работа (см. «Почему „все подзадачи в done“ не закрывает прогон») |

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
подзадачи. Жизненный цикл прогона оно меняет только на границе закрытых колонок `kind=review` / `kind=done`
(см. строку «Ручной перенос» ниже).
Автоматика меняет статус карточки только в этих случаях:

| Событие | Что происходит |
|---|---|
| Создание (`createGlobalTask`, `createRun`) | `status` = переданная колонка (только глобального канбана) или первая `kind=backlog` |
| Координатор запущен на прогоне (`setRunPty`) | закрытый прогон переоткрывается; карточка → `kind=in_progress` |
| Все подзадачи в `kind=done` (`closeFinishedRuns`), у прогона есть координатор | событие `run_done`, `runDoneAt`; прогон **не закрыт**, карточка остаётся `kind=in_progress`: координатор решает, нужна ли новая работа. Повторного `run_done` нет, пока стоит `runDoneAt` |
| Все подзадачи в `kind=done`, координатора не было (глобальную завёл человек) | `closedAt`, событие `run_done`, карточка → **`kind=review` («Проверка»)**. У «Входящих» — без события (нет координатора) и сразу `kind=done` |
| После `run_done` новая подзадача или подзадача ушла из done | прогон снова открыт (`reopenRun`: `runDoneAt` снят, непрочитанный `run_done` погашен), карточка в работе; следующий `run_done` — по завершении новой работы |
| `runs finish` после `run_done` (`finishRun`) | `closedAt`, `runDoneAt` снят, карточка → **`kind=review`**, нового события нет + `finishedAt`; с `--summary` — `Run.summary` (см. «Что сделал») |
| Координатор после `run_done` не жив: вышел без `runs finish`, упал, терминал закрыли, приложение перезапущено (`settleIdleRuns` из main: при выходе PTY и раз в 5 с) | `closedAt`, карточка → `kind=review`, нового события нет. Решение принимает человек: «Подтвердить» или «Вернуть в работу» с уточнением |
| `runs finish` на незакрытом прогоне без `run_done`, где все подзадачи в `kind=done` (`finishRun`) | закрытие (`closedAt`, `reopenedAt` снят, карточка → `kind=review`, `run_done` сразу помечен потреблённым) + `finishedAt` |
| Ручной перенос карточки в `kind=done` или `kind=review` (`moveGlobalTask`, UI и `global move`) | pending-запросы прогона отменяются; открытый прогон (и после `run_done`, пока координатор решал) закрывается: `closedAt`, `reopenedAt` снят, событие `run_done {runId, objective, manual: true}` (у «Входящих» — без события); подзадачи не трогаются. Уже закрытый — без изменений и без второго события (review → done = «Подтвердить», done → review — просто перенос). Координатор получает `run_done`, а `coordinatorsToClose` закрывает его терминал после короткой тишины, даже без `runs finish`. В done из backlog/in_progress — сразу «Сделано»: человек сам объявил задачу сделанной, проверка не нужна. «Входящие» в `kind=review` — ошибка: у них нет «Подтвердить» и «Вернуть в работу» |
| Ручной перенос карточки из `kind=done`/`kind=review` в backlog или in_progress (`moveGlobalTask`) | закрытый прогон переоткрывается (как ниже: `reopenedAt`, старые `run_done` погашены), карточка — в выбранную колонку. Координатор не запускается, уточнения нет — для этого «Вернуть в работу» |
| «Подтвердить» (`acceptGlobalTask`) | только из `kind=review` → `kind=done`; `closedAt` не меняется, событий нет |
| «Вернуть в работу» (`returnGlobalTask` + запуск координатора в main) | только из `kind=review`, не «Входящие», текст обязателен: уточнение → `returns`, прогон переоткрыт (`reopenRun`), карточка → `kind=in_progress`; см. «Проверка» |
| Ручное закрытие (`closeRun`, `runs close`) | `closedAt` без `run_done`; карточка из `kind=in_progress` → `kind=done` (явное закрытие, не результат работы — проверять нечего), из других колонок остаётся |
| Новая подзадача в закрытой глобальной (`createTask`) | прогон переоткрыт (`closedAt`/`finishedAt` сброшены); карточка из `kind=done`/`kind=review` → `kind=in_progress`, иначе остаётся |
| Запуск координатора (`setRunPty`) | закрытый прогон переоткрыт, карточка → `kind=in_progress` (в том числе из «Проверки») |

Переоткрытие ставит `reopenedAt`: пока ни одна подзадача не вошла в done после этого, прогон не
закрывается автоматически — иначе повторный запуск координатора на полностью готовой глобальной задаче
тут же получил бы `run_done`. Метку снимает первый вход подзадачи в done (`setStatus`).
Переоткрытие также гасит непотреблённые `run_done` этого прогона (`consumedBy: 'reopen'`) — новый
координатор не получит устаревший. Удаление колонки переносит и карточки
(`reassignColumn`).

`coordinatorsToClose` теперь берёт **последний** `run_done` прогона — прогон мог закрываться несколько раз.

### Почему «все подзадачи в done» не закрывает прогон

Раньше `closeFinishedRuns` закрывал прогон (`closedAt`, карточка на «Проверку») в тот же `commit`, где
последняя подзадача вошла в done. Но у координатора после `run_done` ещё есть решение: `answer_accepted` с
`decision` может потребовать новых задач (`skills/coordinator.md`, шаг 4). Карточка уходила человеку, пока
координатор работал. Поэтому точка перехода — конец работы координатора, а не состояние подзадач:
`run_done` только сообщает координатору, что подзадачи закрыты (`runDoneAt`), а на «Проверку» карточку ставит
его `runs finish` или его смерть.

Мёртвый координатор `runs finish` не пришлёт, а store не знает о PTY. Поэтому main вызывает
`settleIdleRuns(isAlive)` при выходе PTY координатора (`escalateAfterCoordinator` в `src/main/worker.ts`) и
раз в 5 с (`watchFinishedCoordinators` в `src/main/index.ts`, заодно после рестарта приложения, когда PTY
нет). Карточка уходит на «Проверку», а не в «Сделано»: подзадачи закрыты, но итог никто не подвёл. Человек
подтверждает или возвращает в работу с уточнением, и уточнение получит новый координатор. Координатор,
умерший раньше, чем закрылись подзадачи, ничего не меняет: `run_done` придёт по последней подзадаче, и
следующий `settleIdleRuns` поставит карточку на проверку. «Незакрывающийся» агент (Codex) без `runs finish`
закрывается страховкой `coordinatorsToClose` через `COORDINATOR_ABANDONED_MS`, `coordinatorsToClose`
учитывает и прогоны с `runDoneAt`. Живой Claude Code без `runs finish` держит карточку «В работе», пока
человек не перенесёт её сам или не закроет терминал.

Миграции нет: `runDoneAt` новое необязательное поле, прогоны без него ведут себя как раньше. Прогоны, которые
старый код уже поставил в «Сделано», там и остаются. Реальный случай такого закрытия (`run_mudz0dgc9e`, `closedAt`
совпал до миллисекунды с done последней подзадачи) — не старый формат данных. Main-процесс `pnpm dev` был запущен до
коммита «Проверки» (e7409b8) и не перезапускался: electron-vite пересобирает main только при перезапуске, и
работал старый `closeDone(run)` → done (см. «Грабли разработки» в `docs/architecture.md`).

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
  подзадачи идут туда же (дублей глобальной задачи нет). Проверки (`resumeObjective`, `src/main/coordinator-resume.ts` — без PTY, живость терминала передаёт `worker.ts`):
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
  (`closedAt`, карточка → «Проверка», новый `run_done`, `finishedAt`), и `coordinatorsToClose` закроет терминал
  Codex. То же, если новую подзадачу удалили. `runs finish` на прогоне с незавершёнными подзадачами или
  на свежем прогоне без подзадач — по-прежнему ошибка `run not closed … — дождись run_done`.

## Проверка

После закрытия по итогам работы (`runs finish`, выход координатора после `run_done` или автозакрытие без координатора) глобальная задача стоит в колонке
«Проверка» (`kind=review`): человек принимает результат. Состояние задаёт хранимый `Run.status` — механизм
запросов к человеку (`HumanRequest`) не используется: pending-запрос прогона сам переводит карточку в «Нужен
ответ», а у приёмки нет подзадачи для обязательного `taskId`. Карточка в «Проверке» (как и в done) в «Нужен ответ»
не поднимается (`globalDisplayStatus`), основное время в ней стоит. Уведомление — `run_done` («Подзадачи сделаны, скоро проверка: …»,
у `manual` — «Прогон завершён», `apps/desktop/src/main/notify.ts`).

- **Подтвердить** — IPC `globalTasks.accept(id)` → `TaskStore.acceptGlobalTask`: `kind=review` → `kind=done`,
  без событий. Не на проверке — ошибка «глобальная задача … не на проверке».
- **Вернуть в работу** — IPC `globalTasks.returnToWork(id, text, cols, rows)` → `ptyId` координатора
  (`returnToWork` в `apps/desktop/src/main/worker.ts`; шаги 1–2 — `returnGlobalTaskToWork` в `coordinator-resume.ts`):
  1. `TaskStore.returnGlobalTask(id, text)`: пустой текст, «Входящие», не на проверке — ошибка, терминалы не трогаются;
     иначе `returns.push({at, text})`, `reopenRun` (гасит старые `run_done`, ставит `reopenedAt`), карточка → in_progress;
  2. жив прежний координатор — его терминал закрывается (`killPty`). На «Проверке» так бывает после `runs finish`
     или ручного переноса карточки: `coordinatorsToClose` закрывает терминал только после
     `COORDINATOR_FINISH_GRACE_MS` тишины, а ввод человека в терминал сдвигает отсчёт. Отказ в возврате в это
     окно оставлял человека без поля для уточнения. Без функции закрытия (`stop`) `returnGlobalTaskToWork` по-прежнему
     отказывает «координатор … ещё завершается», стор не меняется;
  3. повторный запуск координатора (`startCoordinator(..., runId)`), как `globalTasks.startCoordinator`.

  Упал запуск после шага 2 — карточка остаётся «В работе» с уточнением, отката нет: «Запустить координатора»
  подхватит его из `Run.returns`. Отдельного события координатору нет — старый уже завершился, новый получает
  уточнение в цели: `resumeCoordinatorObjective(goal, subtasks, returns)` добавляет блок «Уточнение после
  проверки: …» (`COORDINATOR_RETURN_HEADING`) с последним уточнением полностью и прошлыми списком — **даже без
  подзадач**. Раздел «Повторный запуск» `skills/coordinator.md` велит считать уточнение новой работой; если
  координатор решил, что работы нет, `runs finish` снова ставит карточку на проверку.
- **Что сделал** — блок на вкладке «Итог и цель» экрана глобальной задачи, на «Проверке» и в «Сделано» (`GlobalOverview.tsx`, выбор текста —
  `globalDoneReport` в `renderer/src/globalDoneReport.ts`). Источник — итоговая сводка координатора
  `orca-board runs finish --summary "..."` (или `--summary-file`, markdown): `finishRun` сохраняет её в
  `Run.summary = {at, text}` (`GlobalTask.summary`), рендер — `Markdown.tsx`. Хранится **одна, последняя**:
  непустая сводка следующего `runs finish` (повторный запуск, возврат с проверки) заменяет прежнюю, пустая или
  её отсутствие прежнюю не трогает. Поэтому `skills/coordinator.md` велит в повторном запуске писать итог по
  глобальной задаче целиком (прежняя — `summary` в `global get`). Раньше сводка жила только в терминале
  координатора и терялась при его закрытии. Фоллбэк — сделанные (`kind=done`) подзадачи со сводкой последнего
  запуска воркера: когда сводки нет (старый координатор или main, ручной перенос, координатор умер до
  `runs finish`) или она старше последнего возврата (`returns`) — описывает прошлый заход. Новый IPC не нужен:
  поле едет в снапшоте вместе с `Run`; у старого main его нет — renderer показывает фоллбэк.
- CLI для приёмки нет намеренно: подтверждать — дело человека, не координатора. Перенос скриптом —
  `global move --status <id колонки review|done>` по правилам таблицы выше.
- **Совместимость.** Миграции `Run` нет: до «Проверки» глобальная задача в `review` стоять не могла (старый
  `migrateGlobalTasks` сводил её к in_progress), старые закрытые остаются в «Сделано». Откат на старую версию
  сведёт `review` к in_progress — данные не теряются, `returns` просто игнорируется. `Run.summary` тоже без
  миграции: поле необязательное, старые прогоны без него открываются с фоллбэком «Что сделал».

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
  typeId?: string            // = Run.typeId; нет — «Входящие» или прогон до типов (тип проекта по умолчанию)
  typeTitle?: string         // название типа из снимка Run.taskType; живое — из библиотеки по typeId
  startedAt?: number         // = Run.startedAt; нет — ещё не была «В работе» (или карточка от старого main)
  createdAt: number
  updatedAt: number          // правка карточки
  activityAt: number         // max(updatedAt, updatedAt подзадач) — «время» на карточке
  closedAt?: number          // закрыт: runs finish / выход координатора после run_done / ручное закрытие
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
  returns?: { at: number; text: string }[] // уточнения при возвратах с «Проверки» (= Run.returns)
  summary?: { at: number; text: string }   // итоговая сводка координатора, markdown (= Run.summary, runs finish --summary)
  statusHistory?: StatusChange[] // копия Run.statusHistory: хранимые колонки (без вычисляемого needs_input); нет — старый main
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
- **Внутри глобальной задачи** (`variant="line"`: шапка экрана подзадач `GlobalTaskHeader.tsx`, вкладка «Итог и цель» и модалка
  `GlobalTaskModal.tsx`) — два подписанных времени: «В работе: ⏱ 1 ч · Сумма подзадач: ⏸ 3 ч». Основное
  неизвестно — только «Сумма подзадач: …».

Чистые функции для renderer (без IPC): `toGlobalTasks(runs, tasks, columns, requests?)`,
`toGlobalTask`, `globalTaskProgress`, `globalSubtasksTime`, `globalSubtasksDuration`, `globalOwnDuration`,
`globalDisplayStatus`, `globalTaskInProgress`, `globalTaskTitle`, `isPendingRequest`, `pendingRequestsOf`, `hasPendingRequest`,
`INBOX_TITLE` — экспортируются из `@orca-board/core`. Без `requests` `waiting` = 0.
Живой UI может строить карточки из `board:changed` (`snapshot.runs` + `snapshot.tasks` + `snapshot.requests`) без лишних запросов.

### Смена типа

Тип задаёт роли, граф и правила прогона, поэтому меняется только **до начала работы** — иначе идущие подзадачи
остались бы с ролями и этапами старого типа. Правило — чистая `runTypeLockReason` / `canChangeRunType`
(`packages/core/src/global-tasks.ts`, её же зовёт renderer): можно, если это не «Входящие», нет `startedAt`
(ни разу не была в `kind=in_progress`), не запускался координатор (`coordinatorPtyId`), нет подзадач и карточка
в колонке `kind=backlog`. Возврат из работы в бэклог тип не размораживает — `startedAt` остаётся.
`TaskStore.changeGlobalTaskType(id, type)` пересобирает `typeId`, `taskType` и `workflow` через `runTypeFields`, как при
создании (граф старого типа не остаётся, даже если у нового снимка графа нет); тип берёт main из библиотеки проекта
(`projects.runType`). Запрещённый случай — ошибка `тип глобальной задачи «…» (run_…) нельзя сменить: <причина>`.
CLI этой команды нет: координатор тип не меняет.

### IPC — `window.orca.globalTasks` (активный проект; типы — `apps/desktop/src/shared/ipc.ts`)

| Метод | Канал | Результат | Ошибки |
|---|---|---|---|
| `list()` | `globalTasks:list` | `GlobalTask[]` в порядке создания (нет проекта → `[]`) | — |
| `get(id)` | `globalTasks:get` | `GlobalTask` | `run not found` |
| `create({title?, description?, status?, priority?, typeId?})` | `globalTasks:create` | `GlobalTask` | нет ни названия, ни описания; неизвестная колонка; колонка не глобального канбана; неизвестный приоритет; тип не найден или недоступен проекту (`Project.taskTypeIds`). Без `typeId` — тип проекта по умолчанию |
| `update(id, {title?, description?, priority?})` | `globalTasks:update` | `GlobalTask` | пустой патч; пустое название; неизвестный приоритет (карточка не меняется) |
| `changeType(id, typeId)` | `globalTasks:changeType` | `GlobalTask` | тип не найден или недоступен проекту; тип сменить нельзя (`runTypeLockReason`, см. «Смена типа») |
| `move(id, status)` | `globalTasks:move` | `GlobalTask` | неизвестная колонка; колонка не глобального канбана (ready / needs_input / custom) |
| `remove(id, {cascade?})` | `globalTasks:remove` | `{deleted, tasks: string[]}` | есть подзадачи без `cascade`; подзадача с живым dispatch; жив координатор |
| `tasks(id)` | `globalTasks:tasks` | `Task[]` только этой глобальной | `run not found` |
| `createTask(id, {title, spec?, deps?, roleId?})` | `globalTasks:createTask` | `Task` (`runId = id`) | пустое название; роль (`pickRole`); deps из другой глобальной; `run not found` |
| `startCoordinator(id, cols, rows, images?)` | `globalTasks:startCoordinator` | `ptyId` | см. «Повторный запуск» |
| `accept(id)` | `globalTasks:accept` | `GlobalTask` | не на проверке; `run not found` |
| `returnToWork(id, text, cols, rows)` | `globalTasks:returnToWork` | `ptyId` координатора | пустой текст; «Входящие»; не на проверке; ошибки запуска (см. «Проверка»). Живой прежний координатор — не ошибка: его терминал закрывается |

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
  `globalBoardColumns(Project.columns)` (backlog / in_progress / needs_input / review — «Проверка» / done). Счётчик колонки верхнего
  уровня — число карточек с `status === column.id` (`GlobalTask.status` уже сведён к видимой колонке).
- Карточка: `title`, `description` (кратко), статус, `progress.done/total`, `activityAt`.
- Внутренняя доска — `tasks(id)` или `snapshot.tasks.filter(t => t.runId === id)`; создание — только
  `createTask(id, …)`; drag подзадач — прежний `tasks.move`, drag карточек — `globalTasks.move`.
- Кнопка «Запустить» на карточке — `startCoordinator`, не `worker.start`. Живой координатор — терминал
  с `role: 'coordinator'` и `runId === id` в реестре.
- «Входящие» (`inbox: true`) — показывать как обычную карточку; координатора на ней не запускать.
- «Проверка» (`kind=review`): на карточке и в деталях (`GlobalTaskHeader`, низ сводки на «Итог и цель», `GlobalTaskModal`) — «Подтвердить»
  (`accept`) и «Вернуть в работу…» (модалка `ReturnGlobalModal` с обязательным текстом → `returnToWork` →
  терминал координатора); «Запустить координатора» на ней скрыта. «Вернуть в работу…» доступна всегда: при
  живом прежнем координаторе (`returnClosesCoordinator`) модалка предупреждает, что его терминал закроется
  (`returnHint`). Какие действия доступны — `globalTaskActions` (`renderer/src/globalReview.ts`), история уточнений —
  `GlobalReturns` (новые сверху; `GlobalOverview.tsx`). Старый preload без методов — «перезапустите приложение» (`globalReviewApi`),
  старый main («No handler registered») — то же, его отказ «ещё завершается» — «закройте терминал координатора
  или перезапустите» (`reviewErrorMessage`).

## Проверки

- `packages/core/src/global-tasks.test.ts` — CRUD, реальные колонки, колонки глобального канбана и сведение
  статусов из скрытых колонок, прогресс, изоляция, удаление,
  lifecycle (run_done, повторный запуск с новой подзадачей и без неё → `runs finish` закрывает прогон
  и терминал, ручное закрытие, «Входящие» без run_done), сохранение и миграция старого снапшота.
  «Проверка»: `run_done` при живом координаторе — карточка в работе, `runs finish` → review, «Подтвердить», «Вернуть в работу» (уточнения, погашенные
  `run_done`, повторный цикл), ручные переносы в/из review, «Входящие» не на проверке, рестарт с review.
- `packages/core/src/coordinator-close.test.ts` — последний `run_done` переоткрытого прогона.
- `apps/desktop/src/main/global-review.test.ts` — сквозной цикл «Проверки» на store + `resumeObjective` /
  `returnGlobalTaskToWork` без PTY: `run_done` → `runs finish` → review и закрытие терминала → возврат с
  уточнением (цель) → новая работа → review → «Подтвердить»; возврат при живом прежнем координаторе (окно grace
  после `runs finish` с активностью в терминале, ручной перенос на «Проверку») закрывает его терминал;
  возврат без новой работы; ручные переносы;
  рестарт; «Входящие». «Все подзадачи done при живом координаторе»: карточка в работе, новая подзадача
  переоткрывает прогон, смерть координатора (`settleIdleRuns`) и страховка `coordinatorsToClose` → review,
  ручной перенос, глобальная без координатора.
- `packages/core/src/answers.test.ts`, `requests.test.ts` — задачи-ответы, запросы к человеку: создание, решения,
  отмена, миграция, колонка «Нужен ответ» только по `pending`.
- `packages/core/src/prompts.test.ts` — встроенный промпт координатора содержит раздел «Повторный запуск»
  с исключением для `runs finish` и пунктом об «Уточнении после проверки»; `resumeCoordinatorObjective` добавляет
  список и ссылку при наличии подзадач, уточнение — всегда;
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
- `Board.tsx` (+ `BoardCard.tsx`, `MoveMenu.tsx`, `cardState.ts`, `boardView.ts`, `boardNav.ts`) — **локальная доска подзадач**
  открытой глобальной задачи, дизайн «A»: `docs/design/local-board/variant-ab.html`. Только renderer, модель и IPC не менялись.
  Гибкие колонки 232–340 px, «Сделано» свёрнуто в полосу 44 px (`orca.board.doneCollapsed`). Карточка: полоса состояния слева
  (`cardState`: работа / ждёт человека / ревью / сбой / ждёт зависимостей), бейдж приоритета, мета-строка «агент · роль · модель ·
  время», пилюля этапа воркфлоу (`Task.stage`) или гейта (`Task.gateFor`), зависимости одной пунктирной меткой, вместо кнопки
  действия — строка сути («? вопрос», «✕ Упал», «◉ Показ») и ссылка «в ленте ↑» (колбэк `onRevealInFeed?`, нет — нет ссылки). Задача из ленты без своей сути (например, «В работе» с запросом на решение) получает запасную «✋ Ждёт вас» (`cardEssenceFor`), чтобы у неё была ссылка.
  Тулбар: прогресс, фильтры «Все / Ждут вас / Проблемы / Мои роли», сортировка. «Ждут вас» = задачи, у которых есть пункт ленты
  (`attentionTaskIds(buildAttention(…))`, проп `waitingTaskIds`; счётчик и ссылка «в ленте ↑» — оттуда же). Клавиатура: стрелки, `Enter`, `M` (меню «Переместить в…», цифры 1–9), `S`. Названия этапов
  — опциональный проп `stageTitles` из `App` (`workflowForRun` → `wfNodeTitles`); старый main без `stage` — пилюли нет. Подробности
  — «UI: доска и «О проекте»» в `docs/architecture.md`.
- `GlobalTaskView.tsx` — экран открытой глобальной задачи: `GlobalTaskHeader` (шапка, поведение прежнее: крошки «← Глобальные
  задачи / название», описание, прогресс, приоритет, «Изменить», «Подтвердить» / «Вернуть в работу…», «Запустить координатора» /
  «Координатор работает»), лента «Ждут вас» и **вкладки «Доска · Итог и цель · Координатор · История»**. Лента и шапка стоят над
  вкладками и видны на любой из них; `Board` (только `task.runId === id`, прежние действия подзадач) лежит на вкладке «Доска» и занимает
  всю оставшуюся высоту (в низком окне прокручивается весь экран, доске остаётся минимум 380px). Доска **остаётся смонтированной** на
  других вкладках (скрыта `hidden`): фильтры и выделение не теряются, а события `feedLink` (`revealOnBoard`, `focusBoard`) находят
  получателя. У «Входящих» вкладок нет — одна доска.
  - **Вкладка по умолчанию** — `defaultTab` (`globalScreen.ts`): черновик (`backlog`, `ready`) → «Цель и детали»; работа и «Нужен ответ» →
    «Доска»; «Проверка» и «Сделано» → «Итог и цель» (сводка видна целиком и не пропадает после «Подтвердить»). Выбор человека
    запоминается по `global.id` в `localStorage` (`orca.gtab.<id>`) вместе с вкладкой по умолчанию на тот момент (`resolveTab`): он
    действует, пока эта вкладка по умолчанию та же; ушли на «Проверку» — выбор устарел, снова итог. Вкладка вычисляется при открытии
    задачи; живая смена статуса экран не переключает.
  - `GlobalOverview.tsx` («Итог и цель» после проверки, «Цель и детали» до неё): цель через `Markdown.tsx`; на «Проверке» и в «Сделано» слева
    сводка `GlobalDoneReportBlock` (без обрезки по высоте) и уточнения `GlobalReturns`, справа цель и детали (тип, приоритет, время,
    даты); **под сводкой на «Проверке» — «✓ Подтвердить» и «Вернуть в работу…»** (те же колбэки, что в шапке: `onAccept`, `onReturn` →
    `ReturnGlobalModal`). В черновике — «Перед запуском» (`launchChecklist`) и кнопка запуска координатора. Разметка одна колонка при ≤ 900px.
  - `CoordinatorPanel.tsx` и `GlobalHistory.tsx` — заглушки вкладок «Координатор» и «История» (состояние координатора и кнопки; лента событий
    появится позже). Всё, что они будут читать из снапшота (`coordinatorSessions`, `statusHistory`, `summary`), необязательно —
    renderer работает со старым main.
  - Стили — блок `.gt-*` в `styles.css`; шапка по-прежнему `.g-view-*`.
- Лента «Ждут вас» (`AttentionFeed.tsx`, данные — `attention.ts` → `buildAttention`) стоит на экране глобальной задачи
  между шапкой и доской и заменяет прежний блок `g-requests`. Одно место для всего, что ждёт человека в этой
  глобальной задаче, — одна строка карточек с прокруткой вбок (`scroll-snap`), высота ленты не растёт:
  сбой воркера («Воркер упал» / «Вышел без done» / «Воркер молчит», `↻ Перезапустить` / «Терминал»), вопрос воркера
  (варианты, ★ у совета, свой ответ), показ / решение этапа `human` («Смотреть и решить» — подробности с `ShowcaseBlock`
  под лентой), готовый ответ («Прочитать / Принять / Уточнить…») и задача, ждущая ревью («Открыть / Принять / Вернуть…»).
  Цвет левой кромки — вид пункта, но вид всегда подписан текстом (`attentionLabel`). Порядок: сбои, вопросы, показ /
  решение, ответы, ревью; внутри вида старые сверху. Пункты берутся из pending-запросов глобальной задачи
  (`pendingRequestsOf`, тот же фильтр, что у Инбокса, — после ответа пункт пропадает из обоих) и из состояния подзадач.
  **Без дублей:** вопрос, по которому есть pending-запрос (`questionId`), — один пункт (запрос); эскалация-запрос и
  сбой той же задачи — один пункт; готовый ответ / ревью не дублируют pending-запрос задачи. Вопрос без запроса (ждёт
  координатора) — свой пункт, отвечает `questions.answer` (в карточке — тот же `RequestCard` через `questionAsRequest`);
  готовый ответ и ревью без запроса решают `review.accept` / `review.reject`, перезапуск — `worker.start`. Новых IPC нет:
  колбэки `App` пробрасываются в `GlobalTaskView` (`onAnswerQuestion`, `onAcceptTask`, `onRejectTask`, `onStartTask`).
  «Свернуть» сжимает ленту в полосу-сводку «Ждут вас 4 · 1 сбой · 2 вопроса …»; выбор — в `localStorage`
  (`orca.attention.collapsed`), без выбора в узком окне (≤ 900 px) при 4+ пунктах лента свёрнута. Пунктов нет —
  ленты нет совсем. Сводка «3 сбоя · 5 вопросов …» видна только у свёрнутой ленты (макет). Список пунктов считает `App` (`buildAttention`) и
  отдаёт и ленте (`GlobalTaskView`, проп `attention`), и доске (`waitingTaskIds`): фильтр «Ждут вас» на доске, его счётчик и
  ссылка «в ленте ↑» берут одни и те же задачи, второго определения «ждёт человека» нет (`waitsForYou` удалён). Числа равны, пока
  у задачи один пункт; если пунктов больше, чем задач (два запроса у одной), счётчик ленты считает пункты, фильтр — задачи, а
  подсказка к счётчику ленты (`attentionCountTitle`) это объясняет.
  **Связка ленты и доски** (`feedLink.ts` — события окна: лента и доска соседи и не импортируют друг друга): «в ленте ↑» на
  карточке → `revealInFeed(taskId)` — лента разворачивается (выбор «свёрнуто» в `localStorage` не меняется), прокручивается к
  первому пункту задачи (`feedItemOfTask`), подсвечивает его на 2,5 с и берёт в фокус; имя задачи в карточке ленты →
  `revealOnBoard(taskId)` — `Board` выделяет карточку (`onSelect` → `selectedId`), сбрасывает фильтр в «Все», если он её прятал,
  прокручивает к ней и берёт в фокус. Прокрутка плавная, кроме `prefers-reduced-motion` (`scrollBehavior`).
  **Клавиши экрана** — один обработчик в `GlobalTaskView`, решение `screenKey` (`hotkeys.ts`): **Esc** — назад к общей доске,
  **G** — фокус в ленту (развернув её), а с фокусом в ленте — обратно на доску (выделенная карточка или первая). Не срабатывают
  в полях ввода (`input`, `textarea`, `select`, `contenteditable`), при открытой модалке, с модификаторами и если клавишу уже
  обработал кто-то ближе (`defaultPrevented`: меню «Переместить в…», Esc в подробностях ленты и в поле «Уточнить»). Внутри
  ленты — стрелки / Home / End между карточками. G работает и в русской раскладке (проверка по `code`). **G с фокусом в ленте
  сначала открывает вкладку «Доска»** (синхронно, `flushSync`), потом отдаёт фокус карточке; так же имя задачи в карточке ленты
  (`revealOnBoard`) открывает доску. **Вкладки — `tabKey`** (тот же обработчик): **Alt+1…4** везде, где не идёт ввод и нет модалки; голые
  **1…4** — только вне доски, ленты и меню «Переместить в…» (`.board-wrap`, `.attn`, `[role="menu"]`): там цифры принадлежат им
  (M → 1–9). Цифры — по `code` (`Digit1…`), так что работают в русской раскладке и с Alt на macOS. Стрелки ←/→, Home/End на
  вкладке (`stepTab`) переключают соседнюю.
- `GlobalTaskModal.tsx` — создание (`globalTasks.create`, колонка глобального канбана и приоритет на выбор, по умолчанию
  «обычный») и правка (`globalTasks.update`, только изменённые поля, приоритет — тоже). У «Входящих» приоритета в модалке нет.
  При создании — селект «Тип задачи»: типы, доступные проекту (`availableTypes`), предвыбран тип проекта по умолчанию
  (`projectDefaultTypeId` — то же правило, что в main), под ним описание типа и предупреждение, если у какой-то роли
  типа агент в проекте выключен или не установлен (`rolesWithDisabledAgent`: тип создастся, но воркер этой роли не
  стартует). При правке, пока задача не начата (`typeChangeOptions` в `renderer/src/globalTypeChange.ts` → `canChangeRunType`),
  тип — такой же селект (текущий тип вне проекта остаётся первым вариантом); выбранный другой тип уходит в
  `globalTasks.changeType` (`changeTypeApi`: старый preload/main → «перезапустите приложение»). После старта — только бейдж.
  Старый main (прогоны в снимке без `priority`, `runsKnowPriority` в `taskPriority.ts`) приоритет не сохранит:
  вместо выбора — текущий приоритет и просьба перезапустить приложение, в `create`/`update` поле не уходит.
  «Новая подзадача» в шапке открыта задачей → `NewTaskModal` с зависимостями только из её подзадач и приоритетом (по умолчанию «обычный») → `globalTasks.createTask`.
- Тип задачи в renderer — `renderer/src/taskTypes.ts`. `App` грузит библиотеку (`loadTaskTypes` → `taskTypes.list`)
  вместе со списком проектов и после закрытия «Настроек». Роли задачи — `rolesForRun(task.runId, runs, project, state)`
  через общее правило `resolveRunType` (core): тип прогона из библиотеки → снимок `Run.taskType` → тип проекта по
  умолчанию. Так подписаны роли на доске подзадач (`Board`), в `TaskModal`, в «Новой подзадаче» (выбор роли —
  только из ролей типа этой глобальной задачи) и в списке терминалов (координатор — по `runId` терминала,
  ассистент — тип библиотеки по умолчанию). Название типа — чип на карточке `GlobalBoard` и на экране
  `GlobalTaskView` (`globalTypeTitle`: из библиотеки, тип удалён — из снимка; у «Входящих» чипа нет).
  Старый main/preload без `window.orca.taskTypes` (`pnpm dev` после HMR) — `state = null`: встроенные роли
  (`DEFAULT_ROLES`: ролей у проекта больше нет), без селекта и чипов, `typeId` в `create` не уходит; разделы «Типы
  задач» просят перезапустить приложение.
- «Добавить репозиторий» (`projectAdd.ts` → `ProjectTypeModal`): после выбора папки — тип задач по умолчанию нового
  проекта (`projects.detectTaskType` угадывает по файлам, `projects.add(typeId, path)`); копии настроек нет, проект
  ссылается на тип. Старый main — прежний `projects.add()` без модалки.
- Открытая глобальная задача — в `ProjectView.globalId` (по проекту, `localStorage` `orca.global.<projectId>`):
  переживает перезагрузку; id, которого нет в снимке активного проекта, показывает общую доску.
- Клавиатура: карточка фокусируется Tab, Enter/Space открывает; на экране задачи фокус на «назад», Esc (вне полей и
  модалок) возвращает, фокус — обратно на карточку. Повторный клик по вкладке «Канбан» тоже возвращает.
