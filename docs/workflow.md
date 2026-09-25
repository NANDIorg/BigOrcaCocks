# Воркфлоу задачи

Этот документ описывает внутренний граф приложения. **Два формата.** Версия 2 (`WORKFLOW_VERSION = 2`) — граф
**глобальной задачи**: позицию на графе хранит `Run.stage`, подзадачи по графу не ходят; её контракт — в разделе
«Воркфлоу глобальной задачи (версия 2)» ниже. Версия 1 — граф **по подзадачам**: каждая рабочая подзадача идёт по нему
сама (`Task.stage`); так работают только старые прогоны (без `Run.workflowScope`) и «Входящие», а всё, что описано после
раздела о версии 2 (кроме особо отмеченного), — их движок. Командный процесс разработки
самого orca-board — [git-flow.md](git-flow.md). Нода `merge` версии 1 сливает ветку задачи в ветку её глобальной задачи
(«Ветка глобальной задачи» в `docs/architecture.md`), а без неё — в текущую ветку root, если та не защищённая. Это
локальный мерж: он не создаёт GitHub PR, не проверяет CI и не заменяет ревью второго разработчика.

Воркфлоу версии 1 — граф этапов, которые проходит **одна рабочая задача** после того, как её создал координатор:
работа → проверки → мерж → конец. Граф хранится в **типе задачи** (`TaskType.settings.workflow` в
`userData/projects.json`, без него — `defaultWorkflow(roles)` по ролям типа); тип выбирается у глобальной задачи, и
новый прогон получает снимок графа своего типа (`Run.workflow`). Роли этапов (гейт, «Работа») берутся из типа прогона
(`WorkflowDeps.run(runId)` в `apps/desktop/src/main/workflow.ts` → `projects.resolveRun`). Исполняет граф приложение
детерминированно: координатор декомпозирует цель и запускает первых воркеров, дальше задачу ведёт приложение.

Код: модель, валидация и функция перехода — `packages/core/src/workflow.ts`; позиция задачи и переходы —
`packages/core/src/store.ts` (`advanceStage`, `enterWork`, `blockStage`, `requestApproval`); эффекты —
`apps/desktop/src/main/workflow.ts`; git-часть мержа — `mergeTaskBranch` в `apps/desktop/src/main/review.ts`.
Подробности по слоям — `docs/architecture.md` («Воркфлоу: модель», «Воркфлоу: состояние в store», «Ревью и мерж»).

## Воркфлоу глобальной задачи (версия 2)

Позиция на графе хранится в **глобальной задаче** (`Run.stage {nodeId, visits}`, `Run.stageHistory`), а не в подзадачах.
Каждая нода отвечает за свою часть; **координатор — один на всю глобальную задачу и только диспетчер агентов на этапах
`work`**: он не проверяет, не сливает и не решает, куда идти по графу. Подзадача этапа идёт по **пути подзадачи**
(`work.subflow`, раздел «Путь подзадачи»); без него — путь по умолчанию: воркер → `done` → автомерж в ветку глобальной задачи
(конфликт — запрос человеку). Раздел описывает контракт слоя `packages/core`, движок main (`apps/desktop/src/main/workflow-run.ts`,
«Движок main, промпты и skills прогона»), skills и промпты, сокет/CLI (`docs/architecture.md`) и renderer («Renderer» ниже).
Сквозной сценарий — `apps/desktop/src/main/workflow-run-e2e.test.ts` («Проверка сквозным тестом» ниже).

### Кто за что отвечает

| Нода | Отвечает за | Исполнитель | Роль координатора |
|---|---|---|---|
| `start` | вход в граф | приложение | — |
| `work` (роли `roleIds?`, инструкции) | результат этапа: анализ, макеты, код, тесты | **агенты ролей ноды**, по одному на подзадачу; роли необязательны | по событию `stage_started` создаёт подзадачи по инструкциям ноды — роль каждой из `roleIds` (нет ролей — из рабочих ролей типа по их описаниям) — и запускает их; закрывает этап командой `stage finish` |
| `ask` (роль R) | вопросы человеку | агент роли R, **одна** задача, её создаёт приложение | нет |
| `gate` (роль R) | проверка **ветки глобальной задачи целиком** против `RunGit.base` | агент-проверяющий роли R, одна задача (`gateFor.runId`), её создаёт приложение | нет |
| `human` | решение человека | человек: approval уровня прогона, карточка на «Проверке» | нет |
| `condition` | ветвление: `attempts` по `Run.stage.visits`; `role` не бывает | приложение | нет |
| `git` | `commit` / `push` в worktree глобальной задачи (`RunGit.worktree`) | приложение | нет |
| `merge` | слияние ветки глобальной задачи в `RunGit.base` локально через временный worktree; в защищённые ветки — нет (`workflow_blocked` с подсказкой) | приложение (`execFileSync('git', …)`) | нет |
| `end` | прогон закрыт, карточка в «Сделано», координатору `run_done` | приложение | выходит по `run_done` |

Решения о переходах принимает **приложение**: этап закрывается, когда закрыты его подзадачи, а исход ноды (`accept`, `ok`, …)
приходит от проверяющего, человека или git.

### Модель

- `Run.workflowScope: 'run'` — воркфлоу идёт по глобальной задаче. Ставится при создании: граф версии 2, тип задачи без
  своего графа (граф даст `runWorkflow` — граф типа или `defaultWorkflow`). Нет поля — прогон старого формата или «Входящие»;
  так же остаются прогон без типа и графа и прогон с графом версии 1. Приложение всегда создаёт прогон с типом (`runTypeInput`),
  поэтому его новые прогоны получают `'run'`. `changeGlobalTaskType` пересчитывает поле. `migrateGlobalTasks` старые прогоны не трогает.
- `Run.stage: WfStage` — нода и `visits` (заходы в каждую ноду, `start` тоже: `{start: 1, work: 1}`); `Run.stageHistory: StageChange[]` —
  вход в этап (`start` в историю не пишется, `end` — да; повтор эффекта после `workflow_blocked` запись не дублирует): нода, название, время, исход, `visit`, `commit` (коммит ветки прогона на входе — от него считается дифф этапа; ставит main),
  `summary` (сводка `stage finish`). Не длиннее `STATUS_HISTORY_LIMIT`.
- `Run.stageInput {feedback?, decision?, answers?}` — что человек или проверка сказали при входе в текущую «Работу» целиком
  (в `stage_started` текст обрезан). Сбрасывается при каждом переходе. `Run.stageTasksDoneAt` — метка «все подзадачи этапа закрыты»
  (аналог `runDoneAt` старого движка). `Run.returns` пополняется замечаниями `reject` (и «Вернуть» человека).
- `Task.stageOf {nodeId, visit}` — подзадача этапа; `visit` — какой по счёту заход в `work` (после `reject` начинается новый: задачи
  прошлых заходов в счёт закрытия не идут). `Task.gateFor {nodeId, taskId?, runId?}` — задача-проверка: `taskId` (ветка рабочей задачи,
  движок подзадач) или `runId` (ветка глобальной задачи), ровно одно из двух.
- `HumanRequest.taskId` необязателен: approval уровня прогона (`kind: 'approval'`, `nodeId` ноды `human`) идёт без задачи и
  решается по `runId`. Остальные виды запросов (`question`, `answer`, `escalation`) задачу имеют всегда.
- `GlobalTask` отдаёт `workflowScope`, `stage` и `stageHistory` (копии).

### События

| Событие | Когда | Payload |
|---|---|---|
| `stage_started` | граф вошёл в этап `work` — координатору набрать агентов | `{runId, nodeId, title, roleIds, visit, instructions?, feedback?, decision?, answers?}`, `roleIds` — роли ноды, пустой массив = любые рабочие роли типа; текст длиннее `EVENT_ANSWER_LIMIT` обрезан с `…Truncated`, целиком — `TaskStore.runStage` |
| `stage_tasks_done` | закрыты все подзадачи текущего захода `work` (и есть хотя бы одна) | `{runId, nodeId}`; приходит один раз, новая подзадача или подзадача, ушедшая из done, снимает метку и гасит непрочитанное событие |
| `stage_changed` | любой переход | `{runId, from?, to, outcome, nodeType?, title?}` (без `taskId`) |
| `workflow_blocked` | дальше идти нельзя: нет перехода, роль этапа удалена, слияние в защищённую ветку, git настроен неверно | у прогона — `{runId, nodeId?, reason}` **без `taskId`**; у движка подзадач по-прежнему `{taskId, …}` |
| `run_done` | граф дошёл до `end` (для прогона с `workflowScope: 'run'`) | `{runId, objective, nodeId}`; старый смысл «все подзадачи закрыты» относится только к старым прогонам |
| `request_created`, `request_resolved` | approval прогона | `runId` вместо `taskId`; у `request_resolved` — `decision` (текст «Принять»/замечания «Вернуть», обрезан) |

`consumeEvents(..., runId)` находит события прогона по `payload.runId`.

### Store (`packages/core/src/store.ts`)

Чистые функции переходов — `startRunStage`, `nextRunStage`, `runStageAction` (`workflow.ts`): те же `startStage`/`nextStage`/`stageAction`
в контексте `scope: 'run'` (`work` → действие `start_stage`, `ask` → `create_ask`, `condition: role` — `blocked`). Состояние двигает store:

| Метод | Что делает |
|---|---|
| `enterRunStage(runId, opts)` | первый вход из старта; фиксирует граф снимком (`Run.workflow`), если его не было. Граф уже начат — позицию не меняет, отдаёт действие текущей ноды (повтор эффекта после рестарта) |
| `advanceRunStage(runId, outcome, opts)` | переход по исходу текущей ноды; `opts.feedback`/`decision`/`answers` уходят в `stage_started` и `Run.stageInput`, `opts.commit` — в историю. На `end` закрывает прогон и шлёт `run_done` |
| `finishStage(runId, {summary, …})` | закрыть этап `work` (`stage finish`): все подзадачи текущего захода в done и их хотя бы одна, иначе ошибка с подсказкой; сводка — в `stageHistory` и `Run.summary` |
| `settleIdleStages(isAlive, fallback)` | страховка: координатор мёртв, а закрытые подзадачи ждут `stage finish` — этап закрывается без сводки (аналог `settleIdleRuns`) |
| `blockRunStage(runId, reason)` | `workflow_blocked` по `runId`: эффект не выполнился (слияние в защищённую ветку, проверка не создалась) |
| `requestRunApproval(runId, {nodeId, title, body?, showcaseDispatchId?})` | approval без задачи; ждущий не дублируется |
| `runStage(runId, fallback)` | где стоит прогон и что знает координатор: роль, инструкции, показ, `feedback`/`decision`/`answers` целиком, подзадачи захода |

Каждый метод возвращает `{run, action}` — `WfAction` ноды, куда пришли: **эффекты выполняет main**, store их не запускает.
`opts` — `RunStageOptions`: роли проекта сейчас (`roleIds`: удалили роль этапа — `blocked` с причиной), запасной граф типа и `commit`.
Колонка карточки: `human` — «Проверка» (`kind=review`), `end` — «Сделано», остальные ноды — «В работе»; `WfNode.column` переопределяет, если это
колонка глобального канбана. «Нужен ответ» карточку поднимают pending-запросы прогона (эскалации, вопросы `ask`) на нодах «В работе»; на `human` она уже в «Проверке» и не поднимается
(`globalDisplayStatus`: карточка в `review`/`done` в `needs_input` не идёт) — ждущий approval виден в Инбоксе и на самой карточке.

`TaskStore.createTask` в прогоне с `workflowScope: 'run'`:
- пока граф не начат (`Run.stage` нет) ограничений нет — человек может заготовить подзадачи, к этапу они не относятся;
- граф идёт, задача получает `stageOf` текущего захода. Роль зависит от `roleIds` ноды `work`: **ролей нет** — подойдёт любая рабочая роль типа (не
  `coordinator`/`assistant` и не роль `gate` графа), а без `roleId` роль остаётся на выбор вызывающему (координатор — по описаниям ролей); **роли есть** — только из списка,
  иначе ошибка `роль «X» не разрешена на этапе «T»: его ведут агенты ролей «R1», «R2»`, а если роль в списке одна, она берётся, когда `roleId` не передан
  (`TaskStore.stageDefaultRole(runId)` — main подставляет её в `task create` без `--role`). Вне этапа `work` — ошибка
  `подзадачи создаются только на этапе «Работа» … дождись stage_started`. Существование роли в типе и включённость её агента проверяет main (`pickRole`);
- проверки и вопросы этапов создаёт приложение: `gateFor {runId, nodeId}` или явный `stageOf` (задача-вопрос `ask`) — правило роли/этапа их не касается.

По графу прогона подзадачи не ходят: у подзадачи со `stageOf` на ноде `work` своя позиция `Task.stage` — на пути этой ноды («Путь подзадачи»), а для
проверок (`gateFor`), задач-ответов и подзадач вне этапа «Работа» (в том числе задач этапа `ask`) `advanceStage` — по-прежнему ошибка, `enterWork` — пустое действие.
Обязательный показ ноды `work` (`showcase.required`) наследуют подзадачи этапа: `taskWorkStage`/`taskStageNode` берут ноду по `Task.stageOf`, а на пути — ноду пути
с наследованием заголовка, инструкций, показа и ролей внешней «Работы» (своим считается только явный `title` ноды пути). Автозакрытие старого движка (`closeFinishedRuns`, `run_done` «все подзадачи
в done», `settleIdleRuns`) для прогонов этого формата не работает: конец этапа — `stage_tasks_done`, конец прогона — вход в `end`.
`finishRun` (`runs finish`) для такого прогона до `run_done` — ошибка с подсказкой про `stage finish`, после — просто сигнал «закончил» (`finishedAt`).
«Подтвердить» и «Вернуть в работу» на карточке (`acceptGlobalTask`, `returnGlobalTask`) решают ждущий approval прогона (`resolveRequest`: accept / reject
с замечаниями); переход по нему делает main.

### Дефолтный граф и заготовки типов

```
start → «Реализация» (work, без роли) ──next──▶ «Ревью» (gate, reviewer; если роль есть) ──accept──▶ «Проверка человеком» (human) ──accept──▶ end
              ▲                                        │                                                │
              └────────────reject──────────────────────┴──────────────reject───────────────────────────┘
```

`defaultWorkflow(roles)`: «Реализация» без роли (координатор сам выбирает роли подзадач из рабочих ролей типа — одна нода покрывает и фронт, и бэк); ревью агентом — только если есть `reviewer`.
Слияния в базовую ветку в дефолте нет — это решает человек графом типа. Конструктор `pipelineWorkflow(checks, {roleIds | work})` строит
старт → «Работа» (одна или несколько по порядку) → проверки → «Проверка человеком» → конец; финальную `human` (id `check`) он добавляет, если последняя проверка не
`human`; отказ любой проверки ведёт в **последнюю** «Работу». Название финальной проверки — «Проверка человеком», а не «Проверка»: так называется нода
`gate` по умолчанию, и перевод встроенных названий узнаёт их по тексту. Заготовки типов собраны им же: «Фронтенд и бэкенд» — одна нода «Работа» с ролями
`frontend` и `backend` (`roleIds`), координатор раздаёт подзадачи обеим; условий по роли `onlyForRoles` больше нет.

### Валидация графа версии 2

`validateWorkflow` (ошибки): у `ask` обязательна роль (`askNoRole`); у `work` роли необязательны, но `roleIds` — список id (`workRolesNotList`), а каждая роль — существующая рабочая роль типа (`roleMissing`, `roleService`; выключенный агент — предупреждение `roleAgentOff`); `condition: role` (`conditionRoleRun`) и `git` с
`create_branch`/`checkout` (`gitRunOperation`) запрещены; прочие правила (порты, пути к концу, роли, колонки, git-поля) прежние. Предупреждение
`noHumanBeforeEnd`: есть путь от старта к `end` без ноды `human` — прогон уйдёт в «Сделано» без человека (граф без `human` разрешён). Предупреждение
`acceptWithoutMerge` убрано: слияние в базу — необязательная нода графа. Тексты проблем — `WF_ISSUE_TEXTS` и i18n `config.wf.issue.*`. Если в графе есть `git push`, авто-push
при закрытии прогона (`RunBranchSync`) выключается — эту часть делает main.

### Путь подзадачи (`work.subflow`)

У ноды `work` графа версии 2 необязательное поле `subflow: WfSubflow {nodes, edges}` — **путь, который проходит каждая подзадача этапа**. Граф глобальной
задачи остаётся графом этапов, путь — второй уровень (глубина ровно 1: у ноды пути своего пути нет). Версии у пути нет — она у внешнего графа. Версию графа
поднимать не пришлось: граф без `subflow` исполняется как раньше, а старая сборка приложения такое поле молча пропустит и пойдёт путём по умолчанию.

```
Граф типа (этапы):   start → [Реализация] → gate «Ревью ветки» → human → merge → end
                                  │
                                  └─ путь подзадачи «Реализации»: start → work → gate(reviewer) ─accept→ merge ─ok→ end
                                                                                  └─reject→ work        └conflict→ human «Конфликт мержа»
```

**Путь по умолчанию** — `defaultSubflow()` (id `start`, `work`, `merge`, `conflict`, `end`, `e_<нода>_<исход>`): `work → merge`, `ok → end`, `conflict` → `human`
«Конфликт мержа» (`accept` → снова `merge`, `reject` → `work`). Это тот же путь, что прежде был зашит в движке прогона (автомерж подзадачи и approval «Конфликт мержа» с `SUBTASK_MERGE_NODE`); подзадача
без `subflow` у своей «Работы» ходит по нему. Каждый вызов возвращает новый граф.

**Семантика нод внутри пути** — как в графе по подзадачам («Кто в воркфлоу (версия 1)»), контекст `scope: 'subtask'`:

| Нода | В пути |
|---|---|
| `work` | воркер подзадачи. Без роли работает роль задачи (её выбрал координатор из `roleIds` внешней «Работы»), с ролью — смена роли |
| `gate` | проверка ветки **подзадачи** (`gateFor {taskId, nodeId}`) |
| `human` | approval на задаче (`HumanRequest.taskId`) |
| `merge` | ветка подзадачи → ветка глобальной задачи |
| `git` | только `commit`/`push` в worktree задачи (`create_branch`/`checkout` — ошибка `gitRunOperation`, как в графе прогона) |
| `condition` | `attempts` по `Task.stage.visits`; `role` **допустима** — у подзадачи роль есть |
| `ask` | **запрещён** (`subflowAskNotAllowed`; `stageAction` в scope `subtask` вернёт `blocked`): вопросы человеку — этап глобальной задачи |

Путь кончается `end` и значит «подзадача готова»; наружу у пути выходов нет, порты внешней `work` не меняются (`next`). Этап прогона закрывается, как раньше:
когда все подзадачи текущего захода дошли до `end` и стоят в kind=done — `stage_tasks_done`. Повторный заход во внешний этап (`reject` снаружи) даёт новые подзадачи, у каждой
путь с нуля.

**Store.** `taskWorkflow(task)` — граф подзадачи: путь ноды `stageOf.nodeId` (`{version: WORKFLOW_VERSION, ...(subflow ?? defaultSubflow())}`), если это рабочая подзадача
прогона с воркфлоу на ноде `work`; иначе — `runWorkflow(task.runId)`. `advanceStage`/`enterWork` работают по нему и передают `scope: 'subtask'`. `Task.stage` и `stageHistory`
подзадачи — позиция **внутри пути**, `Task.stageOf` — какой «Работе» путь принадлежит; `Run.stage` независим, стека позиций нет.
`taskWorkStage` (раздел «Этап» в промпте воркера) для ноды пути наследует у внешней «Работы» заголовок (`title`), инструкции, показ и роли: своим считается только явный `title`/`instructions`/`showcase`/`roleIds` ноды пути — у ноды пути из `defaultSubflow()` заголовка нет, и воркер по-прежнему видит «Этап: Реализация», а не «Этап: Работа». События `stage_changed` и
`workflow_blocked` идут с `taskId` и `runId`, как у графа версии 1. Исполняет путь прежний исполнитель по подзадачам (`main/workflow.ts`, `advanceStage`, `enterWork`) — **не
удалять**; как он подключён к движку прогона — «Путь подзадачи в движке main» ниже.

**Валидация.** `validateWorkflow` проверяет путь рекурсивно тем же кодом со `scope: 'subtask'` (`WfValidationContext.scope`). Проблема пути:
- `message` начинается с `WF_SUBFLOW_PREFIX` («нода «Реализация» → путь подзадачи: …»), `nodeId` — путь `<нода «Работа»>/<нода пути>` (`impl/rev`; проблема без ноды, например «нет Старта», —
  сама «Работа»), `edgeId` — с тем же префиксом, `WfIssue.subflowOf {nodeId, title}` — чей это путь (renderer переводит по `code` и добавляет префикс сам);
- в пути допустимо условие по роли, не предупреждаем про `noHumanBeforeEnd`; операции `git` те же, что в графе прогона.

Коды (`WF_ISSUE_TEXTS`, перевод — `config.wf.issue.*`): ошибки `subflowInvalid` (не граф), `subflowOnNonWork` (путь не у `work`), `subflowInTaskScope` (путь в графе версии 1), `subflowNested` (путь у ноды пути),
`subflowNoWork` (в пути нет достижимой `work`), `subflowAskNotAllowed`, `templateIdNotString` (`templateId` не непустая строка); предупреждения `subflowNoMerge` (из старта можно дойти до `end`, минуя `merge`: коммиты подзадачи
не попадут в ветку глобальной задачи) и `subflowDoubleReview` (`gate` есть и в пути, и дальше в графе — ветка проверяется дважды; на «Работе», без префикса). Остальные правила пути — обычные (порты, пути к концу, роли, циклы).

### Шаблоны нод (`WfNodeTemplate`)

«Свои ноды» — глобальная библиотека настроенных нод (`projects.json → nodeTemplates`, рядом с `taskTypes`; глобальная, потому что типы задач тоже глобальные). `WfNodeTemplate {id, title, description?,
node, updatedAt}`, где `node` — любая нода без `id`, `x`, `y`, кроме `start` (путь — только у `work`). **Вставка — копия** ноды в граф с `templateId` (`WfNode.templateId`): снимок прогона
(`Run.workflow`) остаётся самодостаточным, править или удалить шаблон можно без последствий для идущих задач; `templateId` нужен только редактору для «Шаблон изменился: обновить» и исполнителем
не читается. Версий у шаблона нет. Хранение и IPC — «Библиотека шаблонов» ниже, редактор — отдельная задача; контракт core — модуль `node-templates.ts` (без node-импортов: его читает renderer):

- `validateNodeTemplate(template, {nodeTitle?, scope?})` → `{errors, warnings}`: поля шаблона (`templateNoId`, `templateNoTitle`, `templateNotString`, `templateBadUpdatedAt`, `templateBadNode`, `templateNodeStart`) и сама
  нода — тем же `validateWorkflow` на образце «старт → нода → конец» (в том числе путь подзадачи). Роли шаблона против ролей проекта **не проверяются** (роли типа свои — ошибку роли даст вставка), служебная роль — ошибка;
  колонки, `attempts` на другие ноды и предупреждения о соседях («показ никто не увидит», «человек перед концом») не проверяются: они зависят от графа, в который шаблон попадёт. `scope: 'subtask'` — шаблон
  вставляют в путь подзадачи (там нельзя `ask` и вложенный путь).

**Библиотека шаблонов** (main: `ProjectManager.nodeTemplates / saveNodeTemplate / deleteNodeTemplate`, `main/projects.ts`; IPC `nodeTemplates:list|save|delete`, docs/architecture.md → «IPC»).
Порядок хранения — порядок показа. Загрузка без доверия к данным (`loadedNodeTemplates`): каждая запись проходит `validateNodeTemplate`, лишние `id`/`x`/`y` у ноды снимаются; негодная запись
(не объект, нет id, битая нода, повторный id) **пропускается** с предупреждением `StateWarning {kind: 'skipped'}` (`stateWarnings()`), остальные остаются, а не «нет библиотеки». Пропущенная запись из файла пропадёт
при ближайшей записи `projects.json`. Сохранение (`saveNodeTemplate`): без `id` — новый `tpl_<hex>`, существующий `id` заменяет шаблон на месте, `updatedAt` ставит main; негодный шаблон — `OrcaError`
`nodeTemplate.notSaved` с текстами проблем core (предупреждения не мешают), форма — `nodeTemplate.notObject|emptyId|emptyTitle`. Роли и колонки против типа задач при сохранении не проверяются — при вставке в граф.
Удаление (`deleteNodeTemplate`) — `nodeTemplate.notFound` для неизвестного id; вставленные копии в графах остаются, `templateId` у них становится «висячим».

### Миграция

- **Граф типа v1 → v2** (`migrateWorkflowReport(wf, roles)` → `{workflow, notes}`; `migrateWorkflow` — без замечаний): `merge` v1 снимается, входящие переходы идут по его `ok`
  (обычно в `end`), ноды, потерявшие вход («Конфликт мержа»), снимаются; `condition: role` снимается с переходом по `yes`; `git create_branch/checkout` снимаются с
  переходом по `ok`; роль `work` (`roleId`) переносится в `roleIds`, `work` без роли остаётся без роли и замечания не даёт (роль подзадач выберет координатор); `ask` без роли получает `defaultWorkRole(roles)` (нет `roles` — `developer`). Замечания (`WfMigrationNote`, по-русски) человеку показывает вызывающий код;
  если после миграции путь к концу идёт без `human`, замечание `noHumanBeforeEnd`. Граф будущей версии не трогается (`versionFuture`).
- **Графы сохранённых типов** мигрируют при загрузке `projects.json` (main: `migrateTypeWorkflows`, docs/architecture.md → «Типы задач»): граф v2 записывается в тип, а замечания
  миграции — в `TaskType.workflowNotes`, откуда их показывает редактор типа; исходный файл копируется в `projects.workflow-v1.bak.json`.
- **Идущие прогоны** без `workflowScope` доживают на движке подзадач со своим снимком `Run.workflow` (версия 1) — его миграция не касается. Прогон без снимка
  и «Входящие» берут граф типа: `TaskStore.runWorkflow` переводит его обратно в граф подзадач — `toTaskScopeWorkflow` (работа без роли, финальная «Проверка человеком»
  снимается, перед концом появляются `merge` и «Конфликт мержа»); типа с графом нет — `legacyDefaultWorkflow`. Прежние конструкторы остались как `legacyPipelineWorkflow` и
  `legacyDefaultWorkflow` (версия 1, `WORKFLOW_VERSION_TASK_SCOPE`).

### Движок main, промпты и skills прогона

Store двигает граф и возвращает `WfAction`, **эффекты выполняет main**: модуль `workflow-run.ts` со своими `RunWorkflowDeps` (store, корень репозитория,
`run(runId)` — роли и граф типа, `startWorker`, `isAlive`, `startCoordinator(runId)`, `gitSettings()`, `mergeTarget`). Подключение — `runWorkflowDeps` в `index.ts`.
Прогоны без `workflowScope: 'run'` идут прежним `workflow.ts`: `handleEvents` там пропускает задачи прогонов нового формата, а новый движок — старого. Решения проверки прогона в `workflow.ts` нет: `reviewAccept`/`reviewReject` для `gateFor.runId` бросают ошибку, единственный путь — `runGateDecision`.

**Промпты и skills.** Код — `packages/core/src/prompts.ts`, инструкции — `skills/coordinator.md` и `skills/worker.md`; проверки — `prompts.test.ts`. Единственный источник текстов — core: main их только вызывает.

- **`skills/coordinator.md`.** Координатор — диспетчер этапов `work`: этап начинается с `stage_started` (роли `roleIds` — пусто значит любые рабочие роли типа по
  описанию, инструкции, `feedback`/`decision`/`answers`), он создаёт подзадачи и запускает воркеров; `stage_tasks_done` — нужны ли ещё задачи, иначе `stage finish --summary`
  (сигнал «набор закончен», а не отчёт); на `gate`/`human`/`ask`/`git`/`merge` ждёт; `run_done` (с `nodeId`) — граф дошёл до `end`, выход без `runs finish`.
  `stage_started` и `stage_tasks_done` — в трёх местах `--types` шага 3 (после `workflow_blocked`). `workflow_blocked` может быть без `taskId`. Подзадача ходит по пути своей ноды `work`:
  ожидание проверки или человека внутри этапа — не повод для `stage finish`; `worker_done`/`workflow_blocked` по подзадаче на пути координатор не обрабатывает, путь ведёт приложение. Прогоны старого формата
  (`workflow show` → `scope: task`) описаны отдельным разделом в конце: `run_done` «все подзадачи закрыты» и `runs finish`.
- **Повторный запуск координатора.** Цель (`resumeCoordinatorObjective(goal, subtasks, returns, stage?)`) с `stage` (`CoordinatorStage` — то, что отдаёт `TaskStore.runStage`, плюс
  `tasksDone`) несёт блок `# Этап: <название>` (`COORDINATOR_STAGE_HEADING`): роли, инструкции, замечания, решение, ответы и подзадачи захода / прошлых заходов, а в конце — что делать
  (нет подзадач — как `stage_started`; есть незакрытые — цикл; все закрыты — `stage finish`). «Уточнение после проверки» в этом режиме не добавляется: замечания уже в `feedback`.
  Собирает `stage` main (`workStage` в `coordinator-resume.ts` из `TaskStore.runStage`); на этапе не «Работа» блока нет, цель — как есть (координатору делать нечего, он ждёт `stage_started`), а «Повторный запуск» по `runs finish` прогону нового формата не применяется.
- **Задачи прогона.** `runGateTaskSpec` / `runGateTaskTitle` — спека задачи `gate`: ветка глобальной задачи целиком против `RunGit.base` (`git log`/`git diff base...branch`, пробный
  `merge --no-commit`), цель, сводки этапов (`StageChange.summary`), `instructions` ноды; решение — `review accept|reject --task "$ORCA_TASK_ID"` (id задачи до создания неизвестен, воркер
  берёт свой из окружения). `runAskTaskSpec` / `runAskTaskTitle` — спека задачи `ask`: цель, сводки, ветка (только чтение), что выяснить и общие с этапом «Вопрос человеку» правила
  (`ASK_STAGE_RULES`), поэтому раздел «# Этап» к ней добавлять не нужно. Контекст — `RunTaskContext` (`taskContext` в `workflow-run.ts`: цель, ветка и база прогона, сводки закрытых этапов с названиями нод, `instructions`); задачи создаёт движок main.
- **`skills/worker.md`.** Задача-проверка глобальной задачи проверяет ветку целиком, `review accept|reject --task` — свой id проверки.

**Движок.**

| Нода | Эффект (`executeSteps`) |
|---|---|
| `work` (`start_stage`) | `stage_started` координатору уже отправил store; движок проверяет, что координатор жив (`Run.coordinatorPtyId` + `isAlive`), иначе **запускает заново** тем же запуском, что «Запустить координатора» (`startCoordinator` → `resumeObjective`). Цель перезапущенного координатора — исходная цель и блок «# Этап: …» (`resumeCoordinatorObjective` со `stage` в `packages/core/src/prompts.ts`): роли, инструкции ноды, `feedback`/`decision`/`answers`, подзадачи захода, что делать по `stage_tasks_done`. Не запустился — `workflow_blocked` по `runId` с командой `orca-board global start --global <id>` |
| `ask` (`create_ask`) | одна задача роли ноды (`createTask` со спекой `runAskTaskSpec` и `stageOf {nodeId, visit}`) и сразу её воркер; вопросы идут человеку (`worker.ask` узнаёт ноду по `stageOf`), координатор не участвует. Сдала `done` → задача закрывается, переход по `next` с `answers` (вопросы и ответы человека) в `stage_started` следующей «Работы». Агент упал, человек ответил — воркер стартует сам |
| `gate` (`create_gate`) | одна задача-проверка роли ноды с `gateFor {runId, nodeId}` и спекой `runGateTaskSpec` (title — `runGateTaskTitle`): ветка прогона целиком против `RunGit.base` (`git log`/`git diff base...ветка`), цель прогона, сводки этапов (`stage finish`), «Как проверять». Решение — `orca-board review accept|reject --task "$ORCA_TASK_ID"` (id проверки воркер берёт из окружения). Нет ветки у прогона или роли в типе — `workflow_blocked` |
| `human` (`request_human`) | `requestRunApproval`: approval уровня прогона. Тело — инструкция ноды, конфликт мержа/отказ git (если пришли оттуда), сводка этапа (нет — итоги подзадач последней «Работы»), показ их последних `done` (`showcaseDispatchId` — последний с показом), ветка и база |
| `git` | `commit` / `push` в worktree ветки прогона (`ensureRunBranch` восстанавливает убранный); шаблоны `{taskId}` — id прогона, `{title}`/`{slug}` — его название. Исход `ok`/`error`, текст отказа git — в approval, если `error` ведёт к человеку, и в `feedback` следующей «Работы», если в неё. Успешный `push` пишет `Run.git.pushedAt`, неудачный — `pushError`. `create_branch`/`checkout` — `workflow_blocked` (валидация их запрещает) |
| `merge` | `mergeRunBranch` (`run-branch.ts`): ветку прогона в базу `RunGit.base` локально, см. ниже. Исход `ok` / `conflict` |
| `end` | ничего: прогон закрыл store (`closedAt`, «Сделано», `run_done`). Worktree ветки убирает `RunBranchSync`, когда в прогоне никто не работает |
| `blocked`, ошибка эффекта | `blockRunStage` — `workflow_blocked {runId, nodeId?, reason}` без `taskId`, позиция остаётся; больше 50 переходов подряд без ожидания — тоже |

**`merge` прогона.** База — `RunGit.base`: локальная ветка или `<remote>/<ветка>` (сливаем в одноимённую локальную). Защищённые ветки (`RunBranchSettings.protected`,
как у `mergeTarget`; проверяются и `develop`, и `origin/develop`) не сливаются никогда — `workflow_blocked` с подсказкой заменить `merge` на `git push` и PR; так же — база-коммит
или отсутствие локальной ветки. Корень проекта не переключается: если база выгружена в корне (или другом worktree) и там чисто — `git merge --no-ff` прямо там, с
незакоммиченными правками — `workflow_blocked` (мерж в грязное дерево может их задеть); иначе **временный worktree** базы (`git worktree add <os.tmpdir()>/orca-merge-*/base <база>`
→ мерж → `worktree remove --force`, папка удаляется). Конфликт (`git merge --abort` уже выполнен) — исход `conflict`, обычно «Конфликт мержа» (`human`) с текстом git; «Принять»
повторяет слияние (ветку разрешает человек). Повтор ноды после `workflow_blocked` — `startRunWorkflow` (см. ниже). Платформенных веток нет: только `execFileSync('git', […])` и `os.tmpdir()`.

**Вход и повтор.** `startRunWorkflow(runId)` зовёт `runCoordinator` (`index.ts`) после каждого запуска координатора: граф не начат — `enterRunStage` и эффект первой ноды
(обычно `stage_started`), граф идёт — повтор эффекта текущей ноды. Повтор безопасен: задача-вопрос и проверка этого захода не дублируются (нашлась — при необходимости просто запускается),
ждущий approval возвращается тот же, слияние и git идемпотентны, «Работа» при живом координаторе ничего не делает. Прогон, дошедший до `end`, координатора не запускает
(`workflow.runFinished`): запуск переоткрыл бы закрытый прогон.

**Переходы и подписки.**

| Что пришло | Откуда | Что делает движок |
|---|---|---|
| `stage finish` | сокет `stage.finish` → `ProjectDeps.finishStage` → `finishRunStage(runId, summary)` (сокет не зовёт `store.finishStage` напрямую: `stage_changed` эффектов не запускает) | `TaskStore.finishStage` → эффект следующей ноды; ошибка эффекта — `workflow_blocked`, а не провал команды |
| Решение проверки | `review accept|reject --task <id проверки>` (сокет, IPC `review:*`, «Принять»/«Вернуть» на задаче-проверке) → `reviewDecision` в `index.ts` → `runGateDecision` (единственный путь) | `advanceRunStage` по `accept` / `reject` (замечания — в `Run.returns` и `stage_started`, комментарий `accept` — `decision`) и эффект следующей ноды; проверка уже сдала `done` — закрывается сразу; не актуальна (граф ушёл дальше, есть новая) — ошибка |
| `worker_done` проверки ветки прогона | `handleRunWorkflowEvents` (`taskEngine` = `run`) | проверка закрывается (worktree и ветка удалены, задача в done); решения не было и граф всё ещё на её ноде — `workflow_blocked` «сдана без решения» |
| `escalation` проверки ветки прогона | то же | решение уже есть — проверка закрывается; иначе остаётся эскалация store |
| `worker_done` задачи `ask` | то же | закрыть, `advanceRunStage(next, {answers})`, если прогон стоит на этом заходе ноды |
| `question_answered` (агент `ask` не жив) | то же | воркер стартует сам |
| approval `human` решён | IPC `requests:resolve`, сокет `request resolve` → `resolveHumanRequest` → `handleRunApproval` | `accept` → исход `accept` (текст «Принять» → `decision` следующей «Работы»), `reject` → исход `reject` (замечания → `feedback`) |
| «Подтвердить» / «Вернуть в работу» на карточке | IPC `globalTasks:accept` → `acceptRun`, `globalTasks:returnToWork` → `returnRun` | то же решение approval; «Вернуть» **не закрывает** живого координатора (он ждёт этап в Monitor), мёртвого — перезапускает граф на входе в «Работу»; IPC отдаёт терминал координатора |
| Координатор умер, `stage finish` не пришёл | раз в 5 с `watchFinishedCoordinators` → `settleIdleRunStages` | `settleIdleStages`: этап закрывается по `next` без сводки, эффект следующей ноды |

**Путь подзадачи в движке main.** Подзадача этапа «Работа» идёт по своему пути (`Task.stage`), его исполняет **движок по подзадачам** (`main/workflow.ts`: `advance`,
`executeSteps`, `enterWork`, `reviewAccept`/`reviewReject`, `approvalResolved`); движок прогона (`workflow-run.ts`) эффекты пути не делает. Автомержа «в лоб» больше нет: слияние ветки подзадачи
в ветку прогона — нода `merge` пути (по умолчанию `work → merge → end`), конфликт — нода `conflict` (`human` «Конфликт мержа»: approval на **самой задаче**, задача в «Нужен ответ»; «Принять» — после
правки ветки задачи `merge` повторяется, «Вернуть» — замечания в `feedback`, воркер стартует заново). Этап закрывается, когда все подзадачи захода дошли до `end` пути и стоят в done
(`stage_tasks_done`), поэтому слито всё, что координатор видит закрытым; подзадача, ждущая проверки или человека внутри пути, держит этап. Ошибка не конфликтом (защищённая ветка корня у прогона
без ветки) — `workflow_blocked` по задаче с `taskId`.

*Маршрутизация — «один исполнитель на событие».* `taskEngine(deps, task)` (`main/workflow.ts`) относит задачу к одному из трёх: `path` — подзадача со `stageOf` на ноде `work` и проверка **ветки подзадачи**
(`gateFor.taskId`); `run` — проверка ветки прогона (`gateFor.runId`), задача `ask`, подзадача без `stageOf`; `legacy` — прогон старого формата и «Входящие». `handleWorkflowEvents` (`legacy` и `path`)
и `handleRunWorkflowEvents` (`run`) фильтруют по нему и взаимно исключают друг друга; `index.ts` зовёт оба на каждое событие (`runWorkflowEvents`). Запросы approval делятся по `taskId`: `handleRunApproval`
берёт запрос прогона (без `taskId`), запрос на задаче — `approvalResolved` движка по подзадачам. Заходы: `runWorker` вводит подзадачу в путь (`enterWork`), `worker_done` ведёт по `next` (`workDone`).

*Совместимость с состоянием старой сборки.* Подзадача, сданная до пути (нет `Task.stage`), при `worker_done` входит в путь и идёт от `work` к `merge` тем же шагом. Approval «Конфликт мержа» с
`nodeId: SUBTASK_MERGE_NODE`, ждавший человека при обновлении, решает `legacyConflictResolved`: «Принять» вводит задачу в путь и запускает `merge`, «Вернуть» — перезапуск воркера. Подзадача, заготовленная
до входа прогона в граф (нет `stageOf`), пути не имеет: после `done` — `workflow_blocked` «не привязана к этапу», приёмка вручную (прежний `review accept` с мержем). Миграции формата нет: позиция
подзадачи (`Task.stage`) и прогона (`Run.stage`) лежат в снимке и переживают рестарт вместе, путь читается из `Run.workflow`; подзадача на `gate`/`human` пути ждёт решения как обычно.
Задачи-ответы (`answerFor`) идут своим циклом «Принять» / «Уточнить».

**Ограничения.** Эффект, не доведённый до конца из-за выхода приложения, повторяется при следующем запуске координатора (`startRunWorkflow`) или, для закрытия этапа, фолбэком. Файлы показа
читаются из worktree задачи, а после автомержа он убран — файлы остаются в ветке прогона (IPC отвечает ошибкой с её именем). `RunBranchSync`: если в графе есть `git push`, авто-push при закрытии
для прогона выключен (`workflowPushes`).

### Renderer

Редактор типа («Настройки → Типы задач → Воркфлоу», `docs/architecture.md`, «Воркфлоу: редактор»): у «Работы» — необязательный мультивыбор ролей, справка
`WF_NODE_HELP` описывает роли нод по этому разделу (координатор набирает агентов; гейт проверяет ветку прогона; `human` — approval прогона; мерж — в базовую ветку без
защищённых; git — только `commit`/`push`), условие по роли и `create_branch`/`checkout` не предлагаются, ошибки и предупреждения (в том числе `noHumanBeforeEnd`) идут
из `validateWorkflow` с переводом по `code`, импорт графа v1 показывает, что снято миграцией, а замечания автомиграции сохранённого типа (`TaskType.workflowNotes`) — рамка над холстом (`storedWorkflowNotes`, `taskTypeEdit.ts`) и «!» у вкладки «Воркфлоу», до «Понятно» (`patch` с `workflowNotes: []`); без поля у старого main блока нет. Экран глобальной задачи: чип «Этап: …» (`runStageLabel`), входы в этапы
в «Истории», подзадачи по этапам на доске (`Task.stageOf`), «Подтвердить» с полем решения и «Вернуть в работу…» решают approval ноды `human` (`docs/nested-kanban.md`,
«Проверка»), Инбокс показывает approval без задачи (`docs/human-requests.md`). Все поля снимка (`Run.stage`, `stageOf`, `workflowScope`) читаются как необязательные —
со старым main пилюль и групп нет, «Подтвердить» открывает прежнюю приёмку без окна.

### Проверка сквозным тестом

`workflow-run-e2e.test.ts`: настоящие git-репозиторий (во временной папке), `ProjectManager` (тип «Фича» с ролью `planner` и графом «Анализ → человек → Реализация (без ролей, 2 подзадачи) →
проверка → человек → merge → end») и движок `workflow-run.ts`; PTY нет, координатор и воркеры — фейки по контракту `index.ts`. Проверяет: `stage_started` (`roleIds`, `decision`, `feedback`), ошибки
`task create` (чужая роль, не «Работа»), слияние подзадач в ветку прогона по пути (корень не тронут), `stage_tasks_done` один раз на заход, `stage finish` → задача-проверка по ветке прогона,
`reject` → новый заход «Реализации» без старых задач, `merge` в защищённую `master` (`workflow_blocked` без `taskId`, база не тронута) и после снятия защиты (корень не переключается),
`run_done` ровно один раз на `end`, старый прогон рядом идёт прежним движком, перезапуск приложения на approval с мёртвым координатором. Перезапуск на подзадачах, стоящих на `gate` и `human` своего пути (`Run.stage` и `Task.stage` восстанавливаются вместе). Конфликты мержа (ветка прогона и подзадача), путь подзадачи (проверка → `reject` → работа → `accept` → мерж, конфликт, повторный заход во внешний этап, совместимость со старым approval, маршрутизация «один исполнитель на событие»), `git`-ноды,
`ask`, фолбэк `settleIdleRunStages` и цель перезапущенного координатора — в `workflow-run.test.ts`.

### Что не входит в эту итерацию

Сокет и CLI, промпты и skills, автомиграция сохранённых графов типов (`migrateWorkflowReport`, `TaskType.workflowNotes`), движок main и renderer сделаны; протокол —
«Протокол сокета» и «CLI» в `docs/architecture.md`. Сознательно не делаем:

- **Флаг `single`** (вариант C анализа: один агент на всю глобальную задачу) — координатор один на прогон, воркеры по подзадачам.
- **Перевод идущих прогонов** без `workflowScope: 'run'`: они доживают на старом движке по подзадачам (`workflow.ts`).
- **Составная нода** (подграф на уровне глобальной задачи, вариант B анализа): не делаем; если понадобится — разворачиванием в плоский граф при создании прогона.

## Кто в воркфлоу

**Версия 2 (граф глобальной задачи).** Позиция на графе — у самой глобальной задачи (`Run.stage`), а не у задач:

- **Координатор** — один на прогон, только диспетчер: по `stage_started` создаёт подзадачи этапа `work`, по `stage_tasks_done` вызывает `stage finish`. Сам не проверяет,
  не сливает и не решает, куда идти. Мёртвого приложение перезапускает на входе в «Работу».
- **Подзадача этапа `work`** (`Task.stageOf {nodeId, visit}`) — обычная рабочая задача: воркер → `done` → мерж в ветку прогона (нода `merge` пути); идёт по пути подзадачи (`work.subflow` или `defaultSubflow()`), позиция — `Task.stage` на ноде пути (см. раздел «Путь подзадачи»).
- **Задача-проверка** (`Task.gateFor {runId, nodeId}`) и **задача-вопрос** (`Task.stageOf` на ноде `ask`) — одиночные задачи, их создаёт приложение; решение проверки —
  исход ноды `gate`.
- **Человек** — approval уровня прогона (`HumanRequest` без `taskId`) на ноде `human`; «Подтвердить»/«Вернуть в работу» на карточке решают его же.
- **Мимо воркфлоу**: задачи-ответы (`answerFor`) — свой цикл «Принять» / «Уточнить»; подзадачи, не попавшие на этап `work` (граф не начат, «Входящие»).

**Версия 1 (по подзадачам, старые прогоны и «Входящие»):**

- **Рабочая задача** — обычная задача прогона. Входит в граф при первом запуске воркера (`enterWork` в `runWorker`),
  позиция — `Task.stage {nodeId, visits}`.
- **Задача-проверка** (`Task.gateFor {taskId, nodeId}`) — её создаёт исполнитель на ноде `gate`; своего этапа у неё нет.
- **Мимо воркфлоу**: задачи-ответы (`answerFor`) — у них свой цикл «Принять» / «Уточнить» (`docs/human-requests.md`),
  и задачи, сданные до воркфлоу без этапа (их `review accept` — прежняя приёмка).

## Типы нод простыми словами

Таблица — по подзадачам (версия 1). Что меняется в версии 2 — у каждой ноды в таблице «Кто за что отвечает» выше: `work` ведут агенты ролей ноды (необязательных) через координатора, `gate` и `merge` работают с веткой глобальной задачи, `human` — approval прогона, `condition: role` и `git create_branch/checkout` не бывают.

| Нода (в редакторе) | Зачем | Кто выполняет | Исходы | Что настраивается |
|---|---|---|---|---|
| `start` «Старт» | точка входа, ровно одна, в неё не ведут переходы | приложение, проходит сразу | `next` → первый этап | — |
| `work` «Работа» | воркер делает задачу в своей ветке | агент роли ноды или роли задачи от координатора; в версии 2 роли ноды необязательны (`roleIds`) | `next` — воркер сдал `done` | роли (необязательно), «Что сделать на этапе», «Показать человеку» (и обязателен ли показ) |
| `ask` «Вопрос человеку» | агент задаёт человеку вопросы штатным `orca-board ask`, ответы идут в промпт следующих этапов | агент роли ноды или роли задачи; вопросы — человеку, минуя координатора | `next` — агент сдал `done` | роль, «О чём спросить» (обязательно) |
| `gate` «Проверка агентом» | агент проверяет ветку в отдельной задаче-проверке | агент выбранной роли (например, ревьюер) | `accept` / `reject` с замечаниями | роль проверяющего (обязательна), «Как проверять», колонка |
| `human` «Решение человека» | запрос «Принять» / «Вернуть» в Инбоксе | человек | `accept` / `reject` с замечаниями | «Что решить человеку», колонка |
| `condition` «Условие» | развилка без ожидания | приложение, считает сразу | `yes` / `no` | число заходов в ноду (лимит повторов) или роль задачи |
| `merge` «Мерж» | слить ветку в ветку глобальной задачи (без неё — в текущую ветку репозитория) | приложение (`git merge --no-ff`) | `ok` / `conflict` | — |
| `git` «Git» | приложение само делает git-операцию в worktree задачи: создать ветку, переключиться, закоммитить, запушить | приложение (`git` в worktree), без агента и человека | `ok` / `error` (git отказал) | операция, имя ветки, база, сообщение коммита, remote — по операции |
| `end` «Конец» | задача в «Готово»; без мержа ветка остаётся | приложение | — | «со слитой веткой» — только для схемы |

Эти же описания редактор показывает в инспекторе выбранной ноды («Как работает этап»), в легенде «Типы нод» под
списком нод и в подсказках кнопок палитры: тексты — `WF_NODE_HELP` в
`apps/desktop/src/renderer/src/workflowHelp.ts`, тест `workflowHelp.test.ts` требует описание и все исходы для
каждого типа. Меняешь поведение этапа — правь таблицу ниже, эту таблицу и `WF_NODE_HELP` вместе.

## Этапы и что делает приложение

| Нода | Эффект | Чем заканчивается этап |
|---|---|---|
| `start` | — (проходится сразу) | `next` |
| `work` | задача в ready, запуск воркера (`runWorker`); `roleId` ноды, если задан, становится ролью задачи | `orca-board done` воркера → `next` |
| `ask` | задача в ready, запуск агента (`runWorker`) с ролью ноды (пусто — роль задачи; на задачу роль **не** переносится); вопросы агента адресуются человеку (запрос `question` с `nodeId` ноды, задача в «Нужен ответ»); ответил человек, а агента уже нет — воркер стартует сам | `orca-board done` агента → `next` |
| `gate` | рабочая задача в колонку ноды (по умолчанию «Ревью»), задача-проверка на роль `roleId` со спекой `gateTaskSpec` и сразу её воркер | проверяющий: `review accept` → `accept`, `review reject --feedback` → `reject` |
| `human` | запрос `approval` в Инбокс, задача в «Нужен ответ» | человек: «Принять» → `accept`, «Вернуть» с замечаниями → `reject` |
| `condition` | — (считается сразу: `attempts`, `role`) | `yes` / `no` |
| `merge` | закоммитить хвосты, `git merge --no-ff` ветки в цель (`mergeTarget`: ветка глобальной задачи или текущая ветка корня; в защищённую корня — `workflow_blocked`), убрать worktree и ветку | `ok` / `conflict` (ветка и worktree на месте) |
| `git` | выполнить `operation` в worktree задачи (`WfAction {type: 'git'}`), обновить `Task.branch`, если ветка сменилась — см. «Нода Git» | `ok` / `error` — текст ошибки git в `task.feedback` |
| `end` | задача в done; ветка не слита (конец без мержа) — worktree убирается, **ветка остаётся** | — |

Каждый вход в этап пишется в `Task.stageHistory` (нода, время, исход, с которым пришли, кто двигал): по ней видно, сколько
раз задачу возвращали с ревью (`outcome: 'reject'`) и когда был перезапуск (`restart`). Подробности — «История этапов»
в `docs/architecture.md`.

Отказ (`reject`) с замечаниями кладёт их в `task.feedback`: следующий запуск воркера получает их в промпте.
Если отказ ведёт в `work`, воркер стартует сразу — координатору делать ничего не нужно.

### Вопрос человеку (`ask`)

Нода `{type: 'ask', roleId?, instructions}` (формат графа тот же, `WORKFLOW_VERSION` не менялся: старое приложение
остановит задачу как `workflow_blocked`, а не пустит по дефолтному графу). `instructions` — «О чём спросить», обязательны:
пустые — ошибка валидации «не задано, о чём спросить человека». Исход один — `next`. Для движка это тот же
`start_worker`, что у `work` (`stageAction`), различает их исполнитель по типу ноды; этап читает `wfWorkStage`
(`WfWorkStage.type: 'work' | 'ask'`). У вопроса, заданного на этапе, `Question.nodeId` — нода `ask`
(`HumanRequest.nodeId` то же).

Ограничения v1:

- Вопрос не обязателен: агент может сдать `done` без `ask`; сколько и как спрашивать — задаёт `instructions`. Лимита
  вопросов нет, таймаута ожидания нет.
- Агент код не меняет, только читает репозиторий и спрашивает. Вопросы с этапа всегда идут человеку, минуя координатора.
- Пустая роль ноды — роль задачи; роль этапа `ask` **не** становится ролью задачи (у `work` становится).
- Ответы видит следующий `work` (раздел с ответами в промпте); в спеку `gate` и в `approval` на `human` они не попадают.
- Колонка `column` у `ask` не применяется: пока агент работает — «В работе», при ожидании ответа — «Нужен ответ».
- В пресеты типов задач `ask` не входит. `stopsLoop` (человек в цикле) для `ask` не считается: цикл через неё
  получает то же предупреждение о бесконечных возвратах.

Редактор: нода в палитре после «Работы», в инспекторе — «Роль» (пусто — «Роль задачи») и «О чём спросить человека»
(пустое подсвечивается ошибкой), поля «Колонка» нет; справка — `WF_NODE_HELP.ask`. В Инбоксе вопрос с этапа `ask`
помечен «Этап «<нода>»». Роль на `ask` учитывается при удалении роли.

Путь вопроса (main, `apps/desktop/src/main`):

- **Запуск.** `executeSteps` (`workflow.ts`) для ноды `ask` не зовёт `applyWorkRole`: роль ноды едет в запуск параметром
  `WorkflowDeps.startWorker(taskId, {roleId})` → `runWorker` (`index.ts`) → `startWorker(…, roleId)` (`worker.ts`), а
  `task.roleId` и `task.agent` остаются прежними — иначе следующая «Работа» без своей роли запустилась бы ролью
  опросника. Проверки роли и агента в `runWorker` идут по роли этапа. `Dispatch.roleId` — роль ноды. Без параметра
  (`worker start`, перезапуск, автоперезапуск) роль этапа `runWorker` берёт из графа (`enterWork` из `workflow.ts` возвращает
  `{roleId}` ноды `ask`). `store.enterWork` этап `ask` не сбрасывает: агент входит в него при каждом запуске.
- **Первый этап.** `ask` сразу после `start`: первый запуск (`worker start`) входит в граф в `ask`; worktree и ветка
  создаются как обычно, после `next` «Работа» идёт в том же worktree.
- **Адресат.** `worker.ask` (`socket.ts`) спрашивает у store ноду задачи (`taskStageNode`, граф прогона или запасной граф
  типа); на `ask` — `store.ask(…, {forceHuman: true})`: вопрос сразу человеку при любом координаторе, `Question.nodeId` и
  `HumanRequest.nodeId` — нода этапа. Вопрос обычного воркера с живым координатором идёт координатору, как раньше.
- **Сдача.** `workDone` принимает этапы `work` и `ask`; после `done` — `next`.
- **Автоперезапуск.** `question_answered` с `workerLive: false` на этапе `ask` (агент упал, приложение перезапустили) —
  `handleEvents` (`workflow.ts`) стартует воркера сам, ошибка запуска — `workflow_blocked`. Координатор не участвует
  (`skills/coordinator.md`). `runWorkflowEvents` (`index.ts`) пропускает `question_answered` в исполнитель.
- **Промпт.** Раздел «# Этап: …» для `ask` (`askStageSection` в `prompts.ts`): цель — спросить, код не менять, `orca-board
  ask` и `done`; при повторном заходе (возврат `reject`, перезапуск) ответы под заголовком «Ответы на вопросы по задаче» и
  пометка «уже получены». Тот же раздел с ответами получает следующая «Работа».

### Нода Git (`git`)

Нода `{type: 'git', operation, branch?, base?, message?, remote?}`. Приложение само выполняет одну git-операцию в
worktree задачи, агент не запускается, человек не участвует. Формат графа тот же, `WORKFLOW_VERSION` не менялся
(как у `ask`): старое приложение отвергнет такой граф валидацией «неизвестный тип», а задачу на такой ноде остановит
как `workflow_blocked`, а не пустит по дефолтному графу. Модель и валидация — `packages/core/src/workflow.ts` (тесты — блок
«нода «Git»» в `workflow.test.ts`); исполнение — `runGitNode` в `apps/desktop/src/main/workflow.ts`, git-функции —
`gitCreateBranch`/`gitCheckout`/`gitCommit`/`gitPush` в `apps/desktop/src/main/git.ts` (тесты — `workflow-git.test.ts`).

Редактор: нода в палитре после «Мержа», в инспекторе — «Операция» и поля только выбранной операции (`workflowGit.ts`,
подробности — «Воркфлоу: редактор» в `docs/architecture.md`), под веткой и сообщением — подстановки и превью на образце;
поля «Колонка» нет. Исход `ok` подписан «выполнено», `error` красный.

**Операции v1** (`WF_GIT_OPERATIONS`), поля по операции — `WF_GIT_FIELD_USE`:

| `operation` | Что делает в worktree задачи | Обязательно | Необязательно | Пусто — значит |
|---|---|---|---|---|
| `create_branch` | создаёт ветку `branch` от `base` и переключает на неё worktree | `branch` | `base` | `base` — ветка глобальной задачи (`Run.git.branch`), без неё — текущая ветка корня репозитория (та, куда сольёт `merge`); если worktree задачи уже есть — то место, где он стоит (коммиты задачи не теряются) |
| `checkout` | переключает worktree на существующую ветку `branch` | `branch` | — | — |
| `commit` | коммитит все изменения worktree (`commitWorktree`: `add -A`, автор `orca-board`) с сообщением `message` | `message` | — | нечего коммитить — тоже `ok` |
| `push` | пушит ветку задачи (`Task.branch`) в `remote`: `git push -u <remote> <ветка>` без force | — | `remote` | `origin` (`WF_GIT_DEFAULT_REMOTE`) |

Поле, которое операции не нужно, игнорируется: валидация даёт предупреждение (`gitParamIgnored`), исполнитель его не читает
(в `WfAction` оно уже отфильтровано). Значения обрезаются по краям; пустая строка = поля нет.

**Подстановки** (`renderGitTemplate(шаблон, wfGitVars(task))`): в `branch` — `{taskId}` (id задачи, например
`task_muh1yssc4`) и `{slug}` (слаг названия: латиница в нижнем регистре, кириллица транслитерируется, остальное — дефис,
≤ 40 символов, пусто — `task`; `wfGitSlug`); в `message` дополнительно `{title}` (название задачи как есть). Неизвестная
подстановка — ошибка валидации. `base` и `remote` — без подстановок. Имя ветки после подстановки должно быть допустимым
(`isValidGitBranchName`, упрощённый `git check-ref-format`): валидация проверяет шаблон на образце значений
(`gitBranchTemplateValid`), исполнитель — на настоящих.

**Исходы:** `ok` и `error`, оба обязательны (`WF_PORTS.git = ['ok', 'error']`, иначе ошибка «нет перехода для …»).

- `ok` — операция выполнена.
- `error` — сама git-операция не удалась: ветка уже есть (`create_branch`), нет такой ветки или она занята другим
  worktree — например, текущей веткой корня репозитория (`checkout`), в worktree незакоммиченные изменения перед
  `create_branch`/`checkout` (поставьте `commit` раньше), нет remote, нет прав или отказ non-fast-forward (`push`),
  не git-репозиторий. Любой отказ git или окружения — именно `error`, а не `blocked`. Исполнитель кладёт текст ошибки
  (`git <команда>: <stderr>`) в `task.feedback`, как замечания при `reject`: если `error` ведёт в `work`, воркер увидит его
  в промпте; ведёт в `human` — человек видит причину в запросе. Обычно `error` ведут к человеку или обратно в работу;
  петля `error → эта же git-нода` останавливается общим лимитом 50 переходов подряд.
- `workflow_blocked` остаётся для ошибок **настройки**, а не git: нода неполная или с неизвестной операцией
  (`stageAction` → `blocked`), шаблон после подстановки дал недопустимое имя ветки, у ноды нет перехода для исхода.

**Исполнение (main).**

- Действие — `WfAction {type: 'git', nodeId, operation, branch?, base?, message?, remote?}` (`stageAction`). Шаблоны в нём
  **не подставлены**: `runGitNode` вызывает `renderGitTemplate(x, wfGitVars(task))`. У `push` `remote` уже с умолчанием.
  Событий воркера нет: `executeSteps` выполняет git синхронно и сразу вызывает `advance(…, 'ok' | 'error')` — цепочка
  `git → git → …` идёт за один вызов (лимит 50 переходов подряд общий).
- **Имя ветки** после подстановки проверяется дважды: упрощённо (`isValidGitBranchName`) и настоящим `git check-ref-format
  --branch` (`isBranchNameAcceptedByGit`). Недопустимое — `workflow_blocked` «имя ветки «…» после подстановки недопустимо»:
  git не запускался, это ошибка настройки, а не отказ git. Пустое сообщение коммита после подстановки — тоже `blocked`.
- Worktree задачи — `Task.worktree`, ветка — `Task.branch` (`orca/<taskId>`, если её не сменила нода). Нода `git` может
  стоять **до первой «Работы»** (типичный `start → git(create_branch) → work`): worktree к этому моменту ещё нет, исполнитель
  создаёт его сам по тому же пути, что и `startWorker` (`taskWorktreePath`: `<репозиторий>/../.orca-worktrees/<taskId>`) —
  для `create_branch` сразу на новой ветке (`git worktree add --no-track -b <ветка> <путь> <base>`), ветка `orca/<taskId>`
  тогда вообще не заводится; для `checkout` — на существующей. `startWorker` берёт готовые `Task.worktree` и `Task.branch`,
  а не создаёт `orca/<taskId>` (worktree, созданный нодой до первого запуска, получает установку зависимостей, как новый).
- **Вход в граф через `enterWork`.** Первый запуск воркера (`worker start`, перезапуск, возврат с ревью) зовёт `enterWork`;
  если первым этапом стоит `git`, он выполняется здесь же (`prepareBeforeWork`), а воркера стартует вызывающий `runWorker` —
  иначе он запустился бы дважды. Цепочка ушла не на «Работу»/«Вопрос человеку» (`error → human`, настройка) — `runWorker`
  бросает «воркер не запущен: до работы задача остановилась на этапе «…»»; задача остаётся на этом этапе (запрос человеку
  уже создан). `error → work` — воркер стартует на `orca/<taskId>`, причина в `feedback` попадёт в его промпт.
- **`Task.branch` после `create_branch` и `checkout` — новая ветка.** Всё дальше (ревью `review info`, гейты — их спека
  называет ветку задачи, `merge`, `push`) работает с `Task.branch`, поэтому исполнитель её обновляет вместе с `Task.worktree`.
  Ветка `orca/<taskId>`, если она успела появиться и не нужна, остаётся на месте (её не удаляет ни нода, ни уборка).
- **Повторный заход** (задачу вернули на первый этап, конец без мержа и переоткрытие): `create_branch` с той же веткой, что
  уже записана в `Task.branch`, — не ошибка «ветка есть»: worktree ставится на неё (или остаётся, если уже на ней). Чужая
  существующая ветка — по-прежнему `error`. `checkout` на ветку, на которой worktree уже стоит, — тоже ok.
- `create_branch` и `checkout` требуют чистого worktree: `git checkout` с грязным деревом может унести изменения на другую ветку
  или отказать — исполнитель проверяет `git status --porcelain` и при грязном дереве отвечает `error` (подсказка: поставьте
  `commit` раньше), а не переключает. `create_branch` создаёт ветку с `--no-track`: иначе от `origin/develop` она унаследовала
  бы upstream, и голый `git push` ушёл бы в `develop`.
- **Защита чужих веток — `Task.branchForeign`.** Уборка после `merge` (`mergeTaskBranch` → `removeWorktree`) делает
  `git branch -D <Task.branch>`. `checkout` на существующую ветку (кроме `orca/<taskId>` и ветки, которую задача уже вела как
  свою) ставит `branchForeign: true`; такую ветку уборка не удаляет, снимает только worktree. Ветку из `create_branch` создало
  приложение — она «своя». У старых задач поля нет — ветка своя, миграция не нужна. Флаг сбрасывается вместе с
  `worktree`/`branch` при мерже и приёмке (`acceptTask`, «Принять» ответа). Слияние идёт в текущую ветку корня репозитория,
  как у любой задачи: `checkout` на `develop` при корне на `master` сольёт `develop` в `master` — граф задаёт человек.
- **Отказ git — исход `error`.** Текст `git <команда без -c>: <stderr>` (или причина по-русски: «ветка «x» уже существует»,
  «ветки «x» нет», «базовой ветки «x» нет», «в worktree есть незакоммиченные изменения…», «у задачи нет ветки — нечего
  пушить») кладётся в `task.feedback` и, если `error` ведёт к человеку, в тело запроса («Git-операция «…» не удалась»). Нет
  перехода `error` — `workflow_blocked` «…; у ноды нет перехода «error»» с тем же текстом, задача остаётся на ноде.
- `push` отправляет только закоммиченное: нужны изменения — поставьте `commit` перед ним. Ветка после `merge` удаляется
  локально, на remote остаётся; для «запушить без мержа» граф идёт `… → git(push) → end` (конец без мержа сохраняет ветку).
  Git запускается с `GIT_TERMINAL_PROMPT=0` (без запроса пароля в несуществующем терминале), а `push` ещё и с таймаутом
  120 с — **синхронно в main**: пока идёт push, приложение не отвечает; зависший remote даёт `error` «не ответил за 120 с».
- Запрещено намеренно (противоречит модели «worktree на ветку задачи, слияние — нода `merge`»): `merge`, `rebase`, `reset`,
  `checkout` файлов, удаление веток, `push --force`, произвольная команда. Слияние — `merge`; ветки удаляет уборка.

Валидация (`validateWorkflow`, коды `git*` в `WF_ISSUE_TEXTS`, тексты для renderer — `config.wf.issue.git*`). Ошибки:
неизвестная операция; нет `branch` у `create_branch`/`checkout`; нет `message` у `commit`; поле не строка; недопустимое имя
ветки, базы или remote; новая ветка совпадает с `base`; неизвестная подстановка (в том числе `{title}` в `branch`); нет
перехода `ok` или `error`, чужой исход. Предупреждение: поле не используется операцией.

Для `orca-board workflow show` этап получает поле `git` — `{operation, branch?, base?, message?, remote?}` (`WfStageInfo.git`,
только заполненные, шаблоны как в графе).

Примеры:

```
start → git(create_branch, branch="feature/{taskId}-{slug}") → work → … → merge → end
                     └─error─▶ human «Не удалось создать ветку»
… → work → git(commit, message="feat: {title}") → git(push) → end        # без мержа, ветка на remote
```

### Показ человеку на «Работе»

У ноды `work` два необязательных поля (формат графа тот же, `WORKFLOW_VERSION` не менялся):

- `instructions` — что сделать на этапе;
- `showcase {what, required?}` — что воркер сдаёт на показ человеку (макеты, скриншоты, описание вариантов).

Оба попадают в промпт воркера разделом «Этап» (`workerTaskPrompt` в `packages/core/src/prompts.ts`; этап берёт
`TaskStore.taskWorkStage`, нормализует `wfWorkStage` в `packages/core/src/workflow.ts`). Сданный показ хранится
в `Dispatch.showcase {text?, files}`: `text` — markdown (≤ 200 000 символов), `files` — до 50 путей от корня
worktree задачи, без абсолютных путей и `..` (`normalizeShowcase`, `packages/core/src/types.ts`). При
`required: true` `done` без показа отвергается (`finishDispatch`). Смотрит показ человек на следующей ноде `human`;
выбор («вариант 2») из поля решения при «Принять» приходит координатору в `request_resolved.decision`
(`docs/human-requests.md`). Валидация: пустой `what` — ошибка; показ, после которого до следующей «Работы» или
мержа нет ноды `human`, — предупреждение «показ никто не увидит».

Путь показа от воркера до человека (main, `apps/desktop/src/main`):

- **Промпт.** `startWorker` (`worker.ts`) берёт этап `store.taskWorkStage(task.id, {roleIds, workflow})` (граф типа —
  запасной для прогона без снимка, `WorkerEnvContext.workflow`) и передаёт его в `workerTaskPrompt`. У задачи-ответа
  этапа нет.
- **Сдача.** `orca-board done --show-file <описание.md> --show <путь>...`: CLI читает файл и шлёт
  `params.showcase {text?, files}`; сокет `worker.done` передаёт его в `finishDispatch` вместе с запасным графом
  типа прогона — чтобы проверка `required` видела тот же этап, что и промпт.
- **Запрос человеку.** `requestHuman` (`workflow.ts`) берёт показ из последнего запуска задачи (`task.dispatchId`,
  `outcome: 'done'`): в `body` approval — раздел «## Показ» (текст и список файлов, `showcaseMarkdown` из `shared/showcase.ts`) после итога
  воркера, а `HumanRequest.showcaseDispatchId` — id этого запуска. Гейт между «Работой» и «человеком» — отдельная
  задача и показ не подменяет. После «Вернуть» новый `done` даёт новый approval с новым показом.
- **Файлы.** Renderer читает их из worktree задачи через IPC `showcase:read` / `showcase:open` / `showcase:reveal`
  (`main/showcase.ts`): путь только внутри worktree (симлинки наружу — отказ), расширения — белый список
  `SHOWCASE_FILE_TYPES` (`shared/showcase.ts`: картинки `png/jpg/jpeg/webp/gif/svg` и `md` превьюятся, `html/htm/pdf` —
  только «Открыть»). После мержа worktree убран — файлы остаются в ветке, IPC отвечает ошибкой с её именем.
- **Вид для человека** (renderer). `ShowcaseBlock.tsx` — развёрнутый блок «Показ» в карточке approval (Инбокс,
  лента глобальной задачи, модалка задачи) и отдельным разделом в модалке задачи (последний `done` с показом, если его
  не выводит ждущий approval). Markdown — через `Markdown.tsx`; первые 6 картинок превьюятся сразу (blob-URL, CSP
  `img-src blob:`), остальные и `.md` — по кнопке; у каждого файла «Открыть» / «В папке». Раздел «## Показ» из
  `body` вычитается (`bodyWithoutShowcase`), чтобы не дублировать. Логика — `renderer/src/showcase.ts`: старые
  main/preload — «Перезапустите приложение» (`showcaseApi`, `SHOWCASE_STALE_MESSAGE`). У «Принять» approval — поле
  «Решение / вариант» (`resolution.text` → `request_resolved.decision`).

Колонка этапа: `node.column` учитывается у `gate` и `human`; `work` — всегда «В работе» (пока работает воркер),
`end` — колонка `kind=done` (иначе прогон не закроется).

## Дефолтный граф по подзадачам (версия 1)

Строит `legacyDefaultWorkflow`; граф версии 2 — «Дефолтный граф и заготовки типов» выше.

```
start → work ──next──▶ ревью ──accept──▶ merge ──ok──▶ end
          ▲              │                  │
          └───reject─────┘                  └─conflict─▶ «Конфликт мержа» (human) ──accept──▶ merge
                                                                              └─reject──▶ work
```

Ревью — `gate` роли `reviewer`, если она есть в проекте, иначе `human`. Это прежнее поведение: ревьюер-агент
принимает или отклоняет ветку, после приёмки ветка сливается; нет ревьюера — решает человек. Новое — конфликт
мержа: раньше задача зависала в «Ревью» с ошибкой в UI, теперь человек получает запрос с текстом конфликта,
разрешает его в ветке задачи и нажимает «Принять» (мерж повторяется) или «Вернуть».

## Жизненный цикл проверки

1. Рабочая задача A сдала `done` → A на ноде `gate`, создана проверка G (`«<нода>: <A.title>»`), воркер G запущен.
   `task_ready` по G не шлётся.
2. Проверяющий делает `review accept|reject --task A` — это исход этапа A: мерж или возврат в работу.
3. G сдаёт `done` (`worker_done` с `gateFor: A`) → G закрывается: worktree и ветка удаляются, G в done.
   Решения не было — G остаётся на ревью, `workflow_blocked` у A с командой перезапуска проверки.
4. Воркер G вышел без `done`: решение уже есть — G закрывается, нет — обычная эскалация («Перезапустить»).

Если A вернули в работу вручную (`worker start`, `task reopen --start`) — этап A сбрасывается на «Работу», старая
G закроется по своему `done`.

## Ошибки: `workflow_blocked`

По подзадачам (версия 1; у воркфлоу прогона — `workflow_blocked {runId, nodeId?, reason}` без `taskId`, «События» выше). Задача остаётся на этапе, событие `workflow_blocked {taskId, runId, nodeId?, reason}` уходит координатору
(и уведомлением человеку). Когда бывает:
- воркер или проверка не запустились (агент роли выключен, роли нет) — в `reason` команда `orca-board worker start
  --task <id>` для повтора;
- проверка сдана без решения — в `reason` `orca-board task reopen --task <id> --start`;
- у ноды нет перехода для исхода, роль гейта удалили, воркер сдал работу не на этапе «Работа»;
- мерж упал не конфликтом (например, не удалось закоммитить хвосты);
- нода `git` настроена неверно (нет операции или обязательного поля, недопустимое имя ветки после подстановки) — отказ самого
  git сюда не относится: это исход `error` ноды (см. «Нода Git»);
- больше 50 переходов подряд без ожидания (цикл через мерж).

Человек разблокирует задачу в приложении: «Принять» / «Вернуть» у задачи на этапе проверки — это исход этапа.

## CLI и сокет

```
orca-board workflow show [--run <id>]     # этапы и переходы: снимок прогона (координатору --run из $ORCA_RUN_ID) или граф проекта
orca-board task get --task <id>           # stage задачи, gateFor у проверки
orca-board review accept --task <id>      # на этапе проверки — исход accept
orca-board review reject --task <id> --feedback "..."
orca-board request resolve --request <id> --accept | --reject "..."   # approval
```

Ответ `workflow.show`: `{source: 'run' | 'project' | 'default', run?, stages}`, `stages` — `describeWorkflow`:
этапы в порядке обхода от старта с `type`, `title`, `roleId?`, `instructions?`, `showcase?` (у работы), `condition?`, `git?` (у ноды `git`) и `next` (исход →
«название (id)» ноды).

## Ограничения

- Граф — у типа задачи, в одном проекте глобальные задачи разных типов идут разными графами; правка графа типа
  действует с нового прогона. «Входящие» и прогоны без снимка идут по графу **типа проекта по умолчанию**, переведённому в граф подзадач
  (`toTaskScopeWorkflow`; до типов задач «Входящие» шли по дефолтному графу ролей, а не по графу проекта). Колонки нод по доске не проверяются: тип
  общий для проектов с разными колонками, переход в неизвестную колонку пропускается.
- Эффект, не доведённый до конца из-за выхода приложения (например, проверка не успела создаться), после рестарта
  сам не повторяется: задачу в «Ревью» примет или вернёт человек. Исключение — `done` сохранён, а `worker_done`
  не обработан до выхода: задача в «Ревью», но на этапе «Работа», и «Принять» / «Вернуть» отвечают ошибкой — выход
  только перезапуск воркера (`worker start`). Живые запуски после рестарта закрываются как `unknown`, задача
  (и проверка) — в ready на своём этапе; повторный запуск повтором не считается (`visits` не растут).
- Решение человека (`human` → «Вернуть» → работа) останавливает цикл так же, как `attempts`: предупреждение
  валидации о бесконечных отказах такие циклы не учитывает.
- Условие `files` и параллельные проверки не поддерживаются.
