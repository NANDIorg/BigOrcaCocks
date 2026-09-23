// Запуск: pnpm --filter @orca-board/desktop test. Разбор флагов ask и request resolve.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { askOptions, resolutionFromParams } from './request-params'

describe('askOptions', () => {
  it('--option "метка|пояснение" повторяется, запятые в метке остаются', () => {
    const opts = askOptions({ option: ['sqlite, без сервера|проще', 'postgres'] })
    assert.deepEqual(opts, [
      { id: '1', label: 'sqlite, без сервера', hint: 'проще' },
      { id: '2', label: 'postgres' }
    ])
  })

  it('одиночный --option — строка', () => {
    assert.deepEqual(askOptions({ option: 'a|b|c' }), [{ id: '1', label: 'a', hint: 'b|c' }])
  })

  it('старое --options a,b бьётся по запятой', () => {
    assert.deepEqual(askOptions({ options: 'a, b' }).map((o) => o.label), ['a', 'b'])
  })

  it('--recommend по id и по метке', () => {
    assert.equal(askOptions({ option: ['a', 'b'], recommend: '2' })[1].recommended, true)
    assert.equal(askOptions({ option: ['Sqlite', 'pg'], recommend: 'sqlite' })[0].recommended, true)
    assert.throws(() => askOptions({ option: ['a'], recommend: 'x' }), /такого варианта нет/)
    assert.throws(() => askOptions({ option: ['a'], recommend: true }), /требует/)
  })
})

describe('resolutionFromParams', () => {
  const req = { id: 'req_1', options: [{ id: '1', label: 'sqlite' }, { id: '2', label: 'postgres' }] }

  it('вариант по id или метке, с комментарием', () => {
    assert.deepEqual(resolutionFromParams(req, { option: 'postgres' }), { action: 'answer', optionId: '2' })
    assert.deepEqual(resolutionFromParams(req, { option: '1', text: 'но с WAL' }), { action: 'answer', optionId: '1', text: 'но с WAL' })
    assert.deepEqual(resolutionFromParams(req, { text: 'свой ответ' }), { action: 'answer', text: 'свой ответ' })
    assert.throws(() => resolutionFromParams(req, { option: 'mysql' }), /варианта «mysql»/)
  })

  it('--option массивом, как его шлёт CLI (повторяемый флаг)', () => {
    assert.deepEqual(resolutionFromParams(req, { option: ['2'] }), { action: 'answer', optionId: '2' })
    assert.deepEqual(resolutionFromParams(req, { option: ['sqlite'], text: 'x' }), { action: 'answer', optionId: '1', text: 'x' })
    assert.throws(() => resolutionFromParams(req, { option: ['1', '2'] }), /только один вариант/)
    assert.throws(() => resolutionFromParams(req, { option: [true] }), /требует значения/)
    assert.throws(() => resolutionFromParams(req, { option: true }), /требует значения/)
  })

  it('accept с решением, clarify, restart, dismiss', () => {
    assert.deepEqual(resolutionFromParams(req, { accept: true, decision: 'делаем A' }), { action: 'accept', text: 'делаем A' })
    assert.deepEqual(resolutionFromParams(req, { accept: true }), { action: 'accept' })
    assert.deepEqual(resolutionFromParams(req, { clarify: 'подробнее про B' }), { action: 'clarify', text: 'подробнее про B' })
    assert.deepEqual(resolutionFromParams(req, { restart: true }), { action: 'restart' })
    assert.deepEqual(resolutionFromParams(req, { dismiss: true }), { action: 'dismiss' })
  })

  it('ровно одно действие; --decision только с --accept; флаг без значения — ошибка', () => {
    assert.throws(() => resolutionFromParams(req, {}), /укажи одно/)
    assert.throws(() => resolutionFromParams(req, { accept: true, clarify: 'x' }), /укажи одно/)
    assert.throws(() => resolutionFromParams(req, { text: 'x', decision: 'y' }), /--decision/)
    assert.throws(() => resolutionFromParams(req, { clarify: true }), /требует значения/)
  })
})
