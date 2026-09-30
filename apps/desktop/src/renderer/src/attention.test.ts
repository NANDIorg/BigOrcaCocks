import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, legacyDefaultWorkflow, type ColumnKind, type Dispatch, type HumanRequest, type Question, type Task } from '@orca-board/core'
import {
  ATTENTION_NARROW_LIMIT, KIND_RANK, attentionCountTitle, attentionLabel, attentionSummary, attentionTaskIds, buildAttention, defaultCollapsed, feedItemOfTask, questionAnswerText,
  questionAsRequest, readCollapsed, writeCollapsed, type AttentionInput
} from './attention'
import { setLocale } from './i18n'
import { stageNodeOf, stalledCardReason, stalledRetryLabel, taskReviewState } from './taskReview'

const task = (id: string, status: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Задача ${id}`, spec: '', status, roleId: 'dev', agent: 'claude', deps: [], createdAt: 1, updatedAt: 100, ...extra
}) as Task

const dispatch = (id: string, taskId: string, extra: Partial<Dispatch> = {}): Dispatch => ({ id, taskId, ptyId: `p-${id}`, startedAt: 10, ...extra })

const request = (id: string, taskId: string, kind: HumanRequest['kind'], extra: Partial<HumanRequest> = {}): HumanRequest => ({
  id, runId: 'run', taskId, kind, status: 'pending', title: `${kind} ${id}`, options: [], createdAt: 50, ...extra
})

const question = (id: string, taskId: string, extra: Partial<Question> = {}): Question => ({
  id, taskId, question: `Вопрос ${id}?`, options: [{ id: '1', label: 'да' }, { id: '2', label: 'нет' }], createdAt: 60, ...extra
})

afterEach(() => setLocale('ru'))

const kinds: Record<string, ColumnKind> = { backlog: 'backlog', ready: 'ready', in_progress: 'in_progress', needs_input: 'needs_input', review: 'review', done: 'done' }
const input = (extra: Partial<AttentionInput>): AttentionInput => ({
  tasks: [], requests: [], questions: [], dispatches: [], runId: 'run', kindOf: (s) => kinds[s], ...extra
})

test('нечего ждать — ленты нет', () => {
  const t = [task('a', 'in_progress'), task('b', 'done'), task('c', 'ready')]
  assert.deepEqual(buildAttention(input({ tasks: t, dispatches: [dispatch('d1', 'a')] })), [])
})

test('pending-запросы своей глобальной задачи; чужие, решённые и отменённые — нет', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input')],
    requests: [
      request('r1', 'a', 'question'),
      request('r2', 'a', 'answer', { runId: 'other' }),
      request('r3', 'a', 'answer', { status: 'resolved' }),
      request('r4', 'a', 'answer', { status: 'cancelled' })
    ]
  }))
  assert.deepEqual(items.map((i) => i.id), ['req:r1'])
  assert.equal(items[0].source, 'request')
  assert.equal(items[0].kind, 'question')
})

test('вопрос, по которому есть pending-запрос, — один пункт (запрос); без запроса — свой пункт', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'needs_input')],
    requests: [request('r1', 'a', 'question', { questionId: 'q1' })],
    questions: [question('q1', 'a', { forHuman: true }), question('q2', 'b')]
  }))
  assert.deepEqual(items.map((i) => i.id), ['req:r1', 'q:q2'])
  assert.equal(items[1].source, 'question')
  assert.equal(items[1].question?.id, 'q2')
})

test('отвеченный вопрос, вопрос прошлого запуска и вопрос чужой задачи не попадают', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input', { dispatchId: 'd2' })],
    questions: [
      question('q1', 'a', { answeredAt: 70 }),
      question('q2', 'a', { dispatchId: 'd1' }),
      question('q3', 'zzz'),
      question('q4', 'a', { dispatchId: 'd2' })
    ]
  }))
  assert.deepEqual(items.map((i) => i.id), ['q:q4'])
})

test('эскалация-запрос и сбой той же задачи — один пункт; сбой без запроса — свой', () => {
  const failed = dispatch('d1', 'a', { outcome: 'failed', endedAt: 90 })
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'needs_input')],
    requests: [request('r1', 'a', 'escalation', { dispatchId: 'd1' })],
    dispatches: [failed, dispatch('d2', 'b', { outcome: 'unknown', endedAt: 95 })]
  }))
  assert.deepEqual(items.map((i) => i.id), ['req:r1', 'fail:b'])
  assert.equal(items[0].kind, 'failure')
  assert.equal(items[0].failure, 'failed')
  assert.equal(items[1].failure, 'unknown')
  assert.equal(items[1].at, 95)
})

test('сбои: упал, вышел без done, молчит; сделанная и запущенная сейчас задача — нет', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'in_progress'), task('b', 'in_progress'), task('c', 'in_progress'), task('d', 'done'), task('e', 'in_progress')],
    dispatches: [
      dispatch('d1', 'a', { outcome: 'failed', endedAt: 5 }),
      dispatch('d2', 'b', { outcome: 'unknown', endedAt: 6 }),
      dispatch('d3', 'c', { stuckNotified: true }),
      dispatch('d4', 'd', { outcome: 'failed', endedAt: 7 }),
      dispatch('d5', 'e', { outcome: 'failed', endedAt: 8 })
    ],
    running: new Set(['e'])
  }))
  assert.deepEqual(items.map((i) => [i.taskId, i.failure]), [['a', 'failed'], ['b', 'unknown'], ['c', 'stuck']])
})

test('молчащий, но уже завершившийся запуск — не «молчит»', () => {
  const items = buildAttention(input({ tasks: [task('a', 'in_progress')], dispatches: [dispatch('d1', 'a', { stuckNotified: true, endedAt: 20, outcome: 'done' })] }))
  assert.deepEqual(items, [])
})

test('готовый ответ для человека без запроса — пункт; с запросом, для координатора или без ответа — нет', () => {
  const done = (taskId: string, extra: Partial<Dispatch> = {}): Dispatch => dispatch(`d-${taskId}`, taskId, { outcome: 'done', endedAt: 30, answer: '# ответ', summary: 'Суть', ...extra })
  const items = buildAttention(input({
    tasks: [
      task('a', 'needs_input', { answerFor: 'human' }),
      task('b', 'needs_input', { answerFor: 'human' }),
      task('c', 'needs_input', { answerFor: 'coordinator' }),
      task('d', 'needs_input', { answerFor: 'human' })
    ],
    requests: [request('r1', 'b', 'answer')],
    dispatches: [done('a'), done('b'), done('c'), done('d', { answer: undefined })]
  }))
  // Оба — «ответ»: внутри вида старые сверху (dispatch завершился в 30, запрос создан в 50).
  assert.deepEqual(items.map((i) => i.id), ['ans:a', 'req:r1'])
  assert.equal(items[0].title, 'Суть')
})

test('задача в «Ревью» без запроса — ждёт ревью; гейт, ответ и задача с запросом — нет', () => {
  const items = buildAttention(input({
    tasks: [
      task('a', 'review'),
      task('b', 'review', { gateFor: { taskId: 'a', nodeId: 'n' } }),
      task('c', 'review', { answerFor: 'coordinator' }),
      task('d', 'review')
    ],
    requests: [request('r1', 'd', 'approval')],
    dispatches: [dispatch('d1', 'a', { outcome: 'done', endedAt: 40, files: ['x.ts', 'y.ts', 'z.ts'] })]
  }))
  assert.deepEqual(items.map((i) => i.id), ['req:r1', 'rev:a'])
  assert.equal(items[1].title, 'Ждёт ревью: 3 файла')
})

test('approval со сданным показом — «показ» с файлами, без него — «решение»', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'review'), task('b', 'review')],
    requests: [
      request('r1', 'a', 'approval', { showcaseDispatchId: 'd1' }),
      request('r2', 'b', 'approval', { showcaseDispatchId: 'nope' })
    ],
    dispatches: [dispatch('d1', 'a', { outcome: 'done', showcase: { text: 'смотрите', files: ['A.html', 'B.html'] } })]
  }))
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['req:r1', 'showcase'], ['req:r2', 'approval']])
  assert.deepEqual(items[0].showcaseFiles, ['A.html', 'B.html'])
  assert.equal(items[1].showcaseFiles, undefined)
})

test('ответ с показом (`done --answer-file … --show …`) — «ответ» с файлами показа запуска, сдавшего ответ', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'needs_input')],
    requests: [request('r1', 'a', 'answer', { dispatchId: 'd1' }), request('r2', 'b', 'answer', { dispatchId: 'd2' })],
    dispatches: [
      dispatch('d1', 'a', { outcome: 'done', answer: 'текст', showcase: { files: ['shots/1.png'] } }),
      dispatch('d2', 'b', { outcome: 'done', answer: 'текст' })
    ]
  }))
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.showcaseFiles]), [['req:r1', 'answer', ['shots/1.png']], ['req:r2', 'answer', undefined]])
})

test('approval с showcaseDispatchIds — файлы всех показов', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'review')],
    requests: [request('r1', 'a', 'approval', { showcaseDispatchId: 'd2', showcaseDispatchIds: ['d1', 'd2'] })],
    dispatches: [
      dispatch('d1', 'a', { outcome: 'done', showcase: { files: ['A.html'] } }),
      dispatch('d2', 'a', { outcome: 'done', showcase: { files: ['B.png'] } })
    ]
  }))
  assert.deepEqual(items[0].showcaseFiles, ['A.html', 'B.png'])
})

test('порядок: сбои, вопросы, показ, ответы, ревью; внутри вида — старые сверху', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'review'), task('c', 'in_progress'), task('d', 'in_progress'), task('e', 'review')],
    requests: [
      request('ans', 'a', 'answer', { createdAt: 10 }),
      request('shw', 'b', 'approval', { createdAt: 20, showcaseDispatchId: 'ds' }),
      request('q-new', 'a', 'question', { createdAt: 300 }),
      request('q-old', 'a', 'question', { createdAt: 200 }),
      request('esc', 'c', 'escalation', { createdAt: 400 })
    ],
    dispatches: [
      dispatch('ds', 'b', { showcase: { files: ['x.png'] } }),
      dispatch('df', 'd', { outcome: 'failed', endedAt: 5 })
    ]
  }))
  assert.deepEqual(items.map((i) => i.id), ['fail:d', 'req:esc', 'req:q-old', 'req:q-new', 'req:shw', 'req:ans', 'rev:e'])
})

test('задачи с пунктами — для фильтра «Ждут вас»', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'needs_input')],
    requests: [request('r1', 'a', 'question'), request('r2', 'a', 'answer')],
    questions: [question('q1', 'b')]
  }))
  assert.deepEqual([...attentionTaskIds(items)].sort(), ['a', 'b'])
})

test('«в ленте ↑»: первый пункт задачи в порядке ленты; у задачи без пунктов — ничего', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'in_progress')],
    requests: [request('r1', 'a', 'answer', { createdAt: 90 }), request('r2', 'a', 'question', { createdAt: 95 })]
  }))
  // Вопрос идёт раньше ответа (порядок видов), хотя запрос младше.
  assert.equal(feedItemOfTask(items, 'a')?.id, 'req:r2')
  assert.equal(feedItemOfTask(items, 'b'), undefined)
  assert.equal(feedItemOfTask([], 'a'), undefined)
})

test('счётчик ленты и счётчик фильтра «Ждут вас» на доске: одно число, пока у задачи один пункт', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'in_progress'), task('c', 'review'), task('d', 'ready')],
    requests: [request('r1', 'a', 'question')],
    dispatches: [dispatch('d1', 'b', { outcome: 'failed', endedAt: 1 })]
  }))
  assert.equal(attentionTaskIds(items).size, items.length)
  assert.equal(attentionCountTitle(items), undefined)
  // Обычное ревью кода — тоже пункт ленты, а значит, и «ждёт вас» на доске.
  assert.ok(attentionTaskIds(items).has('c'))
  assert.ok(!attentionTaskIds(items).has('d'))
})

test('несколько пунктов у одной задачи: подсказка к счётчику ленты объясняет разницу с доской', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'needs_input')],
    requests: [request('r1', 'a', 'question'), request('r2', 'a', 'approval'), request('r3', 'b', 'question')]
  }))
  assert.equal(items.length, 3)
  assert.equal(attentionTaskIds(items).size, 2)
  assert.match(attentionCountTitle(items) ?? '', /^3 пункта у 2 задач/)
})

test('сводка свёрнутой ленты: склонения, порядок, нули не пишутся', () => {
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'review'), task('c', 'in_progress')],
    requests: [request('r1', 'a', 'question'), request('r2', 'a', 'question'), request('r3', 'a', 'answer'), request('r4', 'b', 'approval')],
    dispatches: [dispatch('d1', 'c', { outcome: 'failed', endedAt: 1 })]
  }))
  assert.equal(attentionSummary(items), '1 сбой · 2 вопроса · 1 решение · 1 ответ')
  assert.equal(attentionSummary([]), '')
})

test('подписи вида — текстом, а не только цветом', () => {
  assert.equal(attentionLabel({ kind: 'failure', failure: 'failed' }), 'Воркер упал')
  assert.equal(attentionLabel({ kind: 'failure', failure: 'unknown' }), 'Вышел без done')
  assert.equal(attentionLabel({ kind: 'failure', failure: 'stuck' }), 'Воркер молчит')
  assert.equal(attentionLabel({ kind: 'failure' }), 'Сбой воркера')
  assert.equal(attentionLabel({ kind: 'showcase' }), 'Показ')
  assert.equal(attentionLabel({ kind: 'answer' }), 'Ответ готов')
})

test('в узком окне лента без выбора сворачивается только при длинном списке', () => {
  assert.equal(defaultCollapsed(ATTENTION_NARROW_LIMIT + 1, 860), true)
  assert.equal(defaultCollapsed(ATTENTION_NARROW_LIMIT, 860), false)
  assert.equal(defaultCollapsed(10, 1180), false)
})

test('свёрнутость: без localStorage (node) выбора нет, запись не падает', () => {
  assert.equal(readCollapsed(), null)
  assert.doesNotThrow(() => writeCollapsed(true))
})

test('вопрос как запрос: тот же текст, варианты и контекст; id не совпадает с настоящим запросом', () => {
  const q = question('q1', 'a', { context: 'почему спрашиваю', dispatchId: 'd1' })
  const r = questionAsRequest(q, 'run')
  assert.equal(r.id, 'q:q1')
  assert.equal(r.kind, 'question')
  assert.equal(r.status, 'pending')
  assert.equal(r.title, q.question)
  assert.equal(r.body, 'почему спрашиваю')
  assert.deepEqual(r.options, q.options)
})

test('ответ на вопрос: вариант — его метка, свой текст — как есть; остальное — ошибка', () => {
  const q = question('q1', 'a')
  assert.equal(questionAnswerText(q, { action: 'answer', optionId: '2' }), 'нет')
  assert.equal(questionAnswerText(q, { action: 'answer', text: '  свой  ' }), 'свой')
  assert.throws(() => questionAnswerText(q, { action: 'answer', optionId: '9' }), /нет варианта 9/)
  assert.throws(() => questionAnswerText(q, { action: 'answer', text: ' ' }), /пустой/)
  assert.throws(() => questionAnswerText(q, { action: 'accept' }), /только ответить/)
})

test('английский интерфейс: подписи, сводка, счётчик и заголовки пунктов — на английском', () => {
  setLocale('en')
  const items = buildAttention(input({
    tasks: [task('a', 'needs_input'), task('b', 'review'), task('c', 'in_progress')],
    requests: [request('r1', 'a', 'question'), request('r2', 'a', 'question'), request('r3', 'a', 'answer')],
    dispatches: [dispatch('d1', 'c', { outcome: 'unknown', endedAt: 1 }), dispatch('d2', 'b', { outcome: 'done', endedAt: 2, files: ['x.ts'] })]
  }))
  assert.equal(attentionSummary(items), '1 failure · 2 questions · 1 answer · 1 review')
  assert.equal(attentionCountTitle(items), '5 items across 3 tasks — the “Waiting for you” filter on the board counts tasks')
  assert.equal(items.find((i) => i.id === 'fail:c')?.title, 'Process exited without orca-board done')
  assert.equal(items.find((i) => i.id === 'rev:b')?.title, 'Awaiting review: 1 file')
  assert.equal(attentionLabel({ kind: 'failure', failure: 'stuck' }), 'Worker is silent')
  assert.equal(attentionLabel({ kind: 'approval' }), 'Decision needed')
  assert.throws(() => questionAnswerText(question('q1', 'a'), { action: 'answer', text: ' ' }), /empty answer/)
})

// Этап остановлен (taskReview.ts): колонка «Ревью» ≠ этап проверки.
const runScope = { workflowScope: 'run' as const }
const runGraph = defaultWorkflow([])
/** Подзадача пути этапа «Работа» (defaultSubflow: start → work → merge → end, conflict — human). */
const pathTask = (id: string, nodeId: string, extra: Partial<Task> = {}): Task =>
  task(id, 'review', { stageOf: { nodeId: 'work', visit: 1 }, stage: { nodeId, visits: {} }, ...extra })
const pathInput = (tasks: Task[], extra: Partial<AttentionInput> = {}): AttentionInput =>
  input({ tasks, stageNode: (t) => stageNodeOf(t, runScope, runGraph), ...extra })

test('«Ревью» на ноде merge — «этап остановлен», а не ревью: без «Принять» ревью', () => {
  const items = buildAttention(pathInput([pathTask('a', 'merge')], { dispatches: [dispatch('d1', 'a', { outcome: 'done', files: ['x.ts'] })] }))
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['stall:a', 'stalled']])
  assert.equal(items[0].source, 'task')
  assert.equal(items[0].stageNode?.type, 'merge')
  assert.match(items[0].title, /^Этап «.+» не завершён$/)
  assert.equal(stalledRetryLabel(items[0].stageNode, 'merge'), '↻ Повторить мерж')
})

test('«Ревью» на end и work пути — тоже остановка; на human пути (конфликт) — ревью', () => {
  const items = buildAttention(pathInput([pathTask('a', 'end'), pathTask('b', 'work'), pathTask('c', 'conflict')]))
  assert.deepEqual(items.map((i) => [i.id, i.kind]).sort(), [['rev:c', 'review'], ['stall:a', 'stalled'], ['stall:b', 'stalled']])
  assert.equal(stalledRetryLabel(items.find((i) => i.id === 'stall:b')?.stageNode, 'work'), '↻ Продолжить этап')
})

test('старый движок: нода gate — ревью, merge — остановка; задача без этапа — ревью', () => {
  const legacy = legacyDefaultWorkflow([{ id: 'reviewer' }])
  const items = buildAttention(input({
    tasks: [task('a', 'review', { stage: { nodeId: 'review', visits: {} } }), task('b', 'review', { stage: { nodeId: 'merge', visits: {} } }), task('c', 'review')],
    stageNode: (t) => stageNodeOf(t, undefined, legacy)
  }))
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['stall:b', 'stalled'], ['rev:a', 'review'], ['rev:c', 'review']])
})

test('нет графа (старый main, типы не пришли): прежнее ревью; остановку видно только по stageBlock этой ноды', () => {
  const items = buildAttention(input({
    tasks: [
      task('a', 'review', { stage: { nodeId: 'merge', visits: {} } }),
      task('b', 'review', { stage: { nodeId: 'merge', visits: {} }, stageBlock: { nodeId: 'merge', reason: 'нет ветки', at: 5 } }),
      task('c', 'review', { stage: { nodeId: 'merge', visits: {} }, stageBlock: { nodeId: 'work', reason: 'прошлая остановка', at: 5 } })
    ]
  }))
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['stall:b', 'stalled'], ['rev:a', 'review'], ['rev:c', 'review']])
  assert.equal(items[0].stageNode, undefined)
  assert.equal(stalledRetryLabel(undefined, 'merge'), '↻ Повторить мерж')
})

test('причина остановки (Task.stageBlock) — заголовок пункта и его время; чужая нода — общий текст', () => {
  const reason = 'git worktree remove: Permission denied\nполный текст'
  const items = buildAttention(pathInput([
    pathTask('a', 'merge', { stageBlock: { nodeId: 'merge', reason, at: 77 } }),
    pathTask('b', 'merge', { stageBlock: { nodeId: 'work', reason: 'старое', at: 5 } })
  ]))
  const a = items.find((i) => i.id === 'stall:a')
  assert.equal(a?.title, reason)
  assert.equal(a?.at, 77)
  assert.match(items.find((i) => i.id === 'stall:b')?.title ?? '', /не завершён/)
})

test('остановленный этап с pending-запросом, ответ и проверка — не пункт «этап остановлен»', () => {
  const items = buildAttention(pathInput(
    [pathTask('a', 'merge'), pathTask('b', 'merge', { answerFor: 'human' }), pathTask('c', 'merge', { gateFor: { nodeId: 'g', taskId: 'x' } })],
    { requests: [request('r1', 'a', 'approval')] }
  ))
  assert.deepEqual(items.map((i) => i.id), ['req:r1'])
})

test('порядок: остановка — после ответов и перед ревью; сводка и подпись', () => {
  assert.ok(KIND_RANK.answer < KIND_RANK.stalled && KIND_RANK.stalled < KIND_RANK.review)
  const items = buildAttention(pathInput(
    [task('r', 'review', { updatedAt: 1 }), pathTask('s', 'merge', { updatedAt: 500 }), task('f', 'in_progress')],
    { dispatches: [dispatch('d1', 'f', { outcome: 'failed', endedAt: 900 })] }
  ))
  assert.deepEqual(items.map((i) => i.kind), ['failure', 'stalled', 'review'])
  assert.equal(attentionSummary(items), '1 сбой · 1 остановка · 1 ревью')
  assert.equal(attentionLabel({ kind: 'stalled' }), 'Этап остановлен')
  setLocale('en')
  assert.equal(attentionSummary(items), '1 failure · 1 stalled · 1 review')
  assert.equal(attentionLabel({ kind: 'stalled' }), 'Stage stalled')
})

test('карточка на доске: причина остановки — по тому же правилу, что лента (stalledCardReason)', () => {
  const reason = 'мерж не выполнен: Unable to write index'
  // Нода merge — остановка; причина — Task.stageBlock этой ноды, без неё — «Этап «…» не завершён».
  assert.equal(stalledCardReason(pathTask('a', 'merge', { stageBlock: { nodeId: 'merge', reason, at: 7 } }), 'review', runScope, runGraph), reason)
  assert.match(stalledCardReason(pathTask('a', 'merge'), 'review', runScope, runGraph) ?? '', /^Этап «.+» не завершён$/)
  // Ревью настоящее (human пути — конфликт), не «Ревью», задача-ответ / проверка и задача без этапа — не остановка.
  assert.equal(stalledCardReason(pathTask('a', 'conflict'), 'review', runScope, runGraph), undefined)
  assert.equal(stalledCardReason(pathTask('a', 'merge'), 'in_progress', runScope, runGraph), undefined)
  assert.equal(stalledCardReason(pathTask('a', 'merge', { answerFor: 'human' }), 'review', runScope, runGraph), undefined)
  assert.equal(stalledCardReason(pathTask('a', 'merge', { gateFor: { nodeId: 'g', taskId: 'x' } }), 'review', runScope, runGraph), undefined)
  assert.equal(stalledCardReason(task('a', 'review'), 'review', runScope, runGraph), undefined)
  // Нет графа (старый main, типы не пришли): видно только по stageBlock той же ноды.
  const onMerge = { stage: { nodeId: 'merge', visits: {} } }
  assert.equal(stalledCardReason(task('a', 'review', onMerge), 'review', undefined, undefined), undefined)
  assert.equal(stalledCardReason(task('a', 'review', { ...onMerge, stageBlock: { nodeId: 'merge', reason, at: 7 } }), 'review', undefined, undefined), reason)
})

test('счётчик ревью и карточка задачи: то же правило, что лента', () => {
  assert.equal(taskReviewState(pathTask('a', 'merge'), 'review', [], runScope, runGraph), 'stalled')
  assert.equal(taskReviewState(pathTask('a', 'conflict'), 'review', [], runScope, runGraph), 'review')
  assert.equal(taskReviewState(pathTask('a', 'conflict'), 'review', [request('r', 'a', 'approval')], runScope, runGraph), undefined)
  assert.equal(taskReviewState(task('a', 'review'), 'review', [request('r', 'a', 'approval', { status: 'resolved' })], undefined, undefined), 'review')
  assert.equal(taskReviewState(task('a', 'in_progress'), 'in_progress', [], undefined, undefined), undefined)
})
