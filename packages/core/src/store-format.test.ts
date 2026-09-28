// Запуск: node --test (type stripping Node ≥ 22.6). formatVersion снапшота: миграция старых файлов и отказ от будущих.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, STORE_FORMAT_VERSION, assertStoreFormat, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS } from './types.ts'

function memory(initial?: Partial<StoreSnapshot>): Persistence & { data: Partial<StoreSnapshot> | null; saves: number } {
  const p = {
    data: initial ? (JSON.parse(JSON.stringify(initial)) as Partial<StoreSnapshot>) : null,
    saves: 0,
    load: () => p.data,
    save: (s: StoreSnapshot) => { p.saves += 1; p.data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
  return p
}

const store = (p?: Persistence) => new TaskStore(p, () => DEFAULT_COLUMNS)

describe('formatVersion снапшота', () => {
  it('snapshot() пишет текущую версию формата', () => {
    assert.equal(store().snapshot().formatVersion, STORE_FORMAT_VERSION)
  })

  it('старый файл без formatVersion мигрирует при загрузке и сразу сохраняется', () => {
    const p = memory({ tasks: [], dispatches: [], events: [], questions: [], runs: [], requests: [] })
    store(p)
    assert.equal(p.data?.formatVersion, STORE_FORMAT_VERSION)
    assert.equal(p.saves, 1)
  })

  it('файл текущей версии при загрузке не переписывается', () => {
    const p = memory(store().snapshot())
    store(p)
    assert.equal(p.saves, 0)
  })

  it('снапшот из будущего формата не открывается и не перезаписывается', () => {
    const p = memory({ formatVersion: STORE_FORMAT_VERSION + 1, tasks: [] })
    assert.throws(() => store(p), /доска сохранена более новой версией.*обновите приложение/)
    assert.equal(p.saves, 0)
    assert.equal(p.data?.formatVersion, STORE_FORMAT_VERSION + 1)
  })

  it('мусорная версия — отказ, а не молчаливая миграция', () => {
    for (const bad of ['2', 0, 1.5, null]) assert.throws(() => assertStoreFormat(bad), /неизвестная версия формата/)
    assert.doesNotThrow(() => assertStoreFormat(undefined))
    assert.doesNotThrow(() => assertStoreFormat(STORE_FORMAT_VERSION))
  })
})

describe('картинки к замечаниям (пути) в снапшоте', () => {
  /** Снапшот в формате до картинок: замечания и возвраты есть, полей `images`/`feedbackImages` нет. */
  function legacy(): Partial<StoreSnapshot> {
    const s = store()
    const task = s.createTask({ title: 'Сделай' })
    const d = s.startDispatch(task.id, 'pty_w')
    s.finishDispatch(d.id, 'сделал', [])
    s.rejectReview(task.id, 'поправь тесты')
    const run = s.createRun('Цель')
    const snap = JSON.parse(JSON.stringify(s.snapshot())) as StoreSnapshot
    const r = snap.runs.find((x) => x.id === run.id)!
    r.returns = [{ at: 1, text: 'уточнение' }]
    r.stageInput = { feedback: 'замечания' }
    runId = run.id
    return snap
  }
  let runId = ''

  it('старый снапшот читается как «без картинок» и не переписывается', () => {
    const p = memory(legacy())
    const s = store(p)
    assert.equal(p.saves, 0)
    const task = s.snapshot().tasks[0]
    assert.equal(task.feedback, 'поправь тесты')
    assert.equal(task.feedbackImages, undefined)
    const run = s.snapshot().runs.find((r) => r.id === runId)!
    assert.deepEqual(run.returns, [{ at: 1, text: 'уточнение' }])
    assert.deepEqual(run.stageInput, { feedback: 'замечания' })
    assert.equal(run.returns?.[0].images, undefined)
    assert.equal(run.stageInput?.images, undefined)
  })

  it('поля с путями проходят через загрузку и сохранение как есть', () => {
    const snap = legacy() as StoreSnapshot
    const paths = ['/w/.orca-attachments/t/ret_1/image-1.png']
    snap.tasks[0].feedbackImages = paths
    const run = snap.runs.find((r) => r.id === runId)!
    run.returns = [{ at: 1, text: 'уточнение', images: paths }]
    run.stageInput = { feedback: 'замечания', images: paths }
    const p = memory(snap)
    const s = store(p)
    const back = s.snapshot()
    assert.deepEqual(back.tasks[0].feedbackImages, paths)
    const backRun = back.runs.find((r) => r.id === runId)!
    assert.deepEqual(backRun.returns?.[0].images, paths)
    assert.deepEqual(backRun.stageInput?.images, paths)
  })
})
