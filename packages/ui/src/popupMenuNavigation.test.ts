import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { popupMenuKey, popupMenuShortcut } from './popupMenuNavigation'

describe('клавиатура вложенного popup-меню', () => {
  const items = [{}, { disabled: true }, { children: [{}] }]
  it('стрелки и Home/End пропускают недоступные пункты с переходом через край', () => {
    assert.deepEqual(popupMenuKey(items, 0, 'ArrowDown', false), { kind: 'select', index: 2 })
    assert.deepEqual(popupMenuKey(items, 2, 'ArrowDown', false), { kind: 'select', index: 0 })
    assert.deepEqual(popupMenuKey(items, 0, 'End', false), { kind: 'select', index: 2 })
    assert.deepEqual(popupMenuKey(items, 2, 'Home', false), { kind: 'select', index: 0 })
    assert.deepEqual(popupMenuKey([{ disabled: true }], 0, 'Enter', false), { kind: 'none' })
    assert.deepEqual(popupMenuKey([], -1, 'ArrowDown', false), { kind: 'none' })
  })
  it('Right открывает раздел, Left/Esc возвращают в родителя, Tab закрывает весь popup', () => {
    assert.deepEqual(popupMenuKey(items, 2, 'ArrowRight', false), { kind: 'pick' })
    assert.deepEqual(popupMenuKey(items, 0, 'ArrowRight', false), { kind: 'none' })
    assert.deepEqual(popupMenuKey(items, 2, 'ArrowLeft', true), { kind: 'back' })
    assert.deepEqual(popupMenuKey(items, 2, 'ArrowLeft', false), { kind: 'none' })
    assert.deepEqual(popupMenuKey(items, 2, 'Escape', true), { kind: 'back' })
    assert.deepEqual(popupMenuKey(items, 2, 'Escape', false), { kind: 'close' })
    assert.deepEqual(popupMenuKey(items, 2, 'Tab', true), { kind: 'close' })
    assert.deepEqual(popupMenuKey(items, 0, ' ', true), { kind: 'pick' })
  })
})

describe('сочетания меню приложения', () => {
  const items = [{ id: 'file', children: [{ id: 'settings', hint: 'Ctrl+,' }] },
    { id: 'edit', children: [{ id: 'copy', hint: 'Ctrl+C' }, { id: 'cut', hint: 'Ctrl+X', disabled: true }] },
    { id: 'view', children: [{ id: 'zoom', hint: 'Ctrl++' }, { id: 'dev', hint: 'Ctrl+Shift+I' }, { id: 'fullscreen', hint: 'F11' }] }]
  const event = (key: string, ctrlKey = true, shiftKey = false) => ({ key, ctrlKey, shiftKey, altKey: false, metaKey: false })
  it('находит команды любого раздела, учитывает модификаторы и отключённые пункты', () => {
    assert.equal(popupMenuShortcut(items, event('c')), 'copy')
    assert.equal(popupMenuShortcut(items, event(',')), 'settings')
    assert.equal(popupMenuShortcut(items, event('x')), undefined)
    assert.equal(popupMenuShortcut(items, event('C', true, true)), undefined)
    assert.equal(popupMenuShortcut(items, event('I', true, true)), 'dev')
    assert.equal(popupMenuShortcut(items, event('+', true, true)), 'zoom')
    assert.equal(popupMenuShortcut(items, event('F11', false)), 'fullscreen')
    assert.equal(popupMenuShortcut(items, { ...event('c'), metaKey: true }), undefined)
    assert.equal(popupMenuShortcut([{ id: 'edit', disabled: true, children: items }], event('c')), undefined)
  })
  it('русская раскладка сохраняет команды по физическим кодам клавиш', () => {
    assert.equal(popupMenuShortcut(items, { ...event('с'), code: 'KeyC' }), 'copy')
    assert.equal(popupMenuShortcut(items, { ...event('б'), code: 'Comma' }), 'settings')
    assert.equal(popupMenuShortcut(items, { ...event('+', true, true), code: 'Equal' }), 'zoom')
    assert.equal(popupMenuShortcut(items, { ...event('ш', true, true), code: 'KeyI' }), 'dev')
  })
  it('немецкая раскладка не переставляет Undo/Redo по физическим Y/Z', () => {
    const edit = [{ id: 'undo', hint: 'Ctrl+Z' }, { id: 'redo', hint: 'Ctrl+Y' }]
    assert.equal(popupMenuShortcut(edit, { ...event('z'), code: 'KeyY' }), 'undo')
    assert.equal(popupMenuShortcut(edit, { ...event('y'), code: 'KeyZ' }), 'redo')
  })
})
