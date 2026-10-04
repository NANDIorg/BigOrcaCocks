import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTACHMENT_LIMITS, IMAGE_ATTACHMENT_LIMITS } from '@orca-board/core'
import type { OrcaApi } from '../shared/ipc'
import {
  acceptFor,
  addUsage,
  attachmentsPayload,
  attachmentsSupport,
  checkAttachmentData,
  checkFileMeta,
  dragHasFiles,
  filesFromClipboard,
  filesFromDrop,
  folderError,
  limitsFor,
  modeFor,
  pasteKeys,
  probeAttachments,
  resetAttachmentsProbe,
  staleAttachmentsMessage,
  readFileBytes,
  usageOf,
  type ClipboardItemLike,
  type DraftAttachment,
  type DropItemLike
} from './attachmentDrafts'
import { setLocale, t } from './i18n'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const TEXT = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])
const MB = 1024 * 1024

const file = (name: string, type = '', bytes = 4): File => new File([new Uint8Array(bytes)], name, { type })
const fileItem = (f: File | null, type = f?.type ?? ''): ClipboardItemLike => ({ kind: 'file', type, getAsFile: () => f })
const textItem: ClipboardItemLike = { kind: 'string', type: 'text/plain', getAsFile: () => null }
const clip = (items: ClipboardItemLike[], text = '') => ({ items, getData: (f: string) => (f === 'text/plain' ? text : '') })
const none = { count: 0, bytes: 0 }

function inEnglish(fn: () => void): void {
  setLocale('en')
  try {
    fn()
  } finally {
    setLocale('ru')
  }
}

// ---------- Буфер ----------

test('filesFromClipboard: берёт любой файл, не только картинку; текста нет — стандартную вставку гасим', () => {
  const pdf = file('spec.pdf', 'application/pdf')
  const png = file('a.png', 'image/png')
  const r = filesFromClipboard(clip([fileItem(pdf), fileItem(png), fileItem(null, 'image/gif')]))
  assert.deepEqual(r.files, [pdf, png])
  assert.equal(r.suppressText, true)
})

test('filesFromClipboard: файл из Finder с именем текстом — имя в поле не вставляется', () => {
  const log = file('error.log')
  assert.equal(filesFromClipboard(clip([textItem, fileItem(log)], 'error.log')).suppressText, true)
  // Два файла: имена построчно, с путём (Проводник) или без.
  const a = file('a.txt')
  const b = file('b.md')
  assert.equal(filesFromClipboard(clip([fileItem(a), fileItem(b)], 'C:\\Users\\me\\a.txt\r\n/Users/me/b.md\n')).suppressText, true)
})

test('filesFromClipboard: картинка с обычным текстом — текст вставляется как раньше', () => {
  const png = file('image.png', 'image/png')
  const r = filesFromClipboard(clip([textItem, fileItem(png)], 'подпись к скриншоту'))
  assert.deepEqual(r.files, [png])
  assert.equal(r.suppressText, false)
})

test('filesFromClipboard: пустой буфер и только текст — файлов нет, вставка стандартная', () => {
  assert.deepEqual(filesFromClipboard(clip([])), { files: [], folders: [], suppressText: false })
  assert.deepEqual(filesFromClipboard(clip([textItem], 'текст')), { files: [], folders: [], suppressText: false })
})

// Папка из Finder при ⌘V приходит в Electron так же, как при drop: файловый элемент без типа, `webkitGetAsEntry`
// с `isDirectory: true`, а чтение падает NotFoundError (проверено в Electron из devDependencies).
const folderItem = (name: string): ClipboardItemLike => ({
  kind: 'file',
  type: '',
  getAsFile: () => file(name, '', 128),
  webkitGetAsEntry: () => ({ isDirectory: true, name })
})

test('filesFromClipboard: папка — в отказы по имени, как при перетаскивании; текст-имя не вставляется', () => {
  const a = file('a.txt', 'text/plain')
  const pasteItem: ClipboardItemLike = { ...fileItem(a), webkitGetAsEntry: () => ({ isDirectory: false, name: 'a.txt' }) }
  assert.deepEqual(filesFromClipboard(clip([folderItem('logs')])), { files: [], folders: ['logs'], suppressText: true })
  assert.deepEqual(filesFromClipboard(clip([textItem, pasteItem, folderItem('logs')], 'a.txt\nlogs')), {
    files: [a],
    folders: ['logs'],
    suppressText: true
  })
  // Та же ошибка, что при перетаскивании той же папки.
  const dropped = filesFromDrop({ items: [{ kind: 'file', getAsFile: () => file('logs'), webkitGetAsEntry: () => ({ isDirectory: true, name: 'logs' }) }] })
  assert.deepEqual(filesFromClipboard(clip([folderItem('logs')])).folders, dropped.folders)
  assert.equal(folderError('logs'), `logs: ${t('common.attach.errFolder')}`)
  inEnglish(() => assert.equal(folderError('logs'), 'logs: folders are not supported — zip it or attach the files'))
})

// ---------- Перетаскивание ----------

const dropItem = (f: File | null, dir = false): DropItemLike => ({
  kind: 'file',
  getAsFile: () => f,
  webkitGetAsEntry: () => ({ isDirectory: dir, name: dir ? 'logs' : f?.name ?? '' })
})

test('filesFromDrop: файлы — берутся все, в порядке перетаскивания', () => {
  const a = file('a.png', 'image/png')
  const b = file('b.zip', 'application/zip')
  assert.deepEqual(filesFromDrop({ items: [dropItem(a), dropItem(b)] }), { files: [a, b], folders: [] })
})

test('filesFromDrop: папка — в отказы по имени, а не в файлы', () => {
  const a = file('a.txt')
  const dir = file('logs')
  assert.deepEqual(filesFromDrop({ items: [dropItem(a), dropItem(dir, true)] }), { files: [a], folders: ['logs'] })
})

test('filesFromDrop: не-файлы (выделенный текст) пропускаются; без items — список files; пусто — пусто', () => {
  const a = file('a.txt')
  const str: DropItemLike = { kind: 'string', getAsFile: () => null }
  assert.deepEqual(filesFromDrop({ items: [str, dropItem(a)] }), { files: [a], folders: [] })
  assert.deepEqual(filesFromDrop({ items: [str] }), { files: [], folders: [] })
  // Выбор файла (`input.files`) и среда без `webkitGetAsEntry`.
  assert.deepEqual(filesFromDrop({ files: [a] }), { files: [a], folders: [] })
  assert.deepEqual(filesFromDrop({ items: [{ kind: 'file', getAsFile: () => a }] }), { files: [a], folders: [] })
  assert.deepEqual(filesFromDrop(null), { files: [], folders: [] })
  assert.equal(dragHasFiles(['text/plain', 'Files']), true)
  assert.equal(dragHasFiles(['text/plain']), false)
  assert.equal(dragHasFiles(undefined), false)
})

// ---------- Проверки ----------

test('checkFileMeta: любой тип до 25 МБ; пустой и больший — ошибка с именем файла', () => {
  assert.doesNotThrow(() => checkFileMeta({ name: 'dump.bin', type: '', size: ATTACHMENT_LIMITS.maxBytes }))
  assert.doesNotThrow(() => checkFileMeta({ name: 'run.sh', type: 'application/x-sh', size: 10 }))
  assert.throws(() => checkFileMeta({ name: 'report.pdf', type: 'application/pdf', size: ATTACHMENT_LIMITS.maxBytes + 1 }), {
    message: 'report.pdf: больше 25 МБ'
  })
  assert.throws(() => checkFileMeta({ name: 'empty.txt', type: 'text/plain', size: 0 }), { message: 'empty.txt: пустой файл' })
  // Имя — как в UI: без пути и управляющих символов; нет имени — «без имени».
  assert.throws(() => checkFileMeta({ name: '../x/a\u202Etxt.exe', type: '', size: 0 }), { message: 'atxt.exe: пустой файл' })
  assert.throws(() => checkFileMeta({ type: '', size: 0 }), { message: 'без имени: пустой файл' })
})

test('checkFileMeta: режим картинок (старый main) — только PNG/JPEG/GIF/WebP и прежние 10 МБ', () => {
  assert.doesNotThrow(() => checkFileMeta({ name: 'a.png', type: 'image/png', size: IMAGE_ATTACHMENT_LIMITS.maxBytes }, 'images'))
  assert.throws(() => checkFileMeta({ name: 'a.pdf', type: 'application/pdf', size: 10 }, 'images'), /a\.pdf: .*после перезапуска/)
  assert.throws(() => checkFileMeta({ name: 'a.png', type: 'image/png', size: IMAGE_ATTACHMENT_LIMITS.maxBytes + 1 }, 'images'), /больше 10 МБ/)
})

test('checkAttachmentData: вид — по сигнатуре, а не по заявленному MIME', () => {
  assert.deepEqual(checkAttachmentData(PNG, { name: 'a.png', type: 'image/png' }, none), { kind: 'image', mime: 'image/png' })
  // MIME-подделка: «image/png» с текстом внутри — файл; MIME для показа — как прислан (main всё равно перепроверит).
  assert.deepEqual(checkAttachmentData(TEXT, { name: 'x.png', type: 'image/png' }, none).kind, 'file')
  assert.deepEqual(checkAttachmentData(TEXT, { name: 'a.log', type: '' }, none), { kind: 'file', mime: 'application/octet-stream' })
  assert.deepEqual(checkAttachmentData(TEXT, { name: 'a.pdf', type: 'application/pdf' }, none), { kind: 'file', mime: 'application/pdf' })
  assert.throws(() => checkAttachmentData(TEXT, { name: 'a.pdf' }, none, 'images'), /a\.pdf: .*после перезапуска/)
  assert.throws(() => checkAttachmentData(new Uint8Array(0), { name: 'e' }, none), { message: 'e: пустой файл' })
})

test('checkAttachmentData: счётчик и сумма считаются вместе с сохранёнными у задачи', () => {
  const { maxCount, maxTotalBytes } = ATTACHMENT_LIMITS
  assert.doesNotThrow(() => checkAttachmentData(TEXT, { name: 'a' }, { count: maxCount - 1, bytes: 0 }))
  assert.throws(() => checkAttachmentData(TEXT, { name: 'a.txt' }, { count: maxCount, bytes: 0 }), { message: 'a.txt: можно приложить не больше 8 файлов' })
  const saved = usageOf([{ bytes: 20 * MB }, { bytes: 20 * MB }])
  const drafts = usageOf([{ bytes: 10 * MB - TEXT.byteLength }])
  assert.doesNotThrow(() => checkAttachmentData(TEXT, { name: 'a' }, addUsage(saved, drafts)))
  assert.throws(() => checkAttachmentData(TEXT, { name: 'big.log' }, addUsage(saved, usageOf([{ bytes: 10 * MB }]))), {
    message: 'big.log: вложения вместе больше 50 МБ'
  })
  assert.equal(maxTotalBytes, 50 * MB)
})

test('usageOf / addUsage: сумма сохранённых и добавленных', () => {
  const saved = usageOf([{ bytes: 10 }, { bytes: 5 }])
  assert.deepEqual(saved, { count: 2, bytes: 15 })
  assert.deepEqual(addUsage(saved, { count: 1, bytes: 7 }), { count: 3, bytes: 22 })
  assert.deepEqual(usageOf([]), none)
})

test('ошибки — на языке интерфейса', () => {
  inEnglish(() => {
    assert.throws(() => checkFileMeta({ name: 'r.pdf', type: '', size: ATTACHMENT_LIMITS.maxBytes + 1 }), { message: 'r.pdf: larger than 25 MB' })
    assert.throws(() => checkFileMeta({ name: 'r.pdf', type: '', size: 1 }, 'images'), /r\.pdf: only an image .* after restarting the app$/)
    assert.throws(() => checkAttachmentData(TEXT, {}, { count: 8, bytes: 0 }), { message: 'unnamed: at most 8 files can be attached' })
    assert.equal(staleAttachmentsMessage(), 'The app is running an old main/preload version without attachments for feedback. Restart the app.')
  })
})

test('limitsFor / acceptFor / modeFor / pasteKeys', () => {
  assert.equal(limitsFor('files'), ATTACHMENT_LIMITS)
  assert.equal(limitsFor('images'), IMAGE_ATTACHMENT_LIMITS)
  assert.equal(acceptFor('files'), undefined)
  assert.equal(acceptFor('images'), 'image/png,image/jpeg,image/gif,image/webp')
  assert.equal(modeFor('ok'), 'files')
  for (const s of ['checking', 'imagesOnly', 'stale'] as const) assert.equal(modeFor(s), 'images')
  assert.equal(pasteKeys('MacIntel'), '⌘V')
  assert.equal(pasteKeys('Win32'), 'Ctrl+V')
})

test('attachmentsPayload: в IPC уходят mime, байты и имя; без имени — без поля; пусто — undefined', () => {
  const img: DraftAttachment = { id: 1, kind: 'image', url: 'blob:x', mime: 'image/png', name: '', data: PNG }
  const doc: DraftAttachment = { id: 2, kind: 'file', mime: 'application/pdf', name: 'spec.pdf', data: TEXT }
  assert.deepEqual(attachmentsPayload([img, doc]), [
    { mime: 'image/png', data: PNG },
    { mime: 'application/pdf', data: TEXT, name: 'spec.pdf' }
  ])
  assert.equal(attachmentsPayload([]), undefined)
})

// ---------- Рукопожатие ----------

type Attachments = Partial<OrcaApi['attachments']>
const api = (attachments: Record<string, unknown>): Partial<OrcaApi> => ({ attachments: attachments as Attachments } as Partial<OrcaApi>)
const limits = { ...ATTACHMENT_LIMITS }
const noHandler = (channel: string) => async (): Promise<never> => {
  throw new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`)
}

test('attachmentsSupport: ok — main принимает файлы', async () => {
  assert.equal(await attachmentsSupport(api({ capabilities: async () => ({ files: true, limits }), ping: async () => true })), 'ok')
})

test('attachmentsSupport: imagesOnly — main отвечает files:false или знает только ping', async () => {
  assert.equal(await attachmentsSupport(api({ capabilities: async () => ({ files: false, limits }), ping: async () => true })), 'imagesOnly')
  // Старый preload: capabilities ещё нет.
  assert.equal(await attachmentsSupport(api({ ping: async () => true })), 'imagesOnly')
  // Новый preload, main без capabilities.
  assert.equal(await attachmentsSupport(api({ capabilities: noHandler('attachments:capabilities'), ping: async () => true })), 'imagesOnly')
})

test('attachmentsSupport: stale — вложений нет совсем', async () => {
  assert.equal(await attachmentsSupport(undefined), 'stale')
  assert.equal(await attachmentsSupport({}), 'stale')
  assert.equal(await attachmentsSupport(api({ ping: 'не функция' })), 'stale')
  assert.equal(await attachmentsSupport(api({ ping: async () => false })), 'stale')
  assert.equal(
    await attachmentsSupport(api({ capabilities: noHandler('attachments:capabilities'), ping: noHandler('attachments:ping') })),
    'stale'
  )
})

test('probeAttachments: main спрашивается один раз до перезапуска', async () => {
  resetAttachmentsProbe()
  let calls = 0
  const a = api({ capabilities: async () => { calls++; return { files: true, limits } } })
  assert.equal(await probeAttachments(a), 'ok')
  assert.equal(await probeAttachments(api({})), 'ok') // кеш: второй api не опрашивается
  assert.equal(calls, 1)
  resetAttachmentsProbe()
  assert.equal(await probeAttachments(api({})), 'stale')
  resetAttachmentsProbe()
})

test('readFileBytes: байты файла; ошибка чтения (папка, пропавший файл) — понятная, с именем', async () => {
  const ok = await readFileBytes({ name: 'a.txt', arrayBuffer: async () => new TextEncoder().encode('hi').buffer })
  assert.deepEqual([...ok], [104, 105])
  await assert.rejects(
    readFileBytes({ name: 'dir', arrayBuffer: async () => { throw new Error('A requested file or directory could not be found') } }),
    { message: `dir: ${t('common.attach.errRead')}` }
  )
})
