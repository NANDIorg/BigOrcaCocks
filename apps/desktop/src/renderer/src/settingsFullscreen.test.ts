import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settingsKeyAction } from './settingsFullscreen'

test('Escape в полноэкранном режиме сворачивает окно, а не закрывает', () => {
  assert.equal(settingsKeyAction('Escape', true), 'exitFullscreen')
})

test('Escape в обычном размере закрывает настройки', () => {
  assert.equal(settingsKeyAction('Escape', false), 'close')
})

test('прочие клавиши окно не трогают', () => {
  for (const key of ['Enter', 'a', 'F11', 'Esc']) {
    assert.equal(settingsKeyAction(key, true), undefined)
    assert.equal(settingsKeyAction(key, false), undefined)
  }
})
