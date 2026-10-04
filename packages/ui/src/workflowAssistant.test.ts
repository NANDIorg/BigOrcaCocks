import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, DEFAULT_ROLES } from '@orca-board/core'
import { consumeWorkflowAttachment, settledWorkflowDraft, workflowAssistantError, requestedWorkflowTypeExists, sendWorkflowApi, syncWorkflowDraft, workflowAssistantApi, type WorkflowAttachment } from './workflowAssistant'

const baseline = () => defaultWorkflow(DEFAULT_ROLES)
test('чистый редактор принимает внешний граф; грязный и возвращённый draft сохраняют исходную базу', () => {
  const a = baseline(); const b = structuredClone(a); b.nodes[0].title = 'new'
  const d = structuredClone(a); d.nodes[0].title = 'draft'
  assert.deepEqual(syncWorkflowDraft({ draft: a, baseline: a }, b), { draft: b, baseline: b, conflict: false, replaced: true })
  assert.deepEqual(syncWorkflowDraft({ draft: d, baseline: a }, b), { draft: d, baseline: a, conflict: true, replaced: false })
  assert.deepEqual(syncWorkflowDraft({ draft: d, baseline: a }, a), { draft: d, baseline: a, conflict: false, replaced: false })
})
test('consume снимает только успешно отправленный nonce в той же сессии', () => {
  const old: WorkflowAttachment = { nonce: 1, context: { mode: 'create' } }
  const next: WorkflowAttachment = { nonce: 2, context: { mode: 'create' } }
  assert.equal(consumeWorkflowAttachment(old, old, 's1', 's1'), null)
  assert.equal(consumeWorkflowAttachment(next, old, 's1', 's1'), next)
  assert.equal(consumeWorkflowAttachment(old, old, 's1', 's2'), old)
})
test('новые API требуют перезапуска старого preload, без небезопасного fallback', () => {
  assert.throws(() => workflowAssistantApi({}), /перезапуст|restart/i)
  assert.throws(() => sendWorkflowApi({}), /перезапуст|restart/i)
})
test('удалённый запрошенный тип не становится fallback графом', () => {
  assert.equal(requestedWorkflowTypeExists(['existing'], 'gone'), false)
  assert.equal(requestedWorkflowTypeExists(['existing'], 'existing'), true)
})

test('поздний resolve не очищает новый compose, новый контекст или новый диалог', () => {
  assert.equal(settledWorkflowDraft('Отправленный', 'Отправленный', 's1', 's1', 1, 1), '')
  assert.equal(settledWorkflowDraft('Следующий текст', 'Отправленный', 's1', 's1', 1, 1), 'Следующий текст')
  assert.equal(settledWorkflowDraft('Отправленный', 'Отправленный', 's1', 's2', 1, 1), 'Отправленный')
  assert.equal(settledWorkflowDraft('Отправленный', 'Отправленный', 's1', 's1', 1, 2), 'Отправленный')
})
test('старый main с новым preload показывает перезапуск для всех новых операций', () => {
  for (const channel of ['assistantChat:sendWithWorkflow', 'workflowAssistant:save', 'taskTypes:patch', 'taskTypes:rename']) {
    assert.match(workflowAssistantError(`No handler registered for '${channel}'`), /перезапуст|restart/i)
  }
  assert.equal(workflowAssistantError('Network refused'), 'Network refused')
})
