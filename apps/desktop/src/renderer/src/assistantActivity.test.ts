import { it } from 'node:test'
import assert from 'node:assert/strict'
import { assistantActivityOf, assistantRailState } from './assistantActivity'
import { applyChatUpdate, chatStateFromSnapshot } from './assistantChat'

const initial = chatStateFromSnapshot({ ptyId: 's1', protocolVersion: 2, revision: 1, transport: 'chat', status: 'thinking', messages: [
  { id: 'h1', role: 'human', text: 'Создай воркфлоу', at: 1 },
  { id: 'a1', role: 'agent', text: 'Проверю граф.', at: 2 }
] })

it('закрытый чат показывает работу между частями ответа и во время команды', () => {
  assert.equal(assistantRailState(assistantActivityOf(initial), null, false), 'working')
  const running = applyChatUpdate(initial, { ptyId: 's1', revision: 2, message: { id: 't1', role: 'tool', text: '', at: 3, toolCalls: [{ name: 'Команда', input: 'orca-board types list', status: 'running' }] } })
  assert.equal(assistantRailState(assistantActivityOf(running), null, false), 'working')
  assert.equal(assistantRailState(assistantActivityOf(running), null, true), 'idle')
})

it('готовый ответ отмечается до открытия чата; следующий ответ снова непрочитан', () => {
  const done = assistantActivityOf(applyChatUpdate(initial, { ptyId: 's1', revision: 3, status: 'done' }))
  assert.equal(assistantRailState(done, null, false), 'unread')
  assert.equal(assistantRailState(done, null, true), 'idle')
  assert.equal(assistantRailState(done, done, false), 'idle', 'открытие отмечает текущую ревизию прочитанной')
  assert.equal(assistantRailState({ ...done, revision: 6 }, done, false), 'unread')
  assert.equal(assistantRailState({ ...done, ptyId: 's2' }, done, false), 'unread', 'прочитанность не переносится в новый диалог')
})

it('пустой диалог и ответ прошлого запроса не создают красную точку', () => {
  const empty = assistantActivityOf({ ...initial, messages: [], status: 'done' })
  assert.equal(assistantRailState(empty, null, false), 'idle')
  const next = assistantActivityOf({ ...initial, status: 'done', messages: [...initial.messages, { id: 'h2', role: 'human', text: 'Ещё вопрос', at: 3 }] })
  assert.equal(assistantRailState(next, null, false), 'idle')
})

it('запрос разрешения заметен даже если thinking ещё не сменился на waiting', () => {
  const waiting = assistantActivityOf({ ...initial, interactions: [{ id: 'r1', kind: 'permission', title: 'Команда' }] })
  assert.equal(assistantRailState(waiting, null, false), 'waiting')
  assert.equal(assistantRailState(waiting, waiting, false), 'waiting', 'пока запрос активен, ему нужно действие пользователя')
  assert.equal(assistantRailState(waiting, null, true), 'idle')
})

it('ошибка привлекает внимание, а остановка не считается готовым ответом', () => {
  const failed = assistantActivityOf({ ...initial, status: 'error', revision: 3 })
  assert.equal(assistantRailState(failed, null, false), 'error')
  assert.equal(assistantRailState(failed, failed, false), 'idle')
  assert.equal(assistantRailState(assistantActivityOf({ ...initial, status: 'interrupted' }), null, false), 'idle')
})

it('терминальный агент не имитирует чат-статус, запуск чата показывает работу', () => {
  assert.equal(assistantRailState(assistantActivityOf({ ...initial, transport: 'terminal' }), null, false), 'idle')
  assert.equal(assistantRailState(null, null, false), 'idle')
  assert.equal(assistantRailState(null, null, false, true), 'working')
  assert.equal(assistantRailState(null, null, true, true), 'idle')
})

it('фрагменты ответа не обновляют оболочку, финальная ревизия обновляет уведомление', () => {
  const fragment = { ...initial, revision: 2, messages: [...initial.messages, { id: 'a2', role: 'agent' as const, text: 'Продолжаю.', at: 3 }] }
  assert.deepEqual(assistantActivityOf(fragment), assistantActivityOf(initial))
  assert.equal(assistantActivityOf({ ...fragment, status: 'done' }).revision, 2)
})
