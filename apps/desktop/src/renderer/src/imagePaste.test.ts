import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMAGE_ATTACHMENT_LIMITS } from '@orca-board/core'
import {
  addUsage, checkImageData, checkImageFile, clipboardImageFiles, imageUsage, pasteKeys, type ClipboardItemLike
} from './imagePaste'

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const { maxCount, maxBytes, maxTotalBytes } = IMAGE_ATTACHMENT_LIMITS
const file = (name: string): File => ({ name }) as File

test('clipboardImageFiles: берёт только файлы-картинки', () => {
  const img = file('a.png')
  const items: ClipboardItemLike[] = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'application/pdf', getAsFile: () => file('a.pdf') },
    { kind: 'file', type: 'image/png', getAsFile: () => img },
    { kind: 'file', type: 'image/webp', getAsFile: () => null }
  ]
  assert.deepEqual(clipboardImageFiles(items), [img])
  assert.deepEqual(clipboardImageFiles([]), [])
})

test('checkImageFile: формат и размер одного файла', () => {
  assert.doesNotThrow(() => checkImageFile({ type: 'image/png', size: 100 }))
  assert.throws(() => checkImageFile({ type: 'image/bmp', size: 100 }), /image\/bmp.*не поддерживается/)
  assert.throws(() => checkImageFile({ type: 'image/png', size: maxBytes + 1 }), /больше 10 МБ/)
})

test('checkImageData: тип по сигнатуре, а не по заявленному MIME', () => {
  assert.equal(checkImageData(png, { count: 0, bytes: 0 }), 'image/png')
  assert.throws(() => checkImageData(Uint8Array.from([1, 2, 3]), { count: 0, bytes: 0 }), /не удалось распознать/)
})

test('checkImageData: лимиты считаются с уже приложенным', () => {
  assert.throws(() => checkImageData(png, { count: maxCount, bytes: 0 }), /не больше 8/)
  assert.doesNotThrow(() => checkImageData(png, { count: maxCount - 1, bytes: 0 }))
  assert.throws(() => checkImageData(png, { count: 1, bytes: maxTotalBytes - png.byteLength + 1 }), /вместе больше 30 МБ/)
  assert.doesNotThrow(() => checkImageData(png, { count: 1, bytes: maxTotalBytes - png.byteLength }))
})

test('imageUsage и addUsage: сумма сохранённых и вставленных', () => {
  const saved = imageUsage([{ bytes: 10 }, { bytes: 5 }])
  assert.deepEqual(saved, { count: 2, bytes: 15 })
  assert.deepEqual(addUsage(saved, { count: 1, bytes: 7 }), { count: 3, bytes: 22 })
  assert.deepEqual(imageUsage([]), { count: 0, bytes: 0 })
})

test('pasteKeys: ⌘V на macOS, Ctrl+V на остальных', () => {
  assert.equal(pasteKeys('MacIntel'), '⌘V')
  assert.equal(pasteKeys('Win32'), 'Ctrl+V')
  assert.equal(pasteKeys('Linux x86_64'), 'Ctrl+V')
})
