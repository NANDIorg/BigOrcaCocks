import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSession, ColumnKind } from '@orca-board/core'
import {
  coordinatorPill, currentStep, defaultTab, headerActions, launchChecklist, statusSteps, readTabChoice, resolveTab, showsLaunchHint, showsSummary, stepTab, tabAt, tabTitle, visibleTabs, writeTabChoice,
  type GlobalTabId, type TabStorage
} from './globalScreen'

const ALL = visibleTabs({})

test('вкладка по умолчанию по состоянию: черновик и итог — «Итог и цель», работа — доска', () => {
  const expected: Record<ColumnKind, GlobalTabId> = {
    backlog: 'overview', ready: 'overview', in_progress: 'board', needs_input: 'board', review: 'overview', done: 'overview', custom: 'board'
  }
  for (const [kind, tab] of Object.entries(expected)) assert.equal(defaultTab(kind as ColumnKind), tab, kind)
  assert.equal(defaultTab(undefined), 'board')
})

test('заголовок второй вкладки: «Итог и цель» на проверке и в «Сделано», иначе «Цель и детали»', () => {
  assert.equal(tabTitle('overview', 'review'), 'Итог и цель')
  assert.equal(tabTitle('overview', 'done'), 'Итог и цель')
  assert.equal(tabTitle('overview', 'backlog'), 'Цель и детали')
  assert.equal(tabTitle('overview', 'in_progress'), 'Цель и детали')
  assert.deepEqual(['board', 'coordinator', 'history', 'stats'].map((id) => tabTitle(id as GlobalTabId, 'review')), ['Доска', 'Координатор', 'История', 'Статистика'])
})

test('вкладка «Статистика» — последняя, у «Входящих» её нет', () => {
  assert.equal(ALL[ALL.length - 1], 'stats')
  assert.equal(visibleTabs({ inbox: true }).includes('stats'), false)
  // Выбор «Статистики» переживает смену колонки: вкладка по умолчанию та же.
  assert.equal(resolveTab({ tab: 'stats', base: 'board' }, 'needs_input', ALL), 'stats')
  assert.equal(resolveTab({ tab: 'stats', base: 'board' }, 'in_progress', ['board']), 'board')
})

test('«Входящие» — одна доска без вкладок', () => {
  assert.deepEqual(visibleTabs({ inbox: true }), ['board'])
  assert.deepEqual(visibleTabs({ inbox: false }), ['board', 'overview', 'coordinator', 'history', 'stats'])
  assert.equal(resolveTab({ tab: 'history', base: 'board' }, undefined, ['board']), 'board')
})

test('выбор человека действует, пока вкладка по умолчанию не сменилась', () => {
  assert.equal(resolveTab(undefined, 'in_progress', ALL), 'board')
  assert.equal(resolveTab({ tab: 'history', base: 'board' }, 'in_progress', ALL), 'history')
  // «Нужен ответ» — тоже доска по умолчанию: выбор переживает переход работа → ответ.
  assert.equal(resolveTab({ tab: 'history', base: 'board' }, 'needs_input', ALL), 'history')
  // Ушли на «Проверку»: выбор, сделанный в работе, устарел — показываем итог.
  assert.equal(resolveTab({ tab: 'board', base: 'board' }, 'review', ALL), 'overview')
  // Выбор, сделанный на проверке, действует и в «Сделано» (та же вкладка по умолчанию).
  assert.equal(resolveTab({ tab: 'board', base: 'overview' }, 'done', ALL), 'board')
})

test('запомненный выбор: запись, чтение, мусор и недоступное хранилище', () => {
  const data = new Map<string, string>()
  const storage: TabStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  assert.equal(readTabChoice(storage, 'g1'), undefined)
  writeTabChoice(storage, 'g1', { tab: 'history', base: 'board' })
  assert.deepEqual(readTabChoice(storage, 'g1'), { tab: 'history', base: 'board' })
  assert.equal(readTabChoice(storage, 'g2'), undefined, 'по id задачи')
  for (const bad of ['{', 'null', '"x"', '{"tab":"nope","base":"board"}', '{"tab":"board"}']) {
    data.set('orca.gtab.bad', bad)
    assert.equal(readTabChoice(storage, 'bad'), undefined, bad)
  }
  const broken: TabStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(readTabChoice(broken, 'g1'), undefined)
  assert.doesNotThrow(() => writeTabChoice(broken, 'g1', { tab: 'board', base: 'board' }))
  assert.equal(readTabChoice(undefined, 'g1'), undefined)
})

test('сводка — на проверке и в «Сделано»; подсказка запуска — в черновике; у «Входящих» ничего', () => {
  assert.equal(showsSummary('review'), true)
  assert.equal(showsSummary('done'), true)
  assert.equal(showsSummary('in_progress'), false)
  assert.equal(showsSummary(undefined), false)
  assert.equal(showsSummary('review', true), false)
  assert.equal(showsLaunchHint('backlog'), true)
  assert.equal(showsLaunchHint('ready'), true)
  assert.equal(showsLaunchHint('in_progress'), false)
  assert.equal(showsLaunchHint('backlog', true), false)
})

test('чек-лист перед запуском', () => {
  const g = { title: 'Экспорт', description: 'Выгрузка отчётов в PDF', progress: { total: 0 } }
  assert.deepEqual(launchChecklist(g, 'Фича'), [
    { ok: true, text: 'Тип «Фича» — роли и воркфлоу заданы' },
    { ok: true, text: 'Цель описана' },
    { ok: false, text: 'Подзадачи — их создаст координатор' }
  ])
  const bare = launchChecklist({ ...g, description: ' Экспорт ', progress: { total: 3 } }, undefined)
  assert.deepEqual(bare.map((c) => c.ok), [false, false, true])
  assert.match(bare[2]!.text, /3/)
  assert.equal(launchChecklist({ ...g, description: '' }, 'Фича')[1]!.ok, false)
})

test('переключение вкладок: по индексу и стрелками по кругу', () => {
  assert.equal(tabAt(ALL, 0), 'board')
  assert.equal(tabAt(ALL, 3), 'history')
  assert.equal(tabAt(ALL, 4), 'stats')
  assert.equal(tabAt(ALL, 5), undefined)
  assert.equal(tabAt(['board'], 1), undefined)
  assert.equal(stepTab(ALL, 'board', 'ArrowRight'), 'overview')
  assert.equal(stepTab(ALL, 'stats', 'ArrowRight'), 'board')
  assert.equal(stepTab(ALL, 'board', 'ArrowLeft'), 'stats')
  assert.equal(stepTab(ALL, 'overview', 'Home'), 'board')
  assert.equal(stepTab(ALL, 'overview', 'End'), 'stats')
  assert.equal(stepTab(ALL, 'overview', 'Enter'), undefined)
  assert.equal(stepTab(['board'], 'history', 'ArrowRight'), undefined)
})

// ---------- шапка ----------

const COLS = [
  { id: 'backlog', title: 'Бэклог', kind: 'backlog' as const, color: '#6b6f7c' },
  { id: 'progress', title: 'В работе', kind: 'in_progress' as const, color: '#f08a3a' },
  { id: 'input', title: 'Нужен ответ', kind: 'needs_input' as const, color: '#e8b04a' },
  { id: 'review', title: 'Проверка', kind: 'review' as const, color: '#b57bee' },
  { id: 'done', title: 'Сделано', kind: 'done' as const, color: '#5ad1cc' }
]

test('степпер: шаги по колонкам, текущий и прошедшие; «Нужен ответ» не кликается', () => {
  const steps = statusSteps(COLS, 'review')
  assert.deepEqual(steps.map((s) => s.state), ['past', 'past', 'past', 'now', 'next'])
  assert.deepEqual(steps.map((s) => s.movable), [true, true, false, false, true])
  assert.equal(currentStep(steps)?.title, 'Проверка')
  assert.equal(steps[3]?.color, '#b57bee')
})

test('степпер: задача в «Нужен ответ» — текущий шаг она сама, перенос в неё недоступен', () => {
  const steps = statusSteps(COLS, 'input')
  assert.equal(currentStep(steps)?.id, 'input')
  assert.deepEqual(steps.filter((s) => s.movable).map((s) => s.id), ['backlog', 'progress', 'review', 'done'])
})

test('степпер: неизвестный статус (старый main, чужая колонка) — текущего нет, переносить можно', () => {
  const steps = statusSteps(COLS, 'custom-x')
  assert.equal(currentStep(steps), undefined)
  assert.ok(steps.every((s) => s.state === 'next'))
  assert.deepEqual(steps.map((s) => s.movable), [true, true, false, true, true])
  assert.deepEqual(statusSteps([], 'backlog'), [])
})

test('главное действие: «Проверка» — Подтвердить и Вернуть в работу', () => {
  const a = headerActions({}, 'review', false)
  assert.deepEqual(a.primary, { kind: 'accept', label: 'Подтвердить' })
  assert.equal(a.returnToWork, true)
  // Прежний координатор ещё жив — возврат всё равно доступен (globalReview).
  assert.equal(headerActions({}, 'review', true).returnToWork, true)
})

test('главное действие: «Нужен ответ» — «Ответить · N», число из ленты, иначе из waiting', () => {
  assert.deepEqual(headerActions({ waiting: 1 }, 'needs_input', true, 3).primary, { kind: 'answer', label: 'Ответить · 3', count: 3 })
  assert.deepEqual(headerActions({ waiting: 2 }, 'needs_input', true).primary, { kind: 'answer', label: 'Ответить · 2', count: 2 })
  // Запрос успели закрыть: отвечать нечего — обычное состояние (живой координатор — кнопок нет).
  assert.equal(headerActions({ waiting: 0 }, 'needs_input', true, 0).primary, undefined)
  // Координатор не запущен — запуск остаётся рядом, но без акцента.
  const a = headerActions({ waiting: 1 }, 'needs_input', false, 1)
  assert.equal(a.primary?.kind, 'answer')
  assert.equal(a.quietStart, true)
})

test('главное действие: запуск координатора — акцентный, пока он не запущен', () => {
  for (const kind of ['backlog', 'ready', 'in_progress', 'custom', undefined] as const) {
    assert.deepEqual(headerActions({}, kind, false).primary, { kind: 'start', label: 'Запустить координатора' }, String(kind))
    assert.equal(headerActions({}, kind, true).primary, undefined, `${kind}: координатор жив — кнопки запуска нет`)
  }
  // «Сделано»: решать нечего, запуск — второстепенный.
  const done = headerActions({}, 'done', false)
  assert.equal(done.primary, undefined)
  assert.equal(done.quietStart, true)
  assert.equal(headerActions({}, 'done', true).quietStart, false)
})

test('главное действие: «Входящие» — без координатора и решений', () => {
  for (const kind of ['backlog', 'needs_input', 'review', 'done'] as const) {
    assert.deepEqual(headerActions({ inbox: true, waiting: 2 }, kind, false, 2), { returnToWork: false, quietStart: false }, kind)
  }
})

const H = 3_600_000
const session = (over: Partial<AgentSession> = {}): AgentSession => ({ ptyId: 'p1', roleId: 'coordinator', agent: 'claude', startedAt: 0, ...over })

test('пилюля: живой координатор — модель, номер запуска и время с его начала', () => {
  const sessions = [session({ ptyId: 'p1', model: 'Claude Opus', startedAt: 0, endedAt: 2 * H }), session({ ptyId: 'p2', model: 'Claude Opus', startedAt: 10 * H })]
  const p = coordinatorPill({ live: true, waiting: false, sessions, ptyId: 'p2' }, 10 * H + 72 * 60_000)
  assert.equal(p.state, 'working')
  assert.equal(p.title, 'Координатор работает')
  assert.deepEqual(p.parts, ['Claude Opus', '2-й запуск', '1 ч 12 мин'])
  assert.equal(p.live, true)
})

test('пилюля: живой и ждёт человека — «ждёт вас»', () => {
  const p = coordinatorPill({ live: true, waiting: true, sessions: [session({ model: 'M' })], ptyId: 'p1' }, 5 * 60_000)
  assert.equal(p.state, 'waiting')
  assert.equal(p.title, 'Координатор ждёт вас')
})

test('пилюля: завершил — время работы запуска, а не «с тех пор»', () => {
  const p = coordinatorPill({ live: false, waiting: false, sessions: [session({ endedAt: 90 * 60_000 })], agent: 'claude' }, 100 * H)
  assert.equal(p.state, 'finished')
  assert.equal(p.title, 'Координатор завершил')
  assert.deepEqual(p.parts, ['Claude Code', '1-й запуск', '1 ч 30 мин'])
  assert.equal(p.live, false)
})

test('пилюля: старый main без запусков — только агент; без агента и живого — «не запущен»', () => {
  const live = coordinatorPill({ live: true, waiting: false, agent: 'claude', ptyId: 'p1' }, 0)
  assert.equal(live.title, 'Координатор работает')
  assert.deepEqual(live.parts, ['Claude Code'])
  const idle = coordinatorPill({ live: false, waiting: false }, 0)
  assert.deepEqual([idle.state, idle.title, idle.parts], ['idle', 'Координатор не запущен', []])
  assert.equal(coordinatorPill({ live: false, waiting: false, sessions: [] }, 0).state, 'idle')
})

test('пилюля: незакрытый прошлый запуск без endedAt — время неизвестно, а не отрицательное', () => {
  const p = coordinatorPill({ live: false, waiting: false, sessions: [session({ model: 'M' })] }, 5 * H)
  assert.deepEqual(p.parts, ['M', '1-й запуск'])
})
