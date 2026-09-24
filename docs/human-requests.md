# Запросы к человеку (`HumanRequest`)

Всё, что ждёт решения человека, хранится как одна запись `HumanRequest`: вопрос воркера, сданный ответ
задачи-ответа, упавший воркер и этап воркфлоу «человек» (`approval`, `docs/workflow.md`). Статус хранится явно (`pending → resolved | cancelled`) и не выводится из колонок,
вопросов или живости координатора. Колонка «Нужен ответ» на обеих досках, счётчик `GlobalTask.waiting`,
уведомления и Инбокс строятся по одному условию: **у прогона или задачи есть `pending`-запрос**
(`isPendingRequest` / `pendingRequestsOf` / `hasPendingRequest`, `packages/core/src/global-tasks.ts`).

Код: типы — `packages/core/src/types.ts` («запросы к человеку»), переходы — `packages/core/src/store.ts`
(`createRequest`, `resolveRequest`, `cancelRequests`), транспорт — `apps/desktop/src/main/review.ts`
(`resolveHumanRequest`), `socket.ts` (`request.*`, `worker.ask`), `request-params.ts` (разбор флагов CLI),
`notify.ts`. Тесты — `packages/core/src/answers.test.ts`, `requests.test.ts`.

## Модель

```ts
type HumanRequestKind = 'question' | 'answer' | 'escalation' | 'approval'
type HumanRequestStatus = 'pending' | 'resolved' | 'cancelled'
interface RequestOption { id: string; label: string; hint?: string; recommended?: boolean }  // id — номер варианта: "1", "2"…
interface RequestResolution { action: 'answer' | 'accept' | 'clarify' | 'restart' | 'dismiss' | 'reject'; optionId?: string; text?: string }

interface HumanRequest {
  id: string                 // req_…
  runId: string              // прогон = глобальная задача
  taskId: string
  dispatchId?: string        // запуск, который спросил / сдал ответ / упал
  kind: HumanRequestKind
  status: HumanRequestStatus
  title: string              // вопрос / summary ответа / причина эскалации / «<этап>: <задача>»
  body?: string              // markdown: контекст вопроса (+ «**Координатор:** …» из forward --note) или сам ответ
  options: RequestOption[]   // только у question; у answer/escalation/approval действия встроены
  questionId?: string        // kind=question: исходный Question (ask держит соединение за него)
  nodeId?: string            // kind=approval: нода human воркфлоу, на которой ждёт задача
  showcaseDispatchId?: string // kind=approval: запуск, чей показ (Dispatch.showcase) в body; файлы — IPC showcase:*
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
| `approval` | рабочая задача пришла на ноду `human` воркфлоу (`docs/workflow.md`): ревью человеком, конфликт мержа | `accept` (`text` — комментарий), `reject` (`text` — замечания воркеру) |

`Question` остаётся: это канал «воркер ↔ отвечающий». Запрос создаётся по нему, только когда адресат — человек
(`Question.forHuman = true`). Адресат определяется **в момент создания** и потом не пересчитывается.

## Переходы

Каждый переход — один метод store, один commit и одно событие. Пока запрос `pending`, задача (если она не в done)
стоит в `kind=needs_input`. Решили запрос и других `pending` у задачи нет — задача возвращается в поток
(`settleTask`: живой воркер → in_progress, иначе ready).

### Создание (`createRequest`, событие `request_created`)

| Источник | Метод store | Условие | Запрос |
|---|---|---|---|
| Воркер спросил, координатор не жив | `ask(…, {coordinatorAlive: false})` | «Входящие», нет PTY координатора, `runs finish`, прогон закрыт (`coordinatorAlive` в `socket.ts`) | `question` |
| Координатор передал вопрос | `forwardQuestion(id, note?)` | вопрос не отвечен; уже переданный — без изменений | `question`, `note` — в `body` |
| Координатор умер | `escalateOpenQuestions(runId)` | выход PTY координатора (`worker.ts`), загрузка проекта (`projects.ts`) | `question` на каждый его открытый вопрос текущего запуска |
| Сдан ответ для человека | `finishDispatch` | `task.answerFor === 'human'` | `answer`, `body` — ответ; `request_created` идёт после `worker_done` |
| Этап воркфлоу «человек» | `requestApproval` (зовёт исполнитель в main) | задача пришла на ноду `human`; ждущий approval задачи не дублируется | `approval`, `body` — инструкция ноды, текст конфликта мержа, итог воркера, показ («## Показ»: текст и файлы, `showcaseDispatchId`), ветка |
| Воркер вышел без `done` | `ptyExited` | запуск текущий, задача не в done и у неё нет pending-вопроса к человеку (ответ сам вернёт её в ready) | `escalation` (вдобавок к событию `escalation` координатору) |
| Загрузка снапшота | `migrateRequests` | открытые вопросы текущих запусков (PTY после перезапуска нет); снапшот до `HumanRequest` — ещё сданные ответы и упавшие воркеры в needs_input | как выше, без событий |

Пока координатор жив, вопрос воркера ждёт его: запроса нет, задача in_progress, человеку ничего не приходит.

### Решение (`resolveRequest`, для человека — `resolveHumanRequest` в main)

| Запрос + решение | Что происходит | Событие |
|---|---|---|
| `question` + `answer` | ответ на `Question`: метка варианта и текст через « — »; вопрос закрыт | `question_answered` |
| `answer` + `accept` | git-часть приёмки (`acceptReview`: слить коммиты, убрать worktree), задача → done | `answer_accepted` (`decision` = `text`) |
| `answer` + `clarify` | `feedback` = уточнение, задача → ready, **main сразу стартует воркера** | `answer_clarified` |
| `escalation` + `restart` | задача → ready, **main сразу стартует воркера** | `request_resolved {action: 'restart'}` |
| `escalation` + `dismiss` | запрос скрыт, задача из needs_input → ready | `request_resolved {action: 'dismiss'}` |
| `approval` + `accept` | запрос решён, задача из needs_input; **main переводит задачу по исходу accept** (дефолт — мерж и done) | `request_resolved {kind: 'approval', action: 'accept', nodeId, decision?}` (`decision` = `text`, например выбранный вариант) |
| `approval` + `reject` | `feedback` = замечания, **main переводит по исходу reject** (дефолт — снова в работу, воркер стартует сразу) | `request_resolved {kind: 'approval', action: 'reject', nodeId, decision?}` (`decision` = замечания) |
| не `pending` | ошибка «уже решено: запрос … решён/отменён» | — |

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
- задача удалена; глобальная карточка вручную перенесена в done (`moveGlobalTask`).

## События

Payload короткие: строка события в мониторе координатора обрезается. Длинные тексты (вопрос, контекст, ответ)
читаются командой, а не из события.

| Событие | Payload | Полный текст |
|---|---|---|
| `request_created` | `taskId, requestId, kind, title` (≤ 300 символов), `runId, dispatchId?, questionId?` | `orca-board request get --request <id>` |
| `question` | `taskId, dispatchId, questionId, question` (≤ 300), `forHuman?: true, options` (метки) | `orca-board question get --question <id>` |
| `question_answered` | `taskId, dispatchId, questionId, requestId?, question, answer, workerLive, status` | — |
| `answer_accepted` | `taskId, decision?, summary?, requestId?, dispatchId, answerFor, answer` (≤ 2000), `answerTruncated?` | `orca-board task answer --task <id>` |
| `answer_clarified` | `taskId, feedback` (≤ 300), `requestId, dispatchId` | `orca-board request get --request <id>` (`resolution.text`) |
| `request_resolved` | `taskId, action` (`restart`/`dismiss`/`accept`/`reject`), `requestId, kind, dispatchId?, nodeId?` (approval), `decision` (≤ 2000, текст решения по approval), `decisionTruncated?` | `orca-board request get --request <id>` (`resolution.text`) |
| `worker_done` | `taskId, dispatchId, summary, files, answerFor?, gateFor?, requestId?, answer` (≤ 2000), `answerTruncated?` | `orca-board task answer --task <id>` |

Уведомление «нужен ваш ответ» (`notifyKind`, `notify.ts`) приходит только на `request_created` (вопрос / ответ
готов / эскалация / approval — вид «Воркер завершил задачу», текст «Ждёт решения»); кроме него человеку сообщают
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
   ответ попадает в промпт (раздел «Ответы на твои вопросы», `workerTaskPrompt`).

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
orca-board request resolve --request <id> --option <id|метка> [--text "..."]
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
