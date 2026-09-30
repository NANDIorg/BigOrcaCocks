import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIGHTBOX_CLASS, lightboxOpen, viewerItems, viewerKeyAction } from './imageViewer'

const items = [
  { key: 'a', url: 'blob:a' },
  { key: 'b' },
  { key: 'c', url: 'blob:c' },
  { key: 'd', url: 'blob:d', failed: true }
]

test('viewerItems: в просмотр идут только загруженные, индекс — среди них', () => {
  assert.deepEqual(viewerItems(items, 'c'), { urls: ['blob:a', 'blob:c'], keys: ['a', 'c'], index: 1 })
  assert.equal(viewerItems(items, 'a')?.index, 0)
})

test('viewerItems: нет ключа, картинка не загрузилась или упала, пустой список — null', () => {
  assert.equal(viewerItems(items, null), null)
  assert.equal(viewerItems(items, 'x'), null)
  assert.equal(viewerItems(items, 'b'), null)
  assert.equal(viewerItems(items, 'd'), null)
  assert.equal(viewerItems([], 'a'), null)
})

test('viewerKeyAction: Esc закрывает, стрелки листают', () => {
  assert.deepEqual(viewerKeyAction('Escape', 0, 2), { kind: 'close' })
  assert.deepEqual(viewerKeyAction('ArrowLeft', 1, 2), { kind: 'go', index: 0 })
  assert.deepEqual(viewerKeyAction('ArrowRight', 1, 2), { kind: 'go', index: 2 })
})

test('viewerKeyAction: стрелка на краю и чужие клавиши поглощаются, Tab проходит', () => {
  assert.deepEqual(viewerKeyAction('ArrowLeft', 0, 2), { kind: 'swallow' })
  assert.deepEqual(viewerKeyAction('ArrowRight', 2, 2), { kind: 'swallow' })
  for (const k of ['1', 'g', 'G', 'm', 'Enter', ' ', 'ArrowUp']) assert.deepEqual(viewerKeyAction(k, 0, 0), { kind: 'swallow' }, k)
  assert.deepEqual(viewerKeyAction('Tab', 0, 0), { kind: 'pass' })
})

test('lightboxOpen ищет корень оверлея по его классу', () => {
  const seen: string[] = []
  const root = (found: boolean) => ({ querySelector: (s: string) => (seen.push(s), found ? {} : null) })
  assert.equal(lightboxOpen(root(true)), true)
  assert.equal(lightboxOpen(root(false)), false)
  assert.deepEqual(seen, [`.${LIGHTBOX_CLASS}`, `.${LIGHTBOX_CLASS}`])
})
