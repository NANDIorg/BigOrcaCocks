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
