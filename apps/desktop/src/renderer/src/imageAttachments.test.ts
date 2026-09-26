import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMAGE_ATTACHMENT_LIMITS } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import {
  attachmentsSupport,
  checkFileMeta,
  checkImageData,
  dragHasFiles,
  imageFilesFromClipboard,
  imageFilesFromDrop,
  imagesPayload,
  staleAttachmentsMessage,
  type AttachedImage
} from './imageAttachments'
import { setLocale } from './i18n'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const TEXT = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])
const { maxCount, maxBytes, maxTotalBytes } = IMAGE_ATTACHMENT_LIMITS

const file = (name: string, type: string, bytes = 4): File => new File([new Uint8Array(bytes)], name, { type })
const sized = (byteLength: number): { data: { byteLength: number } } => ({ data: { byteLength } })

function inEnglish(fn: () => void): void {
  setLocale('en')
  try {
    fn()
  } finally {
    setLocale('ru')
  }
}

test('imageFilesFromClipboard: берёт только файлы-картинки; текст и нефайлы — пусто', () => {
  const png = file('a.png', 'image/png')
  const items = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => png },
    { kind: 'file', type: 'application/pdf', getAsFile: () => file('a.pdf', 'application/pdf') },
    { kind: 'file', type: 'image/gif', getAsFile: () => null }
  ]
  assert.deepEqual(imageFilesFromClipboard(items), [png])
  assert.deepEqual(imageFilesFromClipboard([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]), [])
  assert.deepEqual(imageFilesFromClipboard([]), [])
})

test('imageFilesFromDrop / dragHasFiles: все файлы перетаскивания; выделенный текст — не файлы', () => {
  const a = file('a.png', 'image/png')
  const b = file('b.txt', 'text/plain')
  assert.deepEqual(imageFilesFromDrop([a, b]), [a, b])
  assert.deepEqual(imageFilesFromDrop(null), [])
  assert.deepEqual(imageFilesFromDrop(undefined), [])
  assert.equal(dragHasFiles(['text/plain', 'Files']), true)
  assert.equal(dragHasFiles(['text/plain']), false)
  assert.equal(dragHasFiles(null), false)
})

test('checkFileMeta: PNG/JPEG/GIF/WebP до лимита проходят; чужой формат и большой файл — ошибка', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.doesNotThrow(() => checkFileMeta({ type, size: maxBytes }), type)
  }
  assert.throws(() => checkFileMeta({ type: 'image/svg+xml', size: 10 }), /формат image\/svg\+xml не поддерживается/)
  assert.throws(() => checkFileMeta({ type: '', size: 10 }), /формат — не поддерживается/)
  assert.throws(() => checkFileMeta({ type: 'image/png', size: maxBytes + 1 }), /больше 10 МБ/)
})

test('checkImageData: тип по сигнатуре, а не по заявленному MIME', () => {
  assert.equal(checkImageData(PNG, []), 'image/png')
  assert.throws(() => checkImageData(TEXT, []), /не удалось распознать/)
})

test('checkImageData: не больше maxCount изображений и не больше maxTotalBytes вместе', () => {
  const eight = Array.from({ length: maxCount }, () => sized(1))
  assert.equal(checkImageData(PNG, eight.slice(0, maxCount - 1)), 'image/png')
  assert.throws(() => checkImageData(PNG, eight), /не больше 8 изображений/)
  assert.throws(() => checkImageData(PNG, [sized(maxTotalBytes - PNG.byteLength + 1)]), /вместе больше 30 МБ/)
  assert.doesNotThrow(() => checkImageData(PNG, [sized(maxTotalBytes - PNG.byteLength)]))
})

test('ошибки лимитов — на языке интерфейса', () => {
  inEnglish(() => {
    assert.throws(() => checkFileMeta({ type: 'image/bmp', size: 1 }), /image\/bmp is not supported/)
    assert.throws(() => checkFileMeta({ type: 'image/png', size: maxBytes + 1 }), /larger than 10 MB/)
    assert.throws(() => checkImageData(TEXT, []), /could not recognize/)
    assert.equal(staleAttachmentsMessage(), 'The app is running an old main/preload version without images for feedback. Restart the app.')
  })
})

test('imagesPayload: в IPC уходят только mime и байты; пусто — undefined', () => {
  const img: AttachedImage = { id: 3, url: 'blob:x', mime: 'image/png', data: PNG }
  assert.deepEqual(imagesPayload([img]), [{ mime: 'image/png', data: PNG }])
  assert.deepEqual(Object.keys(imagesPayload([img])![0]).sort(), ['data', 'mime'])
  assert.equal(imagesPayload([]), undefined)
})

test('attachmentsSupport: рукопожатие с main', async () => {
  const api = (ping: unknown): Partial<OrcaApi> => ({ attachments: { ping } } as unknown as Partial<OrcaApi>)
  assert.equal(await attachmentsSupport(api(async () => true)), 'ok')
  assert.equal(await attachmentsSupport(undefined), 'stale')
  assert.equal(await attachmentsSupport({}), 'stale') // старый preload: нет метода
  assert.equal(await attachmentsSupport(api('не функция')), 'stale')
  assert.equal(await attachmentsSupport(api(async () => false)), 'stale')
  // Новый preload, старый main: invoke падает.
  const noHandler = async (): Promise<true> => {
    throw new Error("Error invoking remote method 'attachments:ping': Error: No handler registered for 'attachments:ping'")
  }
  assert.equal(await attachmentsSupport(api(noHandler)), 'stale')
})
