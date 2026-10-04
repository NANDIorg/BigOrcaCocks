import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from './i18n'
import { relativeTime, richParts, subtasksLabel } from './globalFormat'

/** Выполнить на английском и вернуть русский: остальные тесты файла ждут язык по умолчанию. */
function inEnglish(fn: () => void): void {
  setLocale('en')
  try {
    fn()
  } finally {
    setLocale('ru')
  }
}

const MIN = 60_000
const NOW = new Date(2026, 8, 25, 16, 0).getTime()

test('relativeTime: только что, минуты и часы назад — по языку интерфейса', () => {
  assert.equal(relativeTime(NOW - 30_000, NOW), 'только что')
  assert.equal(relativeTime(NOW - 5 * MIN, NOW), '5 мин назад')
  assert.equal(relativeTime(NOW - 3 * 60 * MIN, NOW), '3 ч назад')
  inEnglish(() => {
    assert.equal(relativeTime(NOW - 30_000, NOW), 'just now')
    assert.equal(relativeTime(NOW - 5 * MIN, NOW), '5 min ago')
    assert.equal(relativeTime(NOW - 3 * 60 * MIN, NOW), '3 h ago')
  })
})

test('relativeTime: старше суток — дата и время в формате языка', () => {
  const old = new Date(2026, 8, 20, 9, 5).getTime()
  assert.equal(relativeTime(old, NOW), '20.09, 09:05')
  inEnglish(() => assert.equal(relativeTime(old, NOW), '09/20, 09:05 AM'))
})

test('subtasksLabel: русские три формы, английские две', () => {
  assert.deepEqual([1, 3, 5, 11, 21, 22].map(subtasksLabel), ['1 подзадача', '3 подзадачи', '5 подзадач', '11 подзадач', '21 подзадача', '22 подзадачи'])
  inEnglish(() => assert.deepEqual([1, 3].map(subtasksLabel), ['1 subtask', '3 subtasks']))
})

test('richParts: текст и места под элементы в порядке шаблона', () => {
  assert.deepEqual(richParts('В работе в среднем {time}'), [{ text: 'В работе в среднем ' }, { slot: 'time' }])
  assert.deepEqual(richParts('{total}, закрыто {done}.'), [{ slot: 'total' }, { text: ', закрыто ' }, { slot: 'done' }, { text: '.' }])
  assert.deepEqual(richParts('без слотов'), [{ text: 'без слотов' }])
  assert.deepEqual(richParts(''), [])
})
