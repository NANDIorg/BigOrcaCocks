import { it } from 'node:test'
import assert from 'node:assert/strict'
import * as runtime from '../src/index.ts'
import type { ProjectMessageKey, ProjectMessageParams } from '../src/project-messages.ts'

class HostError extends Error {
  readonly key: ProjectMessageKey
  readonly params?: ProjectMessageParams
  constructor(key: ProjectMessageKey, params?: ProjectMessageParams) {
    super(key)
    this.key = key
    this.params = params
  }
}

function settings() {
  assert.equal(typeof runtime.createRuntimeSettings, 'function', 'Общий codec доступен без Desktop')
  return runtime.createRuntimeSettings({ Error: HostError, text: key => key })
}

it('патч общих настроек сохраняет чужие поля и не мутирует исходные данные', () => {
  const codec = settings()
  const raw = { language: 'ru' as const, keepInBackground: false, updates: { autoDownload: false }, futureHost: { tokenRef: 'opaque' } }
  const next = codec.merge(raw, { language: 'en', appearance: { theme: 'paper' } })
  assert.deepEqual(next, { ...raw, language: 'en', appearance: { theme: 'paper', motion: 'system', highSaturation: false } })
  assert.equal(raw.language, 'ru')
  const loaded = codec.load(next)
  assert.equal(loaded.language, 'en')
  assert.equal('keepInBackground' in loaded, false)
  assert.equal('updates' in loaded, false)
})

it('чтение повреждённых настроек сохраняет пригодные поля ассистента', () => {
  const loaded = settings().load({ assistant: { agent: 'missing', model: ' model ', systemPrompt: ' текст ', extraArgs: '--bad "' } } as unknown as runtime.StoredRuntimeSettings)
  assert.deepEqual(loaded.assistant, { agent: 'claude', model: 'model', systemPrompt: ' текст ' })
  assert.deepEqual(loaded.appearance, { theme: 'graphite', motion: 'system', highSaturation: false })
})

it('смена агента сбрасывает его модель, effort и флаги, но сохраняет инструкцию', () => {
  const codec = settings()
  const next = codec.merge({ assistant: { agent: 'claude', model: 'old', effort: 'high', extraArgs: '--verbose', systemPrompt: ' текст ' } }, { assistant: { agent: 'codex' } })
  assert.deepEqual(next.assistant, { agent: 'codex', systemPrompt: ' текст ' })
  assert.deepEqual(codec.merge(next, { assistant: { systemPrompt: '  ', model: ' m ' } }).assistant, { agent: 'codex', model: 'm' })
})

it('невалидный patch отклоняется до изменения сохранённых настроек', () => {
  const codec = settings()
  const raw = { assistant: { agent: 'claude' as const, model: 'old' } }
  assert.throws(() => codec.merge(raw, null as unknown as runtime.RuntimeSettingsPatch), /ожидается объект/)
  assert.throws(() => codec.merge(raw, { assistant: { extraArgs: 'not-a-flag' } }), e => e instanceof HostError && e.key === 'assistant.extraArgsInvalid' && typeof e.params?.reason === 'object')
  assert.deepEqual(raw, { assistant: { agent: 'claude', model: 'old' } })
})
