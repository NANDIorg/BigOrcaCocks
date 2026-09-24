import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ColumnKind } from '@orca-board/core'
import {
  defaultTab, launchChecklist, readTabChoice, resolveTab, showsLaunchHint, showsSummary, stepTab, tabAt, tabTitle, visibleTabs, writeTabChoice,
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
  assert.deepEqual(['board', 'coordinator', 'history'].map((id) => tabTitle(id as GlobalTabId, 'review')), ['Доска', 'Координатор', 'История'])
})

test('«Входящие» — одна доска без вкладок', () => {
  assert.deepEqual(visibleTabs({ inbox: true }), ['board'])
  assert.deepEqual(visibleTabs({ inbox: false }), ['board', 'overview', 'coordinator', 'history'])
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
  assert.equal(tabAt(ALL, 4), undefined)
  assert.equal(tabAt(['board'], 1), undefined)
  assert.equal(stepTab(ALL, 'board', 'ArrowRight'), 'overview')
  assert.equal(stepTab(ALL, 'history', 'ArrowRight'), 'board')
  assert.equal(stepTab(ALL, 'board', 'ArrowLeft'), 'history')
  assert.equal(stepTab(ALL, 'overview', 'Home'), 'board')
  assert.equal(stepTab(ALL, 'overview', 'End'), 'history')
  assert.equal(stepTab(ALL, 'overview', 'Enter'), undefined)
  assert.equal(stepTab(['board'], 'history', 'ArrowRight'), undefined)
})
