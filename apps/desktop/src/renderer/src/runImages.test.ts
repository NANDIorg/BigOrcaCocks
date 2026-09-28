import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GlobalTask, RunImage } from '@orca-board/core'
import { canSaveGlobal, idsToRemove, imagesEditable, imagesLost, runImagesApi, staleImagesMessage } from './runImages'
import { setLocale } from './i18n'

const fresh = { inbox: false, progress: { total: 0, done: 0, byStatus: {}, byKind: {} } }
const img = (id: string): RunImage => ({ id, mime: 'image/png', ext: 'png', bytes: 1, addedAt: 1 })

test('imagesEditable: до начала работы — можно, дальше только просмотр', () => {
  assert.equal(imagesEditable(fresh, 'backlog'), true)
  assert.equal(imagesEditable(fresh, 'in_progress'), false)
  assert.equal(imagesEditable({ ...fresh, startedAt: 5 }, 'backlog'), false)
  assert.equal(imagesEditable({ ...fresh, coordinatorPtyId: 'p' }, 'backlog'), false)
  assert.equal(imagesEditable({ ...fresh, progress: { ...fresh.progress, total: 2 } }, 'backlog'), false)
  assert.equal(imagesEditable({ ...fresh, inbox: true }, 'backlog'), false)
})

test('runImagesApi: нет методов — «перезапустите приложение», а не падение', () => {
  assert.throws(() => runImagesApi(undefined), /Перезапустите/)
  assert.throws(() => runImagesApi({ globalTasks: {} }), /Перезапустите/)
  assert.throws(() => runImagesApi({ globalTasks: { addImages: async () => ({}) as GlobalTask } }), /Перезапустите/)
})

test('runImagesApi: методы вызываются с this и аргументами', async () => {
  const calls: string[] = []
  const gt = {
    async addImages(id: string) { calls.push(`add ${id}`); return {} as GlobalTask },
    async removeImage(id: string, imageId: string) { calls.push(`rm ${id} ${imageId}`); return {} as GlobalTask },
    async image() { return { mime: 'image/png', data: new Uint8Array(1) } }
  }
  const api = runImagesApi({ globalTasks: gt })
  await api.addImages('g1', [])
  await api.removeImage('g1', 'i1')
  assert.deepEqual(calls, ['add g1', 'rm g1 i1'])
})

test('runImagesApi: «No handler registered» от старого main — то же сообщение', async () => {
  const api = runImagesApi({
    globalTasks: {
      addImages: async () => { throw new Error("Error invoking remote method 'globalTasks:addImages': No handler registered for 'globalTasks:addImages'") },
      removeImage: async () => { throw new Error('другая ошибка') },
      image: async () => ({ mime: 'image/png', data: new Uint8Array(1) })
    }
  })
  await assert.rejects(api.addImages('g', []), { message: staleImagesMessage() })
  await assert.rejects(api.removeImage('g', 'i'), { message: 'другая ошибка' })
})

test('staleImagesMessage: на языке интерфейса', () => {
  setLocale('en')
  try {
    assert.match(staleImagesMessage(), /Restart the app/)
  } finally {
    setLocale('ru')
  }
})

test('imagesLost: старый main проглотил картинки при создании', () => {
  assert.equal(imagesLost({}, 0), false)
  assert.equal(imagesLost({}, 2), true)
  assert.equal(imagesLost({ images: [img('a')] }, 2), true)
  assert.equal(imagesLost({ images: [img('a'), img('b')] }, 2), false)
})

test('idsToRemove: уже удалённые прошлой попыткой пропускаются', () => {
  assert.deepEqual(idsToRemove(['a', 'b', 'x'], [img('a'), img('b'), img('c')]), ['a', 'b'])
  assert.deepEqual(idsToRemove(['a'], undefined), [])
})

test('canSaveGlobal: создание — название или описание; с названием описание может быть пустым', () => {
  const base = { busy: false, reading: 0, editing: false, title: '', description: '' }
  assert.equal(canSaveGlobal(base), false)
  assert.equal(canSaveGlobal({ ...base, title: ' Экспорт ' }), true)
  assert.equal(canSaveGlobal({ ...base, description: 'цель' }), true)
})

test('canSaveGlobal: правка требует название; busy и чтение файлов блокируют', () => {
  const base = { busy: false, reading: 0, editing: true, title: '', description: 'цель' }
  assert.equal(canSaveGlobal(base), false)
  assert.equal(canSaveGlobal({ ...base, title: 'Т' }), true)
  assert.equal(canSaveGlobal({ ...base, title: 'Т', busy: true }), false)
  assert.equal(canSaveGlobal({ ...base, title: 'Т', reading: 1 }), false)
})
