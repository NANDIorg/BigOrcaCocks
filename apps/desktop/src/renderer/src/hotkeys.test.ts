import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTypingTarget, screenKey, type HotkeyEvent, type HotkeyTarget } from './hotkeys'

const div: HotkeyTarget = { tagName: 'DIV' }
const key = (over: Partial<HotkeyEvent> = {}): HotkeyEvent => ({
  key: 'g', code: 'KeyG', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: div, ...over
})

test('G — переход лента ↔ доска, в том числе в русской раскладке (по физической клавише)', () => {
  assert.equal(screenKey(key(), false), 'feed')
  assert.equal(screenKey(key({ key: 'п' }), false), 'feed')
  assert.equal(screenKey(key({ key: 'h', code: 'KeyH' }), false), undefined)
})

test('Esc — назад к общей доске', () => {
  assert.equal(screenKey(key({ key: 'Escape', code: 'Escape' }), false), 'back')
})

test('клавиши не срабатывают в полях ввода и рядом с ними', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
    assert.equal(screenKey(key({ target: { tagName } }), false), undefined, tagName)
    assert.equal(screenKey(key({ key: 'Escape', code: 'Escape', target: { tagName } }), false), undefined, tagName)
  }
  assert.equal(screenKey(key({ target: { tagName: 'DIV', isContentEditable: true } }), false), undefined)
  // Вложенный элемент внутри редактируемого блока: closest находит предка.
  assert.equal(screenKey(key({ target: { tagName: 'SPAN', closest: (sel) => (sel.includes('contenteditable') ? {} : null) } }), false), undefined)
  assert.equal(isTypingTarget({ tagName: 'SPAN', closest: () => null }), false)
})

test('уже обработанная клавиша, модификаторы, модалка и не-элемент в цели — не наши', () => {
  assert.equal(screenKey(key({ defaultPrevented: true }), false), undefined)
  assert.equal(screenKey(key({ key: 'Escape', code: 'Escape', defaultPrevented: true }), false), undefined)
  for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
    assert.equal(screenKey(key({ [m]: true }), false), undefined, m)
  }
  assert.equal(screenKey(key(), true), undefined)
  assert.equal(screenKey(key({ key: 'Escape', code: 'Escape' }), true), undefined)
  // Цель — окно или документ (нет tagName): вводом не считается.
  assert.equal(screenKey(key({ target: new EventTarget() }), false), 'feed')
  assert.equal(screenKey(key({ target: null }), false), 'feed')
})
