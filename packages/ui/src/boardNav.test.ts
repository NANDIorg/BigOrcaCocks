import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isArrowKey, isEditableTarget, menuIndexForKey, moveFocus, stepMenu } from './boardNav'

const grid = [['a1', 'a2', 'a3'], [], ['b1'], ['c1', 'c2']]

test('moveFocus: вверх и вниз по колонке, у края остаёмся', () => {
  assert.equal(moveFocus(grid, 'a1', 'ArrowDown'), 'a2')
  assert.equal(moveFocus(grid, 'a2', 'ArrowUp'), 'a1')
  assert.equal(moveFocus(grid, 'a1', 'ArrowUp'), 'a1')
  assert.equal(moveFocus(grid, 'a3', 'ArrowDown'), 'a3')
})

test('moveFocus: вбок — в соседнюю непустую колонку на ту же строку, но не дальше последней карточки', () => {
  assert.equal(moveFocus(grid, 'a2', 'ArrowRight'), 'b1')
  assert.equal(moveFocus(grid, 'b1', 'ArrowRight'), 'c1')
  assert.equal(moveFocus(grid, 'c2', 'ArrowLeft'), 'b1')
  assert.equal(moveFocus(grid, 'a3', 'ArrowRight'), 'b1')
  assert.equal(moveFocus(grid, 'b1', 'ArrowLeft'), 'a1')
})

test('moveFocus: у левого и правого края остаёмся на месте', () => {
  assert.equal(moveFocus(grid, 'a1', 'ArrowLeft'), 'a1')
  assert.equal(moveFocus(grid, 'c1', 'ArrowRight'), 'c1')
})

test('moveFocus: текущей нет в сетке — первая карточка; сетка пуста — undefined', () => {
  assert.equal(moveFocus(grid, undefined, 'ArrowDown'), 'a1')
  assert.equal(moveFocus(grid, 'gone', 'ArrowRight'), 'a1')
  assert.equal(moveFocus([[], []], 'x', 'ArrowDown'), undefined)
  assert.equal(moveFocus([], undefined, 'ArrowUp'), undefined)
})

test('isArrowKey', () => {
  assert.equal(isArrowKey('ArrowLeft'), true)
  assert.equal(isArrowKey('Enter'), false)
})

test('isEditableTarget: поля ввода и contenteditable', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true)
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false)
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isEditableTarget(null), false)
})

test('menuIndexForKey: цифры 1–9, отключённые и лишние не выбираются', () => {
  const items = [{}, { disabled: true }, {}]
  assert.equal(menuIndexForKey('1', items), 0)
  assert.equal(menuIndexForKey('3', items), 2)
  assert.equal(menuIndexForKey('2', items), undefined)
  assert.equal(menuIndexForKey('4', items), undefined)
  assert.equal(menuIndexForKey('0', items), undefined)
  assert.equal(menuIndexForKey('a', items), undefined)
})

test('stepMenu: по кругу, отключённые пропускаются', () => {
  const items = [{}, { disabled: true }, {}, {}]
  assert.equal(stepMenu(items, 0, 1), 2)
  assert.equal(stepMenu(items, 3, 1), 0)
  assert.equal(stepMenu(items, 0, -1), 3)
  assert.equal(stepMenu(items, 2, -1), 0)
  assert.equal(stepMenu([{ disabled: true }], 0, 1), -1)
  assert.equal(stepMenu([], 0, 1), -1)
})
