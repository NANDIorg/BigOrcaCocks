import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { HumanRequest, TaskWaitStats } from '@orca-board/core'
import { setLocale } from './i18n'
import { BOARD_SORT_OPTIONS, formatStamp } from './boardSort'
import { columnColorTitle } from './boardColumns'
import { cardEssence, cardEssenceFor, cardState, cardStateLabel, depsLabel, filesLabel, stageLabel, type CardStateInput } from './cardState'
import { priorityMark, priorityTitle, stalePriorityMessage } from './taskPriority'
import { STATUS_SOURCE_TITLES, statusDurationLabel } from './statusHistory'
import { showcaseStaleMessage } from './showcase'
import { answerForTitle, outcomeLabel, resolutionText } from './taskModalText'
import { dispatchCounters, humanLine, partValue, rejectionsTitle, returnsCounter, waitFact, type TimePart } from './taskStatsFormat'

// Тексты доски и модалки задачи на обоих языках: подписи считаются на текущем языке при каждом вызове,
// а таблицы (сортировки, источники переходов) отдают текст через геттеры — их берут и чужие модули как есть.

afterEach(() => setLocale('ru'))

const MIN = 60_000
const base = (over: Partial<CardStateInput> = {}): CardStateInput => ({
  kind: 'backlog', task: {}, questions: [], running: false, waitingDeps: 0, ...over
})

test('cardState: суть и состояние карточки — на текущем языке', () => {
  setLocale('ru')
  assert.equal(cardStateLabel('human'), 'ждёт вас')
  assert.equal(cardEssence(base({ kind: 'review', dispatch: { files: ['a', 'b'] } }))?.text, 'Ждёт ревью: 2 файла')
  setLocale('en')
  assert.equal(cardStateLabel('human'), 'waiting for you')
  assert.equal(cardStateLabel('idle'), '')
  assert.equal(cardEssence(base({ kind: 'review', dispatch: { files: ['a'] } }))?.text, 'Awaiting review: 1 file')
  assert.equal(cardEssence(base({ kind: 'review', dispatch: { showcase: { files: ['a', 'b', 'c'] } } }))?.text, '◉ Showcase: 3 files')
  assert.equal(cardEssence(base({ kind: 'review', dispatch: { outcome: 'failed' } }))?.text, '✕ Failed')
  const live = base({ kind: 'in_progress' })
  assert.equal(cardEssenceFor(live, cardState(live), true)?.text, '✋ Waiting for you')
  assert.equal(filesLabel(5), '5 files')
})

test('stageLabel и depsLabel: заход, гейт, зависимости по-английски', () => {
  setLocale('en')
  const stage = stageLabel({ stage: { nodeId: 'n', visits: { n: 2 } } } as Parameters<typeof stageLabel>[0], { n: 'Work' }, () => undefined)
  assert.equal(stage?.text, 'Work · pass 2')
  assert.equal(stage?.title, 'Workflow stage: Work · pass 2')
  const gate = stageLabel({ gateFor: { nodeId: 'n', taskId: 't' } } as Parameters<typeof stageLabel>[0], { n: 'Check' }, () => 'Fix')
  assert.equal(gate?.text, '⛉ Gate “Check” → Fix')
  assert.equal(depsLabel(['a', 'b'], () => false, (id) => id)?.text, '⧗ waiting on 2 tasks')
  assert.equal(depsLabel(['a'], () => false, (id) => id)?.text, '⧗ waiting on: a')
  setLocale('ru')
  assert.equal(depsLabel(['a', 'b', 'c', 'd', 'e'], () => false, (id) => id)?.text, '⧗ ждёт 5 задач')
})

test('BOARD_SORT_OPTIONS и STATUS_SOURCE_TITLES: подпись берётся при чтении, а не при загрузке модуля', () => {
  setLocale('ru')
  assert.equal(BOARD_SORT_OPTIONS.find((o) => o.value === 'done')?.title, 'по завершению')
  assert.equal(STATUS_SOURCE_TITLES.worker, 'воркер')
  setLocale('en')
  assert.equal(BOARD_SORT_OPTIONS.find((o) => o.value === 'done')?.title, 'by completed')
  assert.equal(STATUS_SOURCE_TITLES.worker, 'worker')
  assert.deepEqual(Object.keys(STATUS_SOURCE_TITLES), ['human', 'cli', 'worker', 'workflow', 'app'])
})

test('приоритет: название, метка карточки и подсказка «перезапустите» по языку', () => {
  setLocale('en')
  assert.equal(priorityTitle('urgent'), 'urgent')
  assert.equal(priorityMark({ priority: 'high' })?.mark, 'high')
  assert.equal(priorityMark({ priority: 'urgent' })?.mark, '!!')
  assert.match(stalePriorityMessage(), /Restart the app/)
  setLocale('ru')
  assert.match(stalePriorityMessage(), /Перезапустите приложение/)
  assert.equal(priorityMark({ priority: 'low' })?.mark, 'низ')
})

test('история статуса и показ: «сейчас» и ошибка старого main', () => {
  setLocale('en')
  assert.equal(statusDurationLabel({ durationMs: 5 * MIN, current: true, migrated: false }), 'now · ⏱ 5 min')
  assert.match(showcaseStaleMessage(), /^The app is running an old main\/preload/)
})

test('даты и цвета колонок форматируются по языку', () => {
  const ts = new Date(2026, 8, 25, 14, 5).getTime()
  setLocale('ru')
  assert.equal(formatStamp(ts), '25.09, 14:05')
  assert.equal(columnColorTitle({ value: '#7b86f5', title: 'Синий' }), 'Синий')
  setLocale('en')
  assert.equal(formatStamp(ts), '09/25, 02:05 PM')
  assert.equal(columnColorTitle({ value: '#7B86F5', title: 'Синий' }), 'Blue')
  assert.equal(columnColorTitle({ value: '#123456', title: '#123456' }), '#123456')
})

test('модалка задачи: исход запуска, чей ответ, итог запроса', () => {
  setLocale('en')
  assert.deepEqual(outcomeLabel({ outcome: 'unknown' }), { text: 'exited without done', cls: 'warn' })
  assert.deepEqual(outcomeLabel({}), { text: 'running', cls: 'live' })
  assert.equal(answerForTitle('coordinator'), 'answer for the coordinator')
  const req = (over: Partial<HumanRequest>): Pick<HumanRequest, 'status' | 'resolution' | 'options'> => ({ status: 'resolved', options: [], ...over })
  assert.equal(resolutionText(req({ status: 'cancelled' })), 'Cancelled — no longer needed')
  assert.equal(resolutionText(req({ resolution: { action: 'accept', text: 'ship it' } })), 'Accepted. Decision: ship it')
  assert.equal(resolutionText(req({ resolution: { action: 'answer', optionId: 'a' }, options: [{ id: 'a', label: 'Option A' }] })), 'Option A')
  setLocale('ru')
  assert.equal(resolutionText(req({ resolution: { action: 'reject', text: 'нет тестов' } })), 'Возвращён: нет тестов')
})

test('статистика задачи: счётчики, возвраты и заходы по-английски с формами множественного числа', () => {
  setLocale('en')
  assert.deepEqual(dispatchCounters({ total: 0, done: 0, failed: 0, unknown: 0, running: 0 }).map((c) => c.text), ['no runs'])
  assert.deepEqual(dispatchCounters({ total: 3, done: 2, failed: 1, unknown: 0, running: 0 }).map((c) => c.text), ['runs 3', 'done 2', 'failed 1'])
  assert.equal(returnsCounter(1).text, 'sent back 1 time')
  assert.equal(returnsCounter(3).text, 'sent back 3 times')
  assert.equal(rejectionsTitle({ gate: 0, approval: 0, clarify: 0, manual: 0 }), 'No returns for rework')
  const part: TimePart = { key: 'k', title: 'Work', color: '', ms: 2 * MIN, entries: 3, approx: false, share: 1 }
  assert.equal(partValue(part), '2 min · 3 passes')
  setLocale('ru')
  assert.equal(returnsCounter(3).text, 'возвращена в работу 3 раза')
  assert.equal(partValue(part), '2 мин · 3 захода')
})

test('статистика задачи: ожидание человека и запросы к нему', () => {
  const kinds = { question: { count: 2 }, answer: { count: 0 }, escalation: { count: 0 }, approval: { count: 1 } }
  const human = { resolved: 3, cancelled: 0, pending: 0, waitingMs: 10 * MIN, byKind: kinds, reactionMedianMs: 4 * MIN } as unknown as TaskWaitStats
  setLocale('en')
  assert.equal(waitFact(human).label, 'Waited for you')
  assert.equal(waitFact(human).hint, '3 requests')
  assert.equal(humanLine(human), 'Requests to you 3: questions 2, decisions 1 · response: median 4 min')
  setLocale('ru')
  assert.equal(waitFact(human).hint, '3 запроса')
  assert.equal(humanLine(human), 'Запросов к вам 3: вопросов 2, решений 1 · реакция: медиана 4 мин')
})
