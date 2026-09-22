import { describe, expect, it } from 'vitest'
import { effortOptionsFor, modelLabel, parseCodexModelsCache, type AgentInfo } from './agents'

const cache = (models: unknown[]): string => JSON.stringify({ models })

describe('parseCodexModelsCache', () => {
  it('пустой/битый кэш без дефолта — []', () => {
    expect(parseCodexModelsCache(undefined)).toEqual([])
    expect(parseCodexModelsCache('')).toEqual([])
    expect(parseCodexModelsCache('{не json')).toEqual([])
    expect(parseCodexModelsCache(cache([]))).toEqual([])
  })

  it('пустой кэш с дефолтом — только дефолтная модель', () => {
    expect(parseCodexModelsCache('{не json', 'gpt-x')).toEqual([{ id: 'gpt-x', label: 'gpt-x (по умолчанию)' }])
  })

  it('efforts из supported_reasoning_levels; без поля или пустое — без efforts', () => {
    const text = cache([
      { slug: 'a', display_name: 'A', supported_reasoning_levels: [{ effort: 'low', description: '' }, { effort: 'max', description: '' }] },
      { slug: 'b', display_name: 'B' },
      { slug: 'c', display_name: 'C', supported_reasoning_levels: [] }
    ])
    expect(parseCodexModelsCache(text)).toEqual([
      { id: 'a', label: 'A', efforts: ['low', 'max'] },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' }
    ])
  })

  it('дефолтная модель из кэша помечается, не из кэша — добавляется первой', () => {
    const text = cache([{ slug: 'a', display_name: 'A' }, { slug: 'b', display_name: 'B' }])
    expect(parseCodexModelsCache(text, 'b').map((m) => m.label)).toEqual(['A', 'B (по умолчанию)'])
    expect(parseCodexModelsCache(text, 'z')).toEqual([
      { id: 'z', label: 'z (по умолчанию)' },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ])
  })

  it('скрытые модели пропускаются, кроме дефолтной', () => {
    const text = cache([{ slug: 'a', display_name: 'A', visibility: 'hide' }, { slug: 'b', display_name: 'B', visibility: 'hide' }])
    expect(parseCodexModelsCache(text, 'b')).toEqual([{ id: 'b', label: 'B (по умолчанию)' }])
  })
})

describe('effortOptionsFor / modelLabel', () => {
  const info: AgentInfo = {
    id: 'codex', title: 'Codex', installed: true, enabled: true, defaults: {},
    models: [{ id: 'a', label: 'A', efforts: ['low', 'xhigh'] }, { id: 'b', label: 'B' }]
  }

  it('efforts модели, иначе общий список агента', () => {
    expect(effortOptionsFor(info, 'a')).toEqual(['low', 'xhigh'])
    expect(effortOptionsFor(info, 'b')).toEqual(['low', 'medium', 'high'])
    expect(effortOptionsFor(info)).toEqual(['low', 'medium', 'high'])
  })

  it('label по id, неизвестный — сам id', () => {
    expect(modelLabel(info, 'a')).toBe('A')
    expect(modelLabel(info, 'zzz')).toBe('zzz')
    expect(modelLabel(undefined, 'zzz')).toBe('zzz')
    expect(modelLabel(info, undefined)).toBeUndefined()
  })
})
