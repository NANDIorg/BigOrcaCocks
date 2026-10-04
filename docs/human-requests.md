# Запросы к человеку (`HumanRequest`)

Всё, что ждёт решения человека, хранится как одна запись `HumanRequest`: вопрос воркера, сданный ответ
задачи-ответа, упавший воркер, этап воркфлоу «человек» (`approval`, `docs/workflow.md`) и выбор ветки «Решения ИИ», когда агент не выбрал (`decision`). Статус хранится явно (`pending → resolved | cancelled`) и не выводится из колонок,
вопросов или живости координатора. Колонка «Нужен ответ» на обеих досках, счётчик `GlobalTask.waiting`,
уведомления и Инбокс строятся по одному условию: **у прогона или задачи есть `pending`-запрос**
(`isPendingRequest` / `pendingRequestsOf` / `hasPendingRequest`, `packages/core/src/global-tasks.ts`).

Код: типы — `packages/core/src/types.ts` («запросы к человеку»), переходы — `packages/core/src/store.ts`
(`createRequest`, `resolveRequest`, `cancelRequests`), общий application API —
`packages/contracts/src/human-request-commands.ts`, runtime `human-request-commands.ts`
и `review-operations.ts`. Desktop adapter — `main/review-request-commands.ts`,
`socket.ts` (`request.*`, `worker.ask`), `request-params.ts` (разбор флагов CLI),
`notify.ts`. Тесты — `packages/core/src/answers.test.ts`, `requests.test.ts`.

Перед ответом человеку Desktop/socket сверяют живость через общий
`TaskWorkerLifecycle.syncWorkerLiveness` (`packages/runtime/src/task-worker-lifecycle.ts`):
dispatch закрываются только если все активные PTY задачи мертвы. Сам sync не
переносит колонку; дальнейший переход делает прежний request/question guard.
Перезапуск после уточнения использует общую `WorkerOperations.start`: preflight
фактической роли и enterWork предшествуют закрытию старого PTY. Application API
`WorkerCommands`, `ReviewCommands` и `HumanRequestCommands` общие: policy/context
и payload проверяются до project lookup/effects, id вопроса/запроса принадлежит
именно указанному store. Executor сохраняет human/cli/app источник и отделяет DTO.
Public resolution не принимает server paths; байты вложений идут отдельным input.
Legacy Desktop/socket отбрасывают resolution.images, пути формируют только общие
resources. Router сохраняет taskless approval/decision прогона, duplicate/stale
guards, rollback orphan файлов и durable feedback после решения.

Библиотека типов и графов теперь также имеет общий profile API; конфигурация проекта
требует явный project context. Эти команды используют прежние guards ProjectManager
и не решают pending запросы выбранной в другом клиенте доски.
Desktop settings/types/templates вызывают этот API через проверенный profile adapter;
agent socket сохраняет прежние trusted методы и ограничения передачи приватных полей.

Общие правила/статистика получают явный проект и не изменяют pending запросы
другого клиента. Статистические показатели ожидания человека строятся из снимка,
отделённого до async чтения; поздняя запись найденного session id проходит проверку
project/store/dispatch. Полномочия отвечать человеку от чтения статистики не появляются.
Desktop stats IPC использует общий API и переводит Promise rejection в прежний
локализованный IPC code; rules IPC и agent project.rules.* используют одну factory.

Общая preview policy ограничивает недоверенную страницу root её grant и прежним
sandbox/CSP. Проектные документы не получают network, показы — лишь со snapshot.
FileCommands требуют явный проект и host policy, не решают и не потребляют
pending-запросы. После удаления проекта поздний file result/native effect отклонён;
Desktop IPC проверяет caller до выбора проекта и вызывает общий API.

Run list/counts и agent preflight не потребляют check и не отвечают человеку.
Preflight проверяет роль, доступность агента и флаги сохранённого снимка до launch;
явный неизвестный run отклонён, а не заменяется default типом другого прогона.
Desktop Git/runs/agents channels проверяют caller до чтения legacy selection;
чтение прогонов из UI не меняет доступность pending ответов в agent socket.

Наблюдатель терминала не получает writer capability из подписки. Смена writer не
отвечает на request/question и не потребляет agent check; после disconnect pending
запрос продолжает ожидать ответа, а процесс сохраняется.

Ответы на permission/question структурного чата проходят общий DialogCommands или
compatibility AssistantCommands: shape validation до provider, затем проверка живого
request/turn и вариантов самим driver. История диалога после stop/restart read-only,
не воспроизводит tool calls и не принимает прежний permission. HumanRequest доски
сохраняет собственный существующий lifecycle.

Desktop assistantChat send/respond теперь вызывает общий compatibility API через
проверенное главное окно; локализованная domain ошибка сохраняется при Promise.
PTY input/resize auto claim не выполняется для malformed payload, а отказ event
пишется в logger. Отключение окна освобождает его writer, pending запрос остаётся.

Review/request effects подключены к общему async runtime: commit/review/merge/cleanup
занимают одну transaction canonical commonDir queue, preview не удерживает mutation
queue. Долгий hook не блокирует PTY/другой repo. Ожидание человека остаётся вне Git queue.
Именованные review/Git helpers тоже возвращают Promise через общий port, без sync-дубликата.
GitProcessService закрывает stdin, ограничивает output, при stop/timeout завершает hooks.

EffectScope проверяет captured project/store/task/run identity, node/visit/lane/dispatch
и host policy после await до следующего эффекта. Stale/forbidden не пишут feedback и не
эскалируют новый dispatch. Уже durable решение не откатывается при failed launch; вкладка
другого клиента не выбирается. Human/cli/app source захватывается до ожидания, graph phases
пишут workflow; глобальный withStatusSource не удерживается через Promise.

Вложения ожидают весь async apply. При актуальной позиции файлы без ссылок убираются после отказа; referenced
feedback/stageInput остаются при ошибке последующего запуска. Request/review commands,
Desktop adapters и legacy socket ожидают Promise до ответа. Optional entry commit marker
best-effort при native read error, но policy/position errors не подавляются.

Подготовка feature run разделяет один Git effect между ожидающими с отдельным domain
guard каждого. Git metadata не отменяет соседний lane и отдельно проверяется branch port.
Уже случившийся native effect не откатывается после отмены и может требовать восстановления:
persistent journal/reconciliation подключены. Profile/docs/preview Git reads тоже async:
root probe проверяет policy перед записью, отмена docs не скрывается fallback/пропуском группы.

## Модель

```ts
type HumanRequestKind = 'question' | 'answer' | 'escalation' | 'approval' | 'decision'
type HumanRequestStatus = 'pending' | 'resolved' | 'cancelled'
interface RequestOption { id: string; label: string; hint?: string; recommended?: boolean }  // id — номер варианта: "1", "2"…
interface RequestResolution { action: 'answer' | 'accept' | 'clarify' | 'restart' | 'dismiss' | 'reject'; optionId?: string; text?: string; images?: string[] }

interface HumanRequest {
  id: string                 // req_…
  runId: string              // прогон = глобальная задача
  taskId?: string            // нет у approval и decision уровня прогона (ноды human / decision воркфлоу глобальной задачи, `docs/workflow.md`): их решают по runId
  dispatchId?: string        // запуск, который спросил / сдал ответ / упал
  kind: HumanRequestKind
  status: HumanRequestStatus
  title: string              // вопрос / summary ответа / причина эскалации / «<этап>: <задача>»
  body?: string              // markdown: контекст вопроса (+ «**Координатор:** …» из forward --note) или сам ответ
  options: RequestOption[]   // у question и decision (у decision — варианты ноды: id варианта, label, hint = description); у answer/escalation/approval действия встроены
  questionId?: string        // kind=question: исходный Question (ask держит соединение за него)
  nodeId?: string            // kind=approval: нода human воркфлоу, на которой ждёт задача; kind=question: нода ask, с которой задан вопрос (Инбокс показывает «Этап «…»»)
  showcaseDispatchId?: string // kind=approval: запуск, чей показ (Dispatch.showcase) в body; файлы — IPC showcase:*
  showcaseDispatchIds?: string[] // approval прогона: запуски всех подзадач с показом по порядку; showcaseDispatchId — последний из них
  fallback?: 'unsure' | 'no_answer' | 'start_failed'  // kind=decision: почему решает человек → StageDecision.fallback
  agentNote?: string          // kind=decision: комментарий агента (decision escalate --reason, сводка done) → StageDecision.agentNote; он же в body
  resolution?: RequestResolution
  createdAt: number
  resolvedAt?: number        // решён или отменён
}
```

Допустимые решения по виду запроса — `REQUEST_ACTIONS`:

| `kind` | Откуда | Решения |
|---|---|---|
| `question` | вопрос воркера (`ask`) адресован человеку | `answer` (вариант `optionId` и/или `text`) |
| `answer` | задача-ответ `answerFor: 'human'` сдала `done --answer-file` | `accept` (`text` — решение), `clarify` (`text` — уточнение) |
| `escalation` | PTY текущего запуска закрылся без `orca-board done` | `restart`, `dismiss` |
| `approval` | рабочая задача (движок подзадач) или **глобальная задача** (воркфлоу прогона: «Проверка человеком», без `taskId`, `requestRunApproval`) пришла на ноду `human` воркфлоу (`docs/workflow.md`): ревью человеком, конфликт мержа | `accept` (`text` — комментарий), `reject` (`text` — замечания воркеру) |
| `decision` | **глобальная задача** стоит на ноде «Решение ИИ» (`decision`, без `taskId`, `requestRunDecision`), а агент-решатель не выбрал ветку: `decision escalate`, `done` без выбора, воркер не запустился | `answer` (`optionId` — обязательно, из `options`; `text` — обоснование человека) |

`Question` остаётся: это канал «воркер ↔ отвечающий». Запрос создаётся по нему, только когда адресат — человек
(`Question.forHuman = true`). Адресат определяется **в момент создания** и потом не пересчитывается.

## Переходы

Каждый переход — один метод store, один commit и одно событие. Пока запрос `pending`, задача (если она не в done)
стоит в `kind=needs_input`. Решили запрос и других `pending` у задачи нет — задача возвращается в поток
(`settleTask`: живой воркер → in_progress, иначе ready).

У approval прогона (без `taskId`) задачи нет, потока задачи тоже: пока запрос `pending`, карточка глобальной задачи стоит в «Проверке» (`kind=review`) и в «Нужен ответ» не
поднимается; решение двигает граф прогона (`handleRunRequest` в `workflow-run.ts`), а не задачу. Запрос `decision` тоже без задачи, но
карточка глобальной задачи идёт в работе — пока он `pending`, она поднимается в «Нужен ответ» (`globalDisplayStatus`: любой pending-запрос прогона).

### Создание (`createRequest`, событие `request_created`)

| Источник | Метод store | Условие | Запрос |
|---|---|---|---|
| Воркер спросил, координатор не жив | `ask(…, {coordinatorAlive: false})` | «Входящие», нет PTY координатора, `runs finish`, прогон закрыт (`coordinatorAlive` в `socket.ts`) | `question` |
| Воркер спросил на этапе «Вопрос человеку» | `ask(…, {forceHuman: true})` | задача стоит на ноде `ask` (`taskStageNode` в `worker.ask`) — при любом координаторе, живом тоже | `question`, `nodeId` — нода `ask` (и в `Question.nodeId`) |
| Координатор передал вопрос | `forwardQuestion(id, note?)` | вопрос не отвечен; уже переданный — без изменений | `question`, `note` — в `body` |
| Координатор умер | `escalateOpenQuestions(runId)` | выход PTY координатора (`worker.ts`), загрузка проекта (`projects.ts`) | `question` на каждый его открытый вопрос текущего запуска |
| Сдан ответ для человека | `finishDispatch` | `task.answerFor === 'human'` | `answer`, `body` — ответ; `request_created` идёт после `worker_done` |
| Этап воркфлоу «человек» | `requestApproval` (зовёт исполнитель в main) | задача пришла на ноду `human`; ждущий approval задачи не дублируется | `approval`, `body` — инструкция ноды, текст конфликта мержа, итог воркера, показ («## Показ»: текст и файлы, `showcaseDispatchId`), ветка |
| Этап воркфлоу глобальной задачи «человек» | `requestRunApproval` (зовёт исполнитель в main) | граф прогона пришёл на ноду `human`; ждущий approval той же ноды не дублируется (у путей разветвления — по запросу на ноду; «Подтвердить» / «Вернуть» на карточке при нескольких ждущих — ошибка `RunApprovalAmbiguousError`, решать в Инбоксе) | `approval` **без задачи** (`taskId` нет, `runId` — прогон); карточка на «Проверке», «Подтвердить» / «Вернуть в работу» решают запрос; `request_created` и `request_resolved` несут `runId` |
| «Решение ИИ»: агент не выбрал ветку | `requestRunDecision` (зовёт движок прогона в main: `escalateDecision`, `settleDecision`, `createDecision`) | граф прогона стоит на ноде `decision`, и агент вызвал `decision escalate` (`fallback: 'unsure'`), сдал `done` без выбора (`no_answer`) или его воркер не запустился (`start_failed`); ждущий `decision` той же ноды не дублируется. Воркер упал без `done` — не сюда, а `escalation` с «Перезапустить» | `decision` **без задачи**, `nodeId` — развилка, `options` — варианты ноды, `body` — вопрос, варианты, почему решает человек, комментарий агента, сводки этапов, ветка |
| Воркер вышел без `done` | `ptyExited` | запуск текущий, задача не в done и у неё нет pending-вопроса к человеку (ответ сам вернёт её в ready) | `escalation` (вдобавок к событию `escalation` координатору) |
| Загрузка снапшота | `migrateRequests` | открытые вопросы текущих запусков (PTY после перезапуска нет); снапшот до `HumanRequest` — ещё сданные ответы и упавшие воркеры в needs_input | как выше, без событий |

Пока координатор жив, вопрос воркера ждёт его: запроса нет, задача in_progress, человеку ничего не приходит.

### Решение (`resolveRequest`, для человека — `resolveHumanRequest` в main)

| Запрос + решение | Что происходит | Событие |
|---|---|---|
| `question` + `answer` | ответ на `Question`: метка варианта и текст через « — »; вопрос закрыт | `question_answered` |
| `answer` + `accept` | git-часть приёмки (`acceptReview`: слить коммиты, убрать worktree), задача → done | `answer_accepted` (`decision` = `text`) |
| `answer` + `clarify` | `feedback` = уточнение, задача → ready, **main сразу стартует воркера** | `answer_clarified {…, images?}` |
| `escalation` + `restart` | задача → ready, **main сразу стартует воркера** | `request_resolved {action: 'restart'}` |
| `escalation` + `dismiss` | запрос скрыт, задача из needs_input → ready | `request_resolved {action: 'dismiss'}` |
| `approval` + `accept` | запрос решён, задача из needs_input; **main переводит задачу по исходу accept** (дефолт — мерж и done) | `request_resolved {kind: 'approval', action: 'accept', nodeId, decision?}` (`decision` = `text`, например выбранный вариант) |
| `approval` + `reject` | `feedback` = замечания, **main переводит по исходу reject** (дефолт — снова в работу, воркер стартует сразу) | `request_resolved {kind: 'approval', action: 'reject', nodeId, decision?, images?}` (`decision` = замечания) |
| `approval` прогона (без `taskId`) + `accept` / `reject` | запрос решён; движок прогона (`handleRunRequest`) идёт по исходу ноды `human`, если прогон всё ещё стоит на ней: `accept` — `decision` (текст) в `stage_started` следующей «Работы», `reject` — `feedback` (замечания, они же в `Run.returns`; `images` — в `stageInput` и `stage_started`); решение по уже неактуальной ноде ничего не двигает | `request_resolved {runId, kind: 'approval', action, nodeId, decision?, images?}` (без `taskId`) |
| `decision` + `answer` | `optionId` обязателен и должен быть среди `options` (иначе ошибки `запрос <id>: выбери вариант — optionId обязателен` / `варианта «<x>» у запроса <id> нет`), запрос решён; движок прогона (`handleRunRequest` → `runDecisionResolved`) ведёт граф по ребру варианта, если прогон всё ещё на развилке, и пишет `StageDecision {by: 'human', fallback, agentNote, reason: text}` в историю; варианта уже нет в графе — `workflow_blocked` | `request_resolved {runId, kind: 'decision', action: 'answer', nodeId, optionId, decision?}` (`decision` = `text`, без `taskId`) |
| не `pending` | ошибка «уже решено: запрос … решён/отменён» | — |

**Картинки к «Уточнить» / «Вернуть».** Раздел — про картинки **и любые файлы**: правила одинаковы для вложений любого типа (поле `images` — историческое имя).
IPC `requests:resolve(id, resolution, images?)` принимает байты вложений (любой тип файла, `validateAttachments`, лимиты
`ATTACHMENT_LIMITS`: 8 шт., 25 МБ каждый, 50 МБ всего; имена на диске — `image-N.<ext>` / `file-N-<slug>.<ext>`) только для `clarify` и `reject` — к остальным действиям они дают ошибку `attachments.notForAction`, а без текста — `attachments.needText`.
Main пишет файлы в cwd читателя (`resolveWithImages`, `src/main/attachments.ts`): запрос на задаче — в worktree воркера, approval прогона (без `taskId`) — в cwd
координатора — и ставит `resolution.images` (абсолютные пути). `resolution.images`, присланные renderer-ом или сокетом (`request resolve` картинок не принимает),
вырезаются. Пути идут дальше вместе с текстом: `task.feedbackImages` (воркер видит их в промпте под замечаниями/уточнением), `stageInput.images` и `stage_started.images`
(координатор), в событиях `answer_clarified` / `request_resolved`. Не удалось записать файлы (нет worktree, ошибка диска) — ошибка **до** решения: запрос остаётся ждать,
текст в форме. Подробности и откат — `docs/architecture.md`, «Изображения при возврате в работу».

Не удалось стартовать воркера после `clarify`/`restart` — запрос всё равно решён (задача в ready с уточнением),
координатору уходит `escalation {reason: «… воркер не запустился: …», requestId, startFailed: true}`.

Старые пути ведут в те же переходы: `question answer` и IPC `questions:answer` закрывают запрос вопроса,
`review accept` — запрос `answer` (с решением `--decision`), `review reject` — это `clarify` (без старта воркера).
У задачи на ноде `human` `review accept` / `review reject` (и «Принять» / «Вернуть» в модалке задачи) решают её
запрос `approval` (`reviewAccept` / `reviewReject` в `src/main/workflow.ts`).

### Отмена (`cancelled`, без события)

Запрос теряет смысл — он отменяется, и ответить на него больше нельзя:
- новый запуск задачи (`startDispatch`) — старый ответ, эскалация и вопрос прошлого запуска больше не ждут;
- воркер сдал работу (`finishDispatch`) — прежние запросы задачи; ответ для человека тут же создаётся заново;
- задача удалена; глобальная карточка вручную перенесена в done (`moveGlobalTask`); у approval прогона — ещё и граф дошёл до `end` (`cancelRequests` по `runId`, ответить на запрос уже нечего);
- запрос `decision` — граф ушёл с его развилки любым путём (агент успел выбрать, ноду вернули руками): `moveRunStage` отменяет pending `decision` этой ноды.

## События

Payload короткие: строка события в мониторе координатора обрезается. Длинные тексты (вопрос, контекст, ответ)
читаются командой, а не из события.

| Событие | Payload | Полный текст |
|---|---|---|
| `request_created` | `taskId?` (нет у approval и decision прогона), `requestId, kind, title` (≤ 300 символов), `runId, dispatchId?, questionId?` | `orca-board request get --request <id>` |
| `question` | `taskId, dispatchId, questionId, question` (≤ 300), `forHuman?: true, options` (метки) | `orca-board question get --question <id>` |
| `question_answered` | `taskId, dispatchId, questionId, requestId?, question, answer, workerLive, status` | — |
| `answer_accepted` | `taskId, decision?, summary?, requestId?, dispatchId, answerFor, answer` (≤ 2000), `answerTruncated?` | `orca-board task answer --task <id>` |
| `answer_clarified` | `taskId, feedback` (≤ 300), `requestId, dispatchId`, `images?` (пути приложенных к уточнению файлов — скриншоты, документы, логи; читает воркер) | `orca-board request get --request <id>` (`resolution.text`) |
| `request_resolved` | `taskId` (у approval и decision прогона вместо него `runId`), `action` (`restart`/`dismiss`/`accept`/`reject`/`answer`), `requestId, kind, dispatchId?, nodeId?` (approval, decision), `optionId` (decision — выбранный вариант), `decision` (≤ 2000, текст решения по approval, обоснование по decision), `decisionTruncated?`, `images?` (пути приложенных к замечаниям `reject` файлов) | `orca-board request get --request <id>` (`resolution.text`) |
| `worker_done` | `taskId, dispatchId, summary, files, answerFor?, gateFor?, requestId?, answer` (≤ 2000), `answerTruncated?` | `orca-board task answer --task <id>` |

Уведомление «нужен ваш ответ» (`notifyKind`, `notify.ts`) приходит только на `request_created` (вопрос / ответ
готов / эскалация / approval — вид «Воркер завершил задачу», текст «Ждёт решения»; `decision` — как вопрос); кроме него человеку сообщают
лишь `escalation` с `stuck: true`, `workflow_blocked` (вид «Эскалация», «Воркфлоу остановлен»), `worker_done`
рабочей задачи (не проверки) и `run_done`. Клик по нему открывает Инбокс на этом запросе
(`requests:focus`). Событие `question`, на которое отвечает координатор, человеку не приходит.

## Доставка ответа воркеру

1. `orca-board ask` держит соединение и печатает `Question` с `answer`, как только на него ответили.
2. Инструмент оборвал `ask` по таймауту — воркер повторяет **ту же** команду. У запуска не может быть
   двух открытых вопросов: `store.ask` вернёт уже открытый, а `worker.ask` сразу отдаст ответ, если он пришёл.
3. `ask` уже не ждёт, а воркер жив — main пишет в его терминал короткий пинок
   `[orca] на вопрос q_… ответили: orca-board request get --request req_…` (без запроса — `question get`;
   `deliverAnswers` в `index.ts`, `answerNudge` в `notify.ts`). Ответ воркер забирает этой командой (поле `answer`).
4. Воркер мёртв (`question_answered.workerLive: false`, задача в ready) — координатор делает `worker start`,
   ответ попадает в промпт (раздел «Ответы на вопросы по задаче», `workerTaskPrompt`). Задача на этапе `ask` —
   воркера стартует само приложение (`handleEvents` в `workflow.ts`), координатору `worker start` не нужен; этап не
   сбрасывается (`store.enterWork`), роль ноды не становится ролью задачи (`docs/workflow.md`, «Вопрос человеку»).

## В интерфейсе (renderer)

Инбокс (`InboxPanel`), карточка глобальной доски (`GlobalBoard`) и `RequestCard` работают и с запросами **без `taskId`** (approval прогона): `where` —
«глобальная задача › нода воркфлоу» (`wfNodeTitles` по графу прогона), а кнопки, которым нужна задача («Терминал», «Открыть полностью»), не показываются.
Какие показы выводить, решает `requestShowcases` (`renderer/src/showcase.ts`): у approval — `showcaseDispatchIds`, а у старых запросов (только
`showcaseDispatchId`) — одиночный id; у `answer` — показ запуска, сдавшего ответ (`dispatchId`: `done --answer-file … --show …`). Файлы каждого показа
читаются из задачи его запуска: у approval прогона своей задачи нет. Запусков с показом может быть несколько — по одному на подзадачу; тогда
`RequestCard` рисует `ShowcaseGroupsBlock` — блок на подзадачу с цветной полосой её состояния по колонке (готово / на проверке / в работе), числом
файлов, сворачиванием и «Смотреть»; просмотрщик получает те же группы деревом «подзадачи → файлы». Разделы «## Показ» (у approval прогона — вместе с
заголовком `### <подзадача>`) вычитаются из свёрнутого body (`bodyWithoutShowcases`). Решение («Принять» / «Вернуть…», у `answer` — «Уточнить…» и
поле «Решение») доступно и внизу просмотрщика: поле общее с карточкой. Файлы читаются из снимка запуска
(`<userData>/showcase`, снят при `done`), поэтому доступны и после мержа подзадачи (`docs/workflow.md` → «Показ человеку» → «Снимок»).
Markdown из показа рендерится с контекстом файла (`Markdown` с `assets`, `renderer/src/markdownAssets.ts`): относительная картинка `![](shots/a.png)`
грузится из того же снимка по `orca-preview://<токен>/…` (`base` из `showcase:previewUrl`), `..` за корень показа, абсолютные пути, `https://` и
`data:` — не грузятся (вместо картинки — подпись с `alt`); относительная ссылка на другой файл показа открывает его в просмотрщике. Страницы HTML из показа открываются в изолированном
фрейме по протоколу `orca-preview://` без сети (`docs/architecture.md` → «Протокол показа»), поэтому воркер сдаёт их автономными — правила ему даёт
раздел «Этап» промпта (`docs/workflow.md` → «Показ человеку» → «Промпт»). Лента «Ждут вас» на экране глобальной задачи строится по подзадачам и approval прогона не показывает — его решают кнопками «Подтвердить» /
«Вернуть в работу…» в шапке, на карточке и в «Итоге и цели» (`docs/nested-kanban.md`, «Проверка»), либо в Инбоксе. Показ подзадач выводится и там: во
вкладке «Итог и цель» на «Проверке» и в окне `AcceptGlobalModal` (там же — поле решения в просмотрщике). Поле «Решение» у «Принять» в Инбоксе и в окне
`AcceptGlobalModal` — один и тот же `resolution.text`.

Пункты ленты `review` («Ждёт ревью») и `stalled` («Этап остановлен») — **состояние задачи, а не `HumanRequest`**: у них нет запроса, решение уходит
в `review.accept` / `review.reject` по задаче (у `approval` — `requests.resolve` по запросу). Строятся они по колонке **и** ноде этапа
(`reviewStateOf` в `renderer/src/taskReview.ts`): задача в колонке `review`, не ответ (`answerFor`) и не проверка (`gateFor`), без pending-запроса
(иначе пункт — сам запрос). Нода этапа — в том же графе, что у движка (`stageNodeOf`: путь подзадачи, граф прогона или граф по подзадачам старого
движка). Нода `gate`/`human` или задача без `Task.stage` — `review` («Принять» / «Вернуть…»). Любая другая нода (`merge`, `git`, `end`, `work`) —
`stalled`: колонка «Ревью», а воркфлоу стоит (мерж упал или прервался рестартом). Заголовок — причина остановки из `Task.stageBlock` этой ноды,
без неё — «Этап «Мерж» не завершён». Кнопки: «Повторить мерж» (на прочих нодах — «Продолжить этап»; это `review.accept`, main повторяет эффект ноды),
«Вернуть в работу…» (`review.reject` с замечаниями) и «Открыть». Графа нет (старый main, типы не пришли) — остановка видна только по `stageBlock`,
иначе прежний `review`. Старый main на «Повторить» отвечает прежней ошибкой без кода — лента показывает её текст и подсказку перезапустить
приложение. То же правило берут счётчик ревью на карточке глобальной задачи (остановленные этапы в нём не считаются), карточка задачи
(`TaskModal`: блок «Этап остановлен» с причиной вместо «Ревью») и карточка подзадачи на доске (строка сути «⏸ Этап остановлен» вместо «Ждёт ревью»,
причина — в подсказке; `stalledCardReason`).

Запрос `decision` в `RequestCard` — те же кнопки вариантов, что у `question` (горячие клавиши 1–9, пояснение `hint`), над ними — почему решает
человек (`fallback`: ИИ не уверен / завершил, не выбрав / не запустился), вместо «Свой ответ» — необязательное поле «Обоснование». Клик по варианту —
`resolve({action: 'answer', optionId, text?})`, IPC тот же. Запрос без `options` (битые данные) карточку не роняет.

## CLI

```
# воркер
orca-board ask --question "Какую БД взять?" \
  --option "sqlite|проще, без сервера" --option "postgres|если нужен шаринг" \
  --recommend sqlite --context-file why.md       # --options a,b — старая форма, split по запятой
orca-board request get --request <id>           # забрать ответ по пинку в терминале
# координатор
orca-board question forward --question <id> [--note "моё мнение: sqlite"]
orca-board request list [--run <id>] [--all]    # pending прогона ($ORCA_RUN_ID); --all — и решённые
orca-board request get --request <id>
# человек (или координатор от его имени)
orca-board request resolve --request <id> --option <id|метка> [--text "..."]   # вопрос; у decision — выбор ветки, --text — обоснование
orca-board request resolve --request <id> --text "..."
orca-board request resolve --request <id> --accept [--decision "..."]   # ответ или approval
orca-board request resolve --request <id> --clarify "..."
orca-board request resolve --request <id> --reject "..."                  # approval: вернуть с замечаниями
orca-board request resolve --request <id> --restart | --dismiss
```

`--option` повторяется, запятая в метке допустима, `|` отделяет пояснение. `--recommend` и `request resolve
--option` принимают номер варианта или метку (без учёта регистра); CLI шлёт `option` массивом — `request.resolve`
принимает строку или массив из одного элемента. У `request resolve` нужно ровно одно
действие; `--decision` — только с `--accept`. `request get` у вопроса добавляет поле `answer`.

Сокет: `request.list {run?, all?}`, `request.get {request}`, `request.resolve {request, option?|text?|accept|clarify|reject|restart|dismiss, decision?}`,
`question.forward {question, note?}`, `worker.ask {question, option[]|options, recommend?, context?, wait?}`
(`--context-file` читает CLI и шлёт текст в `context`).
IPC: `requests:list({runId?, pending?})`, `requests:resolve(id, resolution)`, событие `requests:focus`.

Внешние Git/PTY/file effects используют persistent `effect-journal.json` version1. При restart неизвестный результат matching позиции останавливает автоматический повтор; read-only recovery показывает ресурсы и generation, а revision-checked operator resolution разрешает дальнейшие действия без удаления файлов, веток или самостоятельного повторения операции. Scope подтверждает только собственные эффекты после успешной записи metadata; новые visits/dispatch не принимают старый результат.

### Повтор ответа после reconnect

Общий operator session принимает host-verified principal и mutation identity. Один request id с прежним payload возвращает сохранённый accepted result; другой payload конфликтует. Pending запрос после restart требует явной сверки, без автоматического повторного ответа. Каждый клиент имеет собственные selection и observer subscription; disconnect не завершает процессы owner. Transport/UI wiring следует после общей composition.
