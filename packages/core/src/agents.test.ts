// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effortOptionsFor, modelLabel, parseCodexModelsCache, type AgentInfo } from './agents.ts'

const cache = (models: unknown[]): string => JSON.stringify({ models })

describe('parseCodexModelsCache', () => {
  it('пустой/битый кэш без дефолта — []', () => {
    assert.deepEqual(parseCodexModelsCache(undefined), [])
    assert.deepEqual(parseCodexModelsCache(''), [])
    assert.deepEqual(parseCodexModelsCache('{не json'), [])
    assert.deepEqual(parseCodexModelsCache(cache([])), [])
  })

  it('пустой кэш с дефолтом — только дефолтная модель', () => {
    assert.deepEqual(parseCodexModelsCache('{не json', 'gpt-x'), [{ id: 'gpt-x', label: 'gpt-x (по умолчанию)' }])
  })

  it('efforts из supported_reasoning_levels; без поля или пустое — без efforts', () => {
    const text = cache([
      { slug: 'a', display_name: 'A', supported_reasoning_levels: [{ effort: 'low', description: '' }, { effort: 'max', description: '' }] },
      { slug: 'b', display_name: 'B' },
      { slug: 'c', display_name: 'C', supported_reasoning_levels: [] }
    ])
    assert.deepEqual(parseCodexModelsCache(text), [
      { id: 'a', label: 'A', efforts: ['low', 'max'] },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' }
    ])
  })

  it('дефолтная модель из кэша помечается, не из кэша — добавляется первой', () => {
    const text = cache([{ slug: 'a', display_name: 'A' }, { slug: 'b', display_name: 'B' }])
    assert.deepEqual(parseCodexModelsCache(text, 'b').map((m) => m.label), ['A', 'B (по умолчанию)'])
    assert.deepEqual(parseCodexModelsCache(text, 'z'), [
      { id: 'z', label: 'z (по умолчанию)' },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ])
  })

  it('скрытые модели пропускаются, кроме дефолтной', () => {
    const text = cache([{ slug: 'a', display_name: 'A', visibility: 'hide' }, { slug: 'b', display_name: 'B', visibility: 'hide' }])
    assert.deepEqual(parseCodexModelsCache(text, 'b'), [{ id: 'b', label: 'B (по умолчанию)' }])
  })
})

describe('effortOptionsFor / modelLabel', () => {
  const info: AgentInfo = {
    id: 'codex', title: 'Codex', installed: true, enabled: true, defaults: {},
    models: [{ id: 'a', label: 'A', efforts: ['low', 'xhigh'] }, { id: 'b', label: 'B' }]
  }

  it('efforts модели, иначе общий список агента', () => {
    assert.deepEqual(effortOptionsFor(info, 'a'), ['low', 'xhigh'])
    assert.deepEqual(effortOptionsFor(info, 'b'), ['low', 'medium', 'high'])
    assert.deepEqual(effortOptionsFor(info), ['low', 'medium', 'high'])
  })

  it('label по id, неизвестный — сам id', () => {
    assert.equal(modelLabel(info, 'a'), 'A')
    assert.equal(modelLabel(info, 'zzz'), 'zzz')
    assert.equal(modelLabel(undefined, 'zzz'), 'zzz')
    assert.equal(modelLabel(info, undefined), undefined)
  })
})
