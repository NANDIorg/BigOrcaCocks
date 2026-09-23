// Запуск: pnpm --filter @orca-board/desktop test. Выбор PTY ассистента в панели (pickAssistant).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickAssistant } from './assistantPty'

const none = new Set<string>()

describe('pickAssistant', () => {
  it('ассистент приложения (без projectId) — один и тот же при любом активном проекте', () => {
    const registry = [
      { ptyId: 'w1', role: 'worker', projectId: 'A' },
      { ptyId: 'as', role: 'assistant', tail: 'привет' }
    ]
    for (const project of ['A', 'B', undefined]) {
      const r = pickAssistant(registry, null, none, project)
      assert.equal(r.ptyId, 'as')
      assert.deepEqual(r.terminals, [{ ptyId: 'as', tail: 'привет' }])
    }
  })

  it('только что запущенный из ответа open/reset — даже если его ещё нет в реестре и там старый', () => {
    const r = pickAssistant([{ ptyId: 'old', role: 'assistant' }], 'new', none, 'A')
    assert.equal(r.ptyId, 'new')
    assert.deepEqual(r.terminals.map((t) => t.ptyId), ['old', 'new'])
  })

  it('закрытые при «Новый диалог» не показываются', () => {
    const r = pickAssistant([{ ptyId: 'old', role: 'assistant' }], null, new Set(['old']), 'A')
    assert.equal(r.ptyId, null)
    assert.deepEqual(r.terminals, [])
  })

  it('нет ассистента — null (App запустит его)', () => {
    assert.equal(pickAssistant([{ ptyId: 'c', role: 'coordinator', projectId: 'A' }], null, none, 'A').ptyId, null)
  })

  describe('старый main: ассистент по одному на проект, PTY с projectId', () => {
    const registry = [
      { ptyId: 'aA', role: 'assistant', projectId: 'A' },
      { ptyId: 'aB', role: 'assistant', projectId: 'B' }
    ]

    it('после перезагрузки окна находится ассистент активного проекта', () => {
      assert.equal(pickAssistant(registry, null, none, 'B').ptyId, 'aB')
      assert.equal(pickAssistant(registry, null, none, 'A').terminals.length, 2)
    })

    it('запущенный для другого проекта не показывается на текущем', () => {
      assert.equal(pickAssistant(registry, 'aA', none, 'B').ptyId, 'aB')
      assert.equal(pickAssistant([registry[0]], 'aA', none, 'B').ptyId, null)
    })
  })
})
