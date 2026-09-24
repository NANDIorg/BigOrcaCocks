import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTypingTarget, screenKey, tabKey, type HotkeyEvent, type HotkeyTarget } from './hotkeys'

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

const digit = (n: number, over: Partial<HotkeyEvent> = {}): HotkeyEvent => key({ key: String(n), code: `Digit${n}`, ...over })
const inside = (selector: string): HotkeyTarget => ({ tagName: 'BUTTON', closest: (sel) => (sel.includes(selector) ? {} : null) })

test('вкладки: Alt+1…4 и голые 1…4 вне доски; цифры выше 4 не трогаем', () => {
  for (let n = 1; n <= 4; n++) {
    assert.equal(tabKey(digit(n), false), n - 1)
    assert.equal(tabKey(digit(n, { altKey: true }), false), n - 1)
  }
  assert.equal(tabKey(digit(5), false), undefined)
  assert.equal(tabKey(digit(9, { altKey: true }), false), undefined)
  // Alt на macOS меняет key (¡™£¢), физическая клавиша та же.
  assert.equal(tabKey(key({ key: '¡', code: 'Digit1', altKey: true }), false), 0)
  assert.equal(tabKey(key({ key: 'g', code: 'KeyG' }), false), undefined)
})

test('вкладки: голая цифра на доске, в ленте и в меню «Переместить в…» — их, а Alt+цифра работает и там', () => {
  for (const owner of ['.board-wrap', '.attn', '[role="menu"]']) {
    const target = inside(owner)
    assert.equal(tabKey(digit(2, { target }), false), undefined, owner)
    assert.equal(tabKey(digit(2, { target, altKey: true }), false), 1, owner)
  }
  // Кнопка вкладки, шапка, окно и документ — не владельцы цифр.
  assert.equal(tabKey(digit(3, { target: inside('.gt-tabs') }), false), 2)
  assert.equal(tabKey(digit(3, { target: new EventTarget() }), false), 2)
  assert.equal(tabKey(digit(3, { target: null }), false), 2)
})

test('вкладки: не срабатывают в полях ввода, в модалке, после preventDefault и с Ctrl/Cmd/Shift', () => {
  assert.equal(tabKey(digit(1, { target: { tagName: 'TEXTAREA' }, altKey: true }), false), undefined)
  assert.equal(tabKey(digit(1), true), undefined)
  assert.equal(tabKey(digit(1, { defaultPrevented: true }), false), undefined)
  for (const m of ['ctrlKey', 'metaKey', 'shiftKey'] as const) assert.equal(tabKey(digit(1, { [m]: true }), false), undefined, m)
})

test('вкладки не мешают G и Esc: это разные клавиши, а Alt+G по-прежнему не наш', () => {
  assert.equal(screenKey(key(), false), 'feed')
  assert.equal(tabKey(key(), false), undefined)
  assert.equal(tabKey(key({ key: 'Escape', code: 'Escape' }), false), undefined)
  assert.equal(screenKey(digit(1), false), undefined)
  assert.equal(screenKey(digit(1, { altKey: true }), false), undefined)
})
