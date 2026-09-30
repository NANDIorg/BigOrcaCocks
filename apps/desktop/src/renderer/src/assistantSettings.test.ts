import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentInfo, AssistantSettings } from '@orca-board/core'
import type { AppSettings } from '../../shared/ipc'
import {
  assistantAgentOf, assistantAgentPatch, assistantAgents, assistantModelPatch, assistantSavePatch, assistantView, withAssistantPatch
} from './assistantSettings'

const agent = (id: AgentInfo['id'], installed: boolean): AgentInfo =>
  ({ id, title: id, installed, enabled: false } as AgentInfo)

test('assistantView — загрузка, старый main без assistant, настройки', () => {
  assert.deepEqual(assistantView(null), { kind: 'loading' })
  // Старый main не знает поля: в ответе его нет, записать настройки нельзя.
  assert.deepEqual(assistantView({} as Pick<AppSettings, 'assistant'>), { kind: 'stale' })
  const assistant: AssistantSettings = { agent: 'codex', model: 'gpt-5' }
  assert.deepEqual(assistantView({ assistant }), { kind: 'ready', assistant })
})

test('смена агента сбрасывает модель, effort и флаги запуска; пустые поля не храним', () => {
  const s: AssistantSettings = { agent: 'claude', model: 'opus', effort: 'high', systemPrompt: 'кратко', extraArgs: '--verbose' }
  assert.deepEqual(withAssistantPatch(s, assistantAgentPatch('codex')), { agent: 'codex', systemPrompt: 'кратко' })
  assert.deepEqual(withAssistantPatch(s, { systemPrompt: '  ', model: '', extraArgs: ' ' }), { agent: 'claude', effort: 'high' })
  // Флаги хранятся как введены: пробел в конце не обрезается, пока человек печатает.
  assert.equal(withAssistantPatch(s, { extraArgs: '--debug ' }).extraArgs, '--debug ')
})

test('смена модели: effort, которого нет у новой модели, сбрасывается', () => {
  const s: AssistantSettings = { agent: 'claude', effort: 'max' }
  assert.deepEqual(assistantModelPatch(s, 'sonnet', ['low', 'high']), { model: 'sonnet', effort: undefined })
  assert.deepEqual(assistantModelPatch(s, 'opus', ['high', 'max']), { model: 'opus', effort: 'max' })
})

test('assistantSavePatch — пустые поля уходят пустой строкой, чтобы main их очистил', () => {
  assert.deepEqual(assistantSavePatch({ agent: 'claude' }, true), { agent: 'claude', model: '', effort: '', systemPrompt: '', extraArgs: '' })
  assert.deepEqual(
    assistantSavePatch({ agent: 'codex', model: 'm', effort: 'e', systemPrompt: 'p', extraArgs: '--search' }, true),
    { agent: 'codex', model: 'm', effort: 'e', systemPrompt: 'p', extraArgs: '--search' }
  )
})

test('assistantSavePatch — старому main флаги запуска не отправляются', () => {
  assert.deepEqual(assistantSavePatch({ agent: 'claude' }, false), { agent: 'claude', model: '', effort: '', systemPrompt: '' })
  assert.deepEqual(
    assistantSavePatch({ agent: 'codex', model: 'm', extraArgs: '--search' }, false),
    { agent: 'codex', model: 'm', effort: '', systemPrompt: '' }
  )
})

test('assistantAgents — доступны все установленные, независимо от выключения в проекте', () => {
  const list = assistantAgents([agent('claude', true), agent('codex', false)])
  assert.deepEqual(list.map((a) => [a.id, a.enabled]), [['claude', true], ['codex', false]])
})

test('assistantAgentOf — агент из настроек; нет настроек или старый main — claude', () => {
  assert.equal(assistantAgentOf({ assistant: { agent: 'codex' } }), 'codex')
  assert.equal(assistantAgentOf(null), 'claude')
  assert.equal(assistantAgentOf({} as Pick<AppSettings, 'assistant'>), 'claude')
})
