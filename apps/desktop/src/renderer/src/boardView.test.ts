import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_DONE_COLLAPSED_KEY, BOARD_FILTER_KEY, BOARD_ROLES_KEY, boardProgress, isBoardFilter, matchesFilter, readDoneCollapsed,
  readFilter, readRoles, writeDoneCollapsed, writeFilter, writeRoles, type FilterSubject
} from './boardView'

/** Подставляет localStorage на время теста; `fn` вызывается с хранилищем. */
function withStorage(store: Map<string, string> | 'broken', fn: () => void): void {
  const g = globalThis as { localStorage?: unknown }
  const prev = g.localStorage
  g.localStorage =
    store === 'broken'
      ? { getItem: () => { throw new Error('нет доступа') }, setItem: () => { throw new Error('нет доступа') } }
      : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  try {
    fn()
  } finally {
    g.localStorage = prev
  }
}

test('без localStorage — значения по умолчанию, запись не падает', () => {
  assert.equal(readFilter(), 'all')
  assert.equal(readDoneCollapsed(), true)
  assert.deepEqual(readRoles(), [])
  writeFilter('bad')
  writeDoneCollapsed(false)
  writeRoles(['dev'])
})

test('сломанный localStorage — тоже дефолты', () => {
  withStorage('broken', () => {
    assert.equal(readFilter(), 'all')
    assert.equal(readDoneCollapsed(), true)
    assert.deepEqual(readRoles(), [])
    writeFilter('wait')
    writeDoneCollapsed(false)
    writeRoles(['dev'])
  })
})

test('фильтр, «Сделано» и роли переживают чтение после записи', () => {
  const store = new Map<string, string>()
  withStorage(store, () => {
    writeFilter('wait')
    writeDoneCollapsed(false)
    writeRoles(['dev', 'qa'])
    assert.equal(readFilter(), 'wait')
    assert.equal(readDoneCollapsed(), false)
    assert.deepEqual(readRoles(), ['dev', 'qa'])
  })
  assert.equal(store.get(BOARD_FILTER_KEY), 'wait')
  assert.equal(store.get(BOARD_DONE_COLLAPSED_KEY), '0')
  assert.equal(store.get(BOARD_ROLES_KEY), '["dev","qa"]')
})

test('мусор в хранилище не ломает чтение', () => {
  const store = new Map([[BOARD_FILTER_KEY, 'nope'], [BOARD_ROLES_KEY, '{oops'], [BOARD_DONE_COLLAPSED_KEY, 'x']])
  withStorage(store, () => {
    assert.equal(readFilter(), 'all')
    assert.deepEqual(readRoles(), [])
    assert.equal(readDoneCollapsed(), true)
  })
  withStorage(new Map([[BOARD_ROLES_KEY, '[1,"a",null]']]), () => assert.deepEqual(readRoles(), ['a']))
  withStorage(new Map([[BOARD_ROLES_KEY, '"a"']]), () => assert.deepEqual(readRoles(), []))
})

test('isBoardFilter', () => {
  assert.equal(isBoardFilter('roles'), true)
  assert.equal(isBoardFilter('x'), false)
})

const subject = (over: Partial<FilterSubject> = {}): FilterSubject => ({ state: 'idle', waits: false, roleId: 'dev', ...over })

test('matchesFilter: все, ждут вас, проблемы', () => {
  assert.equal(matchesFilter('all', subject(), []), true)
  assert.equal(matchesFilter('wait', subject({ waits: true, state: 'human' }), []), true)
  assert.equal(matchesFilter('wait', subject(), []), false)
  assert.equal(matchesFilter('bad', subject({ state: 'bad', waits: true }), []), true)
  assert.equal(matchesFilter('bad', subject({ state: 'human', waits: true }), []), false)
})

test('matchesFilter: мои роли — только выбранные; пустой выбор ничего не отсекает', () => {
  assert.equal(matchesFilter('roles', subject({ roleId: 'dev' }), ['dev', 'qa']), true)
  assert.equal(matchesFilter('roles', subject({ roleId: 'design' }), ['dev', 'qa']), false)
  assert.equal(matchesFilter('roles', subject({ roleId: 'design' }), []), true)
})

test('boardProgress: сколько сделано и из чего полоса', () => {
  const p = boardProgress(['done', 'done', 'review', 'needs_input', 'in_progress', 'in_progress', 'backlog', 'ready', 'custom', undefined])
  assert.equal(p.total, 10)
  assert.equal(p.done, 2)
  assert.deepEqual(p.parts, [
    { key: 'done', count: 2 },
    { key: 'review', count: 1 },
    { key: 'input', count: 1 },
    { key: 'progress', count: 2 }
  ])
  assert.deepEqual(boardProgress([]), { total: 0, done: 0, parts: [] })
})
