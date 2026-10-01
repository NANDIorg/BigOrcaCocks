// Запуск: pnpm --filter @orca-board/desktop test. Картинки глобальной задачи на диске: настоящий TaskStore и
// временная папка вместо userData (electron не нужен).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, ATTACHMENT_LIMITS, validateAttachments, type RunImage } from '@orca-board/core'
import {
  runImagesRoot, runImagesDir, runImageFile, createTaskWithImages, addTaskImages, removeTaskImage, loadTaskImage,
  removeRunImagesDir, coordinatorImages, readRunImages, revealTaskAttachment
} from './run-images'
import { OrcaError } from './i18n'
import { writeAttachments } from './attachments'

const png = (size = 16, fill = 0): Uint8Array => {
  const b = new Uint8Array(size).fill(fill)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return b
}
const valid = (...sizes: number[]) => validateAttachments(sizes.map((s, i) => ({ mime: 'image/png', data: png(s, i + 1) })))
/** Файл не-картинка с исходным именем (`File.name`). */
const doc = (name: string, text = 'текст файла') => validateAttachments([{ mime: 'application/pdf', name, data: new TextEncoder().encode(text) }])

let userData: string
let root: string
let store: TaskStore
const PROJECT = 'proj_1'

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-run-images-'))
  root = runImagesRoot(userData)
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
})
afterEach(() => rmSync(userData, { recursive: true, force: true }))

const filesOf = (runId: string): string[] => {
  const dir = runImagesDir(root, PROJECT, runId)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

describe('пути картинок', () => {
  it('корень — userData/run-images, вне worktree', () => {
    assert.equal(root, join(userData, 'run-images'))
    assert.equal(runImagesDir(root, PROJECT, 'run_a'), join(root, PROJECT, 'run_a'))
  })

  it('идентификаторы с разделителями пути отвергаются', () => {
    assert.throws(() => runImagesDir(root, PROJECT, '../x'), /недопустимый идентификатор/)
    assert.throws(() => runImagesDir(root, '..', 'run_a'), /недопустимый идентификатор/)
    assert.throws(() => runImageFile(root, { id: '../evil', mime: 'image/png', ext: 'png', bytes: 1, addedAt: 1 }), /недопустимый идентификатор/)
  })

  it('расширение — только из белого списка', () => {
    assert.throws(() => runImageFile(root, { id: 'img_1', mime: 'image/png', ext: '../png', bytes: 1, addedAt: 1 }), /недопустимое расширение/)
  })
})

describe('создание задачи с картинками', () => {
  it('файлы на диске, метаданные в задаче, байты не в store', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(20, 30))
    assert.equal(g.images?.length, 2)
    assert.deepEqual(g.images!.map((i) => i.bytes), [20, 30])
    assert.equal(filesOf(g.id).length, 2)
    assert.ok(!JSON.stringify(store.snapshot()).includes('data'))
    const loaded = loadTaskImage(store, root, PROJECT, g.id, g.images![1].id)
    assert.equal(loaded.mime, 'image/png')
    assert.equal(loaded.data.byteLength, 30)
  })

  it('без картинок — обычная задача, папка не создаётся', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, [])
    assert.equal(g.images, undefined)
    assert.deepEqual(filesOf(g.id), [])
  })

  it('отказ store (нет названия) — ничего на диск не пишется', () => {
    assert.throws(() => createTaskWithImages(store, root, PROJECT, {}, valid(20)), /название или описание/)
    assert.equal(store.listGlobalTasks().length, 0)
    assert.equal(existsSync(root), false)
  })

  it('сбой записи файлов — задача не остаётся', () => {
    // Вместо папки проекта лежит файл: mkdir внутри неё упадёт.
    blockProjectDir(join(root, PROJECT))
    assert.throws(() => createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(20)), /не удалось сохранить вложения/)
    assert.equal(store.listGlobalTasks().length, 0)
  })
})

/** Вместо папки проекта кладёт файл: mkdir внутри неё падает. */
function blockProjectDir(path: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(path, 'x')
}

describe('addImages / removeImage', () => {
  it('добавление копится с уже сохранёнными, лимит суммарный, отказ файлов не пишет', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(...Array(ATTACHMENT_LIMITS.maxCount - 1).fill(16)))
    assert.throws(() => addTaskImages(store, root, PROJECT, g.id, valid(16, 16)), /не больше 8/)
    assert.equal(filesOf(g.id).length, ATTACHMENT_LIMITS.maxCount - 1)
    const after = addTaskImages(store, root, PROJECT, g.id, valid(16))
    assert.equal(after.images?.length, ATTACHMENT_LIMITS.maxCount)
    assert.equal(filesOf(g.id).length, ATTACHMENT_LIMITS.maxCount)
  })

  it('пустой список и неизвестная задача — OrcaError', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, [])
    assert.throws(() => addTaskImages(store, root, PROJECT, g.id, []), /нет вложений для добавления/)
    assert.throws(() => addTaskImages(store, root, PROJECT, 'run_нет', valid(16)), /run_нет/)
  })

  it('после начала работы картинки не меняются, файлы не трогаются', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(16))
    store.moveGlobalTask(g.id, 'in_progress')
    assert.throws(() => addTaskImages(store, root, PROJECT, g.id, valid(16)), /нельзя менять/)
    assert.throws(() => removeTaskImage(store, root, PROJECT, g.id, g.images![0].id), /нельзя менять/)
    assert.equal(filesOf(g.id).length, 1)
  })

  it('удаление: метаданные и файл; чужой imageId — ошибка', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(16, 17))
    const [a, b] = g.images!
    assert.throws(() => removeTaskImage(store, root, PROJECT, g.id, 'img_нет'), /img_нет/)
    const after = removeTaskImage(store, root, PROJECT, g.id, a.id)
    assert.deepEqual(after.images?.map((i) => i.id), [b.id])
    assert.equal(filesOf(g.id).length, 1)
    assert.equal(removeTaskImage(store, root, PROJECT, g.id, b.id).images, undefined)
    assert.deepEqual(filesOf(g.id), [])
  })
})

describe('image: чтение байтов', () => {
  it('imageId другой задачи и path traversal не читаются', () => {
    const a = createTaskWithImages(store, root, PROJECT, { title: 'A' }, valid(16))
    const b = createTaskWithImages(store, root, PROJECT, { title: 'B' }, valid(17))
    assert.throws(() => loadTaskImage(store, root, PROJECT, a.id, b.images![0].id), /нет вложения/)
    assert.throws(() => loadTaskImage(store, root, PROJECT, a.id, '../' + a.images![0].id), /нет вложения/)
    assert.throws(() => loadTaskImage(store, root, PROJECT, '../x', a.images![0].id), /../)
    assert.throws(() => loadTaskImage(store, root, PROJECT, a.id, 42 as unknown as string), /нет вложения/)
  })

  it('файл пропал с диска — понятная ошибка', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(16))
    rmSync(runImageFile(runImagesDir(root, PROJECT, g.id), g.images![0]))
    assert.throws(() => loadTaskImage(store, root, PROJECT, g.id, g.images![0].id), /не найден на диске/)
  })
})

describe('удаление задачи и проекта', () => {
  it('removeRunImagesDir: задача — только её папка, проект — все', () => {
    const a = createTaskWithImages(store, root, PROJECT, { title: 'A' }, valid(16))
    const b = createTaskWithImages(store, root, PROJECT, { title: 'B' }, valid(16))
    removeRunImagesDir(root, PROJECT, a.id)
    assert.deepEqual(filesOf(a.id), [])
    assert.equal(filesOf(b.id).length, 1)
    removeRunImagesDir(root, PROJECT)
    assert.equal(existsSync(join(root, PROJECT)), false)
  })

  it('нет папки — не ошибка', () => {
    removeRunImagesDir(root, PROJECT, 'run_none')
  })
})

describe('картинки для координатора', () => {
  it('сохранённые (по addedAt) первыми, вставленные следом', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(20, 30))
    const run = store.getRun(g.id)!
    const { images, missing } = coordinatorImages(root, PROJECT, run, validateAttachments([{ mime: 'image/png', data: png(40, 9) }]))
    assert.deepEqual(images.map((i) => i.data.byteLength), [20, 30, 40])
    assert.deepEqual(missing, [])
  })

  it('без сохранённых — только вставленные', () => {
    const run = store.getRun(createTaskWithImages(store, root, PROJECT, { title: 'G' }, []).id)!
    const pasted = valid(16)
    assert.equal(coordinatorImages(root, PROJECT, run, pasted).images.length, 1)
    assert.equal(coordinatorImages(root, PROJECT, run, []).images.length, 0)
  })

  it('сумма с вставленными выше лимита — ошибка запуска, а не потеря картинок', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(...Array(ATTACHMENT_LIMITS.maxCount).fill(16)))
    assert.throws(
      () => coordinatorImages(root, PROJECT, store.getRun(g.id)!, valid(16)),
      /сохранённые вложения задачи \(8\) и приложенные при запуске \(1\)/
    )
  })

  it('пропавший с диска файл пропускается и попадает в missing', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(20, 30))
    const dir = runImagesDir(root, PROJECT, g.id)
    rmSync(runImageFile(dir, g.images![0]))
    const res = readRunImages(dir, g.images!)
    assert.deepEqual(res.images.map((i) => i.data.byteLength), [30])
    assert.deepEqual(res.missing.map((m) => m.id), [g.images![0].id])
  })
})

describe('вложения-файлы задачи', () => {
  const meta = (over: Partial<RunImage>): RunImage => ({ id: 'img_1', kind: 'file', mime: 'application/pdf', ext: 'pdf', bytes: 1, addedAt: 1, ...over })

  it('runImageFile: файл — расширение [a-z0-9]{0,10} (пустое — без точки); ../x, длинное, не-[a-z0-9] и неизвестный kind отвергаются', () => {
    assert.equal(runImageFile(root, meta({})), join(root, 'img_1.pdf'))
    assert.equal(runImageFile(root, meta({ ext: '' })), join(root, 'img_1'))
    for (const ext of ['../x', 'a'.repeat(11), 'PDF', 'p.df', 'tar.gz', 'x/y', 'ж']) {
      assert.throws(() => runImageFile(root, meta({ ext })), /недопустимое расширение/, ext)
    }
    assert.throws(() => runImageFile(root, meta({ kind: 'zip' as RunImage['kind'] })), /недопустимое расширение/)
    // Картинка (и старая запись без kind) — по-прежнему только белый список.
    assert.throws(() => runImageFile(root, meta({ kind: 'image', ext: 'pdf' })), /недопустимое расширение/)
    assert.throws(() => runImageFile(root, meta({ kind: undefined, ext: '' })), /недопустимое расширение/)
    assert.throws(() => runImageFile(root, meta({ id: '../evil' })), /недопустимый идентификатор/)
  })

  it('создание и добавление: kind и исходное имя в метаданных, файл на диске под id, лимиты — ATTACHMENT_LIMITS', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, [...valid(16), ...doc('Спека v2.pdf')])
    assert.deepEqual(g.images!.map((i) => [i.kind, i.name ?? '', i.ext]), [['image', '', 'png'], ['file', 'Спека v2.pdf', 'pdf']])
    assert.deepEqual(filesOf(g.id), [`${g.images![0].id}.png`, `${g.images![1].id}.pdf`].sort())
    const big = validateAttachments([{ mime: 'text/plain', name: 'big.log', data: new Uint8Array(ATTACHMENT_LIMITS.maxBytes) }])
    addTaskImages(store, root, PROJECT, g.id, big)
    assert.throws(() => addTaskImages(store, root, PROJECT, g.id, big), /вместе были бы больше 50 МБ/)
    assert.equal(store.getGlobalTask(g.id).images!.length, 3)
  })

  it('loadTaskImage: для файла — global.notAnImage (байты в renderer не уходят); картинка — как раньше', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, [...doc('a.pdf'), ...valid(16)])
    assert.throws(() => loadTaskImage(store, root, PROJECT, g.id, g.images![0].id), (e) => e instanceof OrcaError && e.key === 'global.notAnImage')
    assert.equal(loadTaskImage(store, root, PROJECT, g.id, g.images![1].id).data.byteLength, 16)
  })

  it('revealTaskAttachment: путь файла из метаданных этой задачи; чужой imageId, path traversal и пропавший файл — ошибка', () => {
    const a = createTaskWithImages(store, root, PROJECT, { title: 'A' }, [...doc('a.pdf'), ...valid(16)])
    const b = createTaskWithImages(store, root, PROJECT, { title: 'B' }, doc('b.pdf'))
    const dir = runImagesDir(root, PROJECT, a.id)
    assert.equal(revealTaskAttachment(store, root, PROJECT, a.id, a.images![0].id), join(dir, `${a.images![0].id}.pdf`))
    assert.equal(revealTaskAttachment(store, root, PROJECT, a.id, a.images![1].id), join(dir, `${a.images![1].id}.png`))
    const isKey = (key: string) => (e: unknown) => e instanceof OrcaError && e.key === key
    assert.throws(() => revealTaskAttachment(store, root, PROJECT, a.id, b.images![0].id), isKey('global.imageNotFound'))
    assert.throws(() => revealTaskAttachment(store, root, PROJECT, a.id, '../' + a.images![0].id), isKey('global.imageNotFound'))
    assert.throws(() => revealTaskAttachment(store, root, PROJECT, '../x', a.images![0].id), isKey('global.notFound'))
    assert.throws(() => revealTaskAttachment(store, '/', '..', a.id, a.images![0].id), /недопустимый идентификатор/)
    rmSync(join(dir, `${a.images![0].id}.pdf`))
    assert.throws(() => revealTaskAttachment(store, root, PROJECT, a.id, a.images![0].id), isKey('global.imageFileMissing'))
  })

  it('запуск координатора: сохранённый файл переносит kind и имя → в папке координатора file-N-<slug>.ext; пропавший — в missing', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, [...valid(16), ...doc('План релиза.pdf', 'план'), ...doc('gone.pdf')])
    rmSync(runImageFile(runImagesDir(root, PROJECT, g.id), g.images![2]))
    const pasted = validateAttachments([{ mime: 'text/plain', name: 'notes.txt', data: new TextEncoder().encode('заметки') }])
    const { images, missing } = coordinatorImages(root, PROJECT, store.getRun(g.id)!, pasted)
    assert.deepEqual(images.map((i) => [i.kind, i.name]), [['image', ''], ['file', 'План релиза.pdf'], ['file', 'notes.txt']])
    assert.deepEqual(missing.map((m) => m.id), [g.images![2].id])
    const coord = join(userData, 'coord', '.orca-attachments')
    const paths = writeAttachments(coord, g.id, images)
    assert.deepEqual(paths.map((p) => basename(p)), ['image-1.png', 'file-2-Plan_reliza.pdf', 'file-3-notes.txt'])
    assert.equal(readFileSync(paths[1], 'utf8'), 'план')
  })

  it('старая запись без kind читается как картинка и уходит координатору как image-N', () => {
    const g = createTaskWithImages(store, root, PROJECT, { title: 'G' }, valid(16))
    const legacy = { ...g.images![0] }
    delete legacy.kind
    const { images } = readRunImages(runImagesDir(root, PROJECT, g.id), [legacy])
    assert.deepEqual(images.map((i) => [i.kind, i.ext]), [['image', 'png']])
  })
})
