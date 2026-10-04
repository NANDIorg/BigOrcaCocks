import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAppearance, mergeAppearance } from '../src/index.ts'

test('повреждённые настройки внешнего вида читаются с безопасными defaults', () => {
  assert.deepEqual(normalizeAppearance({ theme: 'removed', motion: 'bad', highSaturation: 'yes' }),
    { theme: 'graphite', motion: 'system', highSaturation: false })
})

test('частичный patch темы сохраняет движение и насыщенность', () => {
  const current = { theme: 'paper', motion: 'reduced', highSaturation: true } as const
  assert.deepEqual(mergeAppearance(current, { theme: 'forest' }),
    { theme: 'forest', motion: 'reduced', highSaturation: true })
})

test('неверный patch отклоняется целиком без изменения current', () => {
  const current = { theme: 'paper', motion: 'reduced', highSaturation: true } as const
  assert.throws(() => mergeAppearance(current, { theme: 'slate', highSaturation: 'yes' }))
  assert.deepEqual(current, { theme: 'paper', motion: 'reduced', highSaturation: true })
})
