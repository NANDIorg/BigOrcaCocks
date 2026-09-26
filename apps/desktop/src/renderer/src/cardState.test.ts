import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Workflow } from '@orca-board/core'
import {
  cardEssence, cardEssenceFor, cardState, depsLabel, filesLabel, requestStageLabel, shortText, stageLabel, wfNodeTitles,
  type CardStateInput
} from './cardState'
import { setLocale } from './i18n'

const base = (over: Partial<CardStateInput> = {}): CardStateInput => ({
  kind: 'backlog', task: {}, questions: [], running: false, waitingDeps: 0, ...over
})

test('cardState: вид колонки задаёт состояние без сигналов', () => {
  assert.equal(cardState(base({ kind: 'in_progress' })), 'live')
  assert.equal(cardState(base({ kind: 'review' })), 'review')
  assert.equal(cardState(base({ kind: 'needs_input' })), 'human')
  assert.equal(cardState(base({ kind: 'backlog' })), 'idle')
  assert.equal(cardState(base({ kind: 'ready' })), 'idle')
  assert.equal(cardState(base({ kind: undefined })), 'idle')
  assert.equal(cardState(base({ kind: 'done' })), 'idle')
})

test('cardState: живой терминал — работа, даже если колонка другая', () => {
  assert.equal(cardState(base({ kind: 'backlog', running: true })), 'live')
})

test('cardState: незакрытые зависимости — blocked, но работа и ожидание человека сильнее', () => {
  assert.equal(cardState(base({ waitingDeps: 2 })), 'blocked')
  assert.equal(cardState(base({ kind: 'in_progress', waitingDeps: 1 })), 'live')
})

test('cardState: открытый вопрос — human в любой колонке, кроме done', () => {
  const questions = [{ question: 'Что?' }]
  assert.equal(cardState(base({ kind: 'in_progress', questions })), 'human')
  assert.equal(cardState(base({ kind: 'review', questions })), 'human')
})

test('cardState: упал, вышел без done, молчит — bad; исход done — нет', () => {
  assert.equal(cardState(base({ kind: 'in_progress', dispatch: { outcome: 'failed' } })), 'bad')
  assert.equal(cardState(base({ kind: 'in_progress', dispatch: { outcome: 'unknown' } })), 'bad')
  assert.equal(cardState(base({ kind: 'in_progress', dispatch: { stuckNotified: true } })), 'bad')
  assert.equal(cardState(base({ kind: 'in_progress', dispatch: { stuckNotified: true, endedAt: 5 } })), 'live')
  assert.equal(cardState(base({ kind: 'review', dispatch: { outcome: 'done' } })), 'review')
})

test('cardState: сбой перекрывает вопрос, но в done не показывается', () => {
  const questions = [{ question: 'Что?' }]
  assert.equal(cardState(base({ kind: 'needs_input', questions, dispatch: { outcome: 'failed' } })), 'bad')
  assert.equal(cardState(base({ kind: 'done', dispatch: { outcome: 'failed' } })), 'idle')
})

test('cardState: готовый ответ задачи-ответа — human в «Нужен ответ» и в «Ревью»', () => {
  const dispatch = { answer: 'Текст' }
  assert.equal(cardState(base({ kind: 'review', task: { answerFor: 'human' }, dispatch })), 'human')
  assert.equal(cardState(base({ kind: 'needs_input', task: { answerFor: 'coordinator' }, dispatch })), 'human')
  // Обычная задача с полем answer не бывает, но и без answerFor ответ не считается готовым.
  assert.equal(cardState(base({ kind: 'review', dispatch })), 'review')
  assert.equal(cardState(base({ kind: 'in_progress', task: { answerFor: 'human' }, dispatch })), 'live')
})

test('cardEssence: сбои', () => {
  const dispatch = (d: NonNullable<CardStateInput['dispatch']>): CardStateInput => base({ kind: 'in_progress', dispatch: d })
  assert.equal(cardEssence(dispatch({ outcome: 'failed' }))?.text, '✕ Упал')
  assert.equal(cardEssence(dispatch({ outcome: 'unknown' }))?.text, '✕ Вышел без done')
  assert.equal(cardEssence(dispatch({ stuckNotified: true }))?.text, '✕ Молчит')
})

test('cardEssence: вопрос сжимается, полный текст — в подсказке, лишние вопросы — «+N»', () => {
  const long = 'PDF показывать через iframe или рендерить первую страницу картинкой, если файл больше мегабайта?'
  const e = cardEssence(base({ kind: 'needs_input', questions: [{ question: long }, { question: 'Второй' }] }))
  assert.ok(e)
  assert.ok(e.text.startsWith('? PDF показывать'))
  assert.ok(e.text.endsWith('… (+1)'))
  assert.ok(e.text.length < 60)
  assert.equal(e.title, `${long}\n\nВторой`)
  assert.equal(cardEssence(base({ kind: 'needs_input', questions: [{ question: 'Коротко?' }] }))?.text, '? Коротко?')
})

test('cardEssence: ответ, показ, ревью, просто «нужен ответ»', () => {
  assert.equal(cardEssence(base({ kind: 'needs_input', task: { answerFor: 'human' }, dispatch: { answer: 'x', summary: 'Итог' } }))?.title, 'Итог')
  assert.equal(cardEssence(base({ kind: 'needs_input', task: { answerFor: 'human' }, dispatch: { answer: 'x' } }))?.text, '✎ Ответ готов')
  assert.equal(cardEssence(base({ kind: 'review', dispatch: { showcase: { files: ['a', 'b', 'c'] } } }))?.text, '◉ Показ: 3 файла')
  assert.equal(cardEssence(base({ kind: 'review', dispatch: { files: ['a'] } }))?.text, 'Ждёт ревью: 1 файл')
  assert.equal(cardEssence(base({ kind: 'review' }))?.text, 'Ждёт ревью')
  assert.equal(cardEssence(base({ kind: 'needs_input' }))?.text, '? Нужен ответ')
})

test('cardEssence: у работы, ожидания и покоя сути нет', () => {
  assert.equal(cardEssence(base({ kind: 'in_progress' })), null)
  assert.equal(cardEssence(base({ waitingDeps: 1 })), null)
  assert.equal(cardEssence(base({ kind: 'done' })), null)
})

test('shortText и filesLabel', () => {
  assert.equal(shortText('  много\n  пробелов  '), 'много пробелов')
  assert.equal(shortText('abcdefghij', 5), 'abcd…')
  assert.equal(filesLabel(1), '1 файл')
  assert.equal(filesLabel(2), '2 файла')
  assert.equal(filesLabel(5), '5 файлов')
  assert.equal(filesLabel(21), '21 файл')
  assert.equal(filesLabel(12), '12 файлов')
})

const wf: Workflow = {
  version: 1,
  nodes: [
    { id: 'n1', type: 'start', x: 0, y: 0 },
    { id: 'n2', type: 'work', x: 0, y: 0, title: 'Разработка' },
    { id: 'n3', type: 'gate', roleId: 'reviewer', x: 0, y: 0, title: 'Ревью кода' },
    { id: 'n4', type: 'human', x: 0, y: 0 }
  ],
  edges: []
}
const titles = wfNodeTitles(wf)

test('wfNodeTitles: свои названия, иначе по типу; нет воркфлоу — пусто', () => {
  assert.deepEqual(titles, { n1: 'Старт', n2: 'Разработка', n3: 'Ревью кода', n4: 'Человек' })
  assert.deepEqual(wfNodeTitles(undefined), {})
})

test('stageLabel: название ноды и «N-й заход» со второго', () => {
  const task = (visits: number) => ({ stage: { nodeId: 'n2', visits: { n2: visits } } })
  assert.equal(stageLabel(task(1), titles, () => undefined)?.text, 'Разработка')
  assert.equal(stageLabel(task(2), titles, () => undefined)?.text, 'Разработка · 2-й заход')
  assert.equal(stageLabel(task(3), titles, () => undefined)?.kind, 'stage')
})

test('stageLabel: без поля stage, без названий нод или с неизвестной нодой — пилюли нет', () => {
  assert.equal(stageLabel({}, titles, () => undefined), null)
  assert.equal(stageLabel({ stage: { nodeId: 'n2', visits: {} } }, undefined, () => undefined), null)
  assert.equal(stageLabel({ stage: { nodeId: 'zzz', visits: {} } }, titles, () => undefined), null)
})

test('stageLabel: без visits в снимке — как первый заход', () => {
  assert.equal(stageLabel({ stage: { nodeId: 'n2', visits: {} } }, titles, () => undefined)?.text, 'Разработка')
})

test('stageLabel: гейт — нода и проверяемая задача; без названий нод всё равно подписан', () => {
  const gate = { gateFor: { taskId: 't1', nodeId: 'n3' } }
  const title = (id: string): string | undefined => (id === 't1' ? 'Инспектор ноды' : undefined)
  const l = stageLabel(gate, titles, title)
  assert.equal(l?.kind, 'gate')
  assert.equal(l?.text, '⛉ Гейт «Ревью кода» → Инспектор ноды')
  assert.equal(stageLabel(gate, undefined, title)?.text, '⛉ Гейт → Инспектор ноды')
  assert.equal(stageLabel(gate, undefined, () => undefined)?.text, '⛉ Гейт')
})

test('stageLabel: подзадача воркфлоу глобальной задачи — этап и заход по stageOf', () => {
  const of = (nodeId: string, visit: number) => ({ stageOf: { nodeId, visit } })
  assert.equal(stageLabel(of('n2', 1), titles, () => undefined)?.text, 'Разработка')
  assert.equal(stageLabel(of('n2', 2), titles, () => undefined)?.text, 'Разработка · 2-й заход')
  assert.equal(stageLabel(of('zzz', 1), titles, () => undefined), null)
  assert.equal(stageLabel(of('n2', 1), undefined, () => undefined), null)
})

test('stageLabel: гейт по ветке глобальной задачи (gateFor.runId) — без проверяемой подзадачи', () => {
  const gate = { gateFor: { runId: 'run_1', nodeId: 'n3' } }
  const l = stageLabel(gate, titles, () => 'не должно вызываться')
  assert.equal(l?.kind, 'gate')
  assert.equal(l?.text, '⛉ Гейт «Ревью кода» → ветка задачи')
  assert.match(l!.title, /ветку глобальной задачи целиком/)
  assert.equal(stageLabel(gate, undefined, () => undefined)?.text, '⛉ Гейт → ветка задачи')
})

test('depsLabel: одна — с названием, несколько — счётом, полный список в подсказке', () => {
  const closed = new Set(['done1'])
  const names: Record<string, string> = { a: 'Миграция store', b: 'Иконки', c: 'Тесты', done1: 'Старая' }
  const l = (deps: string[]) => depsLabel(deps, (d) => closed.has(d), (d) => names[d])
  assert.equal(l([]), null)
  assert.equal(l(['done1']), null)
  assert.deepEqual(l(['a']), { text: '⧗ ждёт: Миграция store', title: 'Ждёт: Миграция store' })
  assert.deepEqual(l(['a', 'done1', 'b']), { text: '⧗ ждёт 2 задачи', title: 'Ждёт: Миграция store; Иконки' })
  assert.equal(l(['a', 'b', 'c', 'x', 'y'])?.text, '⧗ ждёт 5 задач')
  assert.equal(l(['gone'])?.text, '⧗ ждёт: gone')
})

test('cardEssenceFor: задача из ленты без своей сути получает запасную — иначе не было бы «в ленте ↑»', () => {
  const live = base({ kind: 'in_progress' })
  assert.equal(cardEssence(live), null)
  assert.equal(cardEssenceFor(live, cardState(live), false), null)
  assert.equal(cardEssenceFor(live, cardState(live), true)?.text, '✋ Ждёт вас')
  // своя суть важнее запасной
  const review = base({ kind: 'review' })
  assert.equal(cardEssenceFor(review, cardState(review), true)?.text, 'Ждёт ревью')
})

test('requestStageLabel: метка этапа только у вопроса с известной нодой', () => {
  const t = { ask1: 'Уточнение', work: 'Работа' }
  setLocale('ru')
  assert.equal(requestStageLabel({ kind: 'question', nodeId: 'ask1' }, t), 'Этап «Уточнение»')
  setLocale('en')
  assert.equal(requestStageLabel({ kind: 'question', nodeId: 'ask1' }, t), 'Stage “Уточнение”', 'название ноды — данные, не переводится')
  setLocale('ru')
  assert.equal(requestStageLabel({ kind: 'question' }, t), undefined, 'обычный вопрос — без метки')
  assert.equal(requestStageLabel({ kind: 'question', nodeId: 'gone' }, t), undefined, 'ноды нет в графе — id не показываем')
  assert.equal(requestStageLabel({ kind: 'question', nodeId: 'ask1' }, undefined), undefined)
  assert.equal(requestStageLabel({ kind: 'approval', nodeId: 'work' }, t), undefined, 'у approval нода — «Человек», метка не нужна')
})

test('пилюля этапа для ask — как у любой ноды: название из графа', () => {
  const ask = wfNodeTitles({ version: 1, nodes: [{ id: 'q', type: 'ask', x: 0, y: 0, instructions: 'x' }], edges: [] })
  assert.equal(stageLabel({ stage: { nodeId: 'q', visits: { q: 1 } } }, ask, () => undefined)?.text, 'Вопрос человеку')
})

test('stageLabel: этап git подписан названием ноды — заданным или «Git»', () => {
  const graph: Workflow = {
    version: 1,
    nodes: [
      { id: 'g1', type: 'git', x: 0, y: 0, operation: 'create_branch', branch: 'feature/{taskId}' },
      { id: 'g2', type: 'git', x: 0, y: 0, operation: 'push', title: 'Пуш в origin' }
    ],
    edges: []
  }
  const names = wfNodeTitles(graph)
  assert.deepEqual(names, { g1: 'Git', g2: 'Пуш в origin' })
  assert.deepEqual(stageLabel({ stage: { nodeId: 'g1', visits: { g1: 1 } } }, names, () => undefined), { kind: 'stage', text: 'Git', title: 'Этап воркфлоу: Git' })
  assert.equal(stageLabel({ stage: { nodeId: 'g2', visits: { g2: 2 } } }, names, () => undefined)?.text, 'Пуш в origin · 2-й заход')
})
