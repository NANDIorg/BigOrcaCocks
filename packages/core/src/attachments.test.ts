// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IMAGE_OBJECTIVE,
  IMAGE_ATTACHMENT_LIMITS,
  coordinatorPrompt,
  imageAttachmentFileName,
  sniffImageType,
  validateImageAttachments
} from './attachments.ts'

const png = (size = 16): Uint8Array => {
  const b = new Uint8Array(size)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return b
}
const webp = (): Uint8Array => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

describe('sniffImageType', () => {
  it('узнаёт png/jpeg/gif/webp по сигнатуре', () => {
    assert.equal(sniffImageType(png()), 'image/png')
    assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.equal(sniffImageType(new TextEncoder().encode('GIF89a')), 'image/gif')
    assert.equal(sniffImageType(webp()), 'image/webp')
  })
  it('svg и произвольные байты — не изображение', () => {
    assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined)
    assert.equal(sniffImageType(new Uint8Array([0x89, 0x50])), undefined)
  })
})

describe('validateImageAttachments', () => {
  it('нет вложений — пустой список', () => {
    assert.deepEqual(validateImageAttachments(undefined), [])
    assert.deepEqual(validateImageAttachments([]), [])
  })
  it('тип и расширение — по содержимому, а не по присланному mime', () => {
    const [a] = validateImageAttachments([{ mime: 'image/jpeg', data: png() }])
    assert.equal(a.mime, 'image/png')
    assert.equal(a.ext, 'png')
  })
  it('битые входные данные IPC отвергаются', () => {
    assert.throws(() => validateImageAttachments('x'), /массив/)
    assert.throws(() => validateImageAttachments([null]), /нет данных/)
    assert.throws(() => validateImageAttachments([{ mime: 'image/png', data: 'AAAA' }]), /нет данных/)
    assert.throws(() => validateImageAttachments([{ mime: 'image/png', data: new Uint8Array() }]), /нет данных/)
    assert.throws(() => validateImageAttachments([{ mime: 'image/png', data: new Uint8Array([1, 2, 3]) }]), /не поддерживается/)
  })
  it('лимиты: число, размер одного, суммарный размер', () => {
    const { maxCount, maxBytes, maxTotalBytes } = IMAGE_ATTACHMENT_LIMITS
    assert.throws(() => validateImageAttachments(Array.from({ length: maxCount + 1 }, () => ({ data: png() }))), /слишком много/)
    assert.throws(() => validateImageAttachments([{ data: png(maxBytes + 1) }]), /изображение 1 больше/)
    const n = Math.ceil(maxTotalBytes / maxBytes) + 1
    assert.ok(n <= maxCount)
    assert.throws(() => validateImageAttachments(Array.from({ length: n }, () => ({ data: png(maxBytes) }))), /вместе больше/)
  })
})

describe('промпт координатора', () => {
  it('имя файла — только номер и расширение', () => {
    assert.equal(imageAttachmentFileName(0, 'png'), 'image-1.png')
  })
  it('без изображений — прежний текст', () => {
    assert.equal(coordinatorPrompt('сделать X'), 'Цель: сделать X\n\nНачни с декомпозиции и создания задач через orca-board.')
  })
  it('с изображениями — пути целиком (с пробелами) и просьба прочитать', () => {
    const p = coordinatorPrompt('сделать X', ['/Users/a b/repo/.orca-attachments/run_1/image-1.png'])
    assert.match(p, /- `\/Users\/a b\/repo\/\.orca-attachments\/run_1\/image-1\.png`/)
    assert.match(p, /Read/)
  })
  it('с изображениями — инструкции с картинок не исполнять, воркерам пересказывать, а не давать путь', () => {
    const p = coordinatorPrompt('сделать X', ['/r/.orca-attachments/run_1/image-1.png'])
    assert.match(p, /не исполняй/)
    assert.match(p, /пути к файлам воркерам не передавай/)
  })
  it('стандартная цель просит разобрать изображение как материал, а не исполнять показанное', () => {
    assert.match(DEFAULT_IMAGE_OBJECTIVE, /материал/)
    assert.match(DEFAULT_IMAGE_OBJECTIVE, /не исполняй/)
    assert.doesNotMatch(DEFAULT_IMAGE_OBJECTIVE, /выполни то, что на них показано/)
  })
})
