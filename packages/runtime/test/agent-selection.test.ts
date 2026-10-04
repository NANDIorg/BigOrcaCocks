import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, type AgentInfo, type Role } from '@orca-board/core'
import * as runtime from '../src/index.ts'

const infos: AgentInfo[] = [
  { id: 'claude', title: 'Claude', installed: true, enabled: true, models: [], defaults: {} },
  { id: 'codex', title: 'Codex', installed: true, enabled: false, models: [], defaults: {} },
  { id: 'gemini', title: 'Gemini', installed: false, enabled: false, models: [], defaults: {} }
]
const role: Role = { id: 'dev', title: 'Dev', agent: 'claude', model: 'opus', effort: 'high', extraArgs: '--verbose' }

/** Результат реальных guards передаётся в ошибку хоста целиком. */
function selection(host = 'host'): runtime.AgentSelectionServices {
  return runtime.createAgentSelection({ error: (key, params) => Object.assign(new Error(`${host}:${key}`), { key, params }) })
}
function error(fn: () => unknown): { key: runtime.AgentSelectionErrorKey; params?: runtime.ExecutionMessageParams } {
  try { fn() } catch (e) {
    assert.ok(e instanceof Error)
    assert.ok('key' in e && 'params' in e)
    const detail = e as Error & { key: runtime.AgentSelectionErrorKey; params?: runtime.ExecutionMessageParams }
    return { key: detail.key, params: detail.params }
  }
  return assert.fail('guard не отверг выбор')
}

describe('общий выбор агента и роли', () => {
  it('установленный включённый агент проходит без изменения списка', () => {
    const service: runtime.AgentSelectionServices = selection()
    const before = structuredClone(infos)
    const id: string = 'claude'
    service.assertAgentUsable(infos, id)
    assert.equal(id, 'claude')
    assert.deepEqual(infos, before)
  })

  it('unknown возвращает код, id и список известных агентов', () => {
    const service: runtime.AgentSelectionServices = selection()
    const result = error(() => service.assertAgentUsable(infos, 'unknown'))
    assert.equal(result.key, 'agent.unknown')
    assert.equal(result.params?.id, 'unknown')
    assert.equal(result.params?.known, 'claude, codex, opencode, gemini, cursor, amp, copilot, goose, shell')
  })

  for (const absent of ['notInstalled', 'missingInfo'] as const) {
    it(`${absent}: известный CLI без установки возвращает бинарник агента`, () => {
      const service: runtime.AgentSelectionServices = selection()
      const result = error(() => service.assertAgentUsable(absent === 'missingInfo' ? [] : infos, 'gemini'))
      assert.deepEqual(result, { key: 'agent.notInstalled', params: { id: 'gemini', bin: 'gemini' } })
    })
  }

  it('выключенный агент сообщает включённые id, пустой список — вложенный common.none', () => {
    const service: runtime.AgentSelectionServices = selection()
    assert.deepEqual(error(() => service.assertAgentUsable(infos, 'codex')), { key: 'agent.disabled', params: { id: 'codex', enabled: 'claude' } })
    assert.deepEqual(error(() => service.assertAgentUsable(infos.map(a => ({ ...a, enabled: false })), 'codex')), { key: 'agent.disabled', params: { id: 'codex', enabled: { key: 'common.none' } } })
  })

  it('явная роль выбирается из нескольких и сохраняет все опции', () => {
    const service = selection()
    const roles = [DEFAULT_ROLES[0], role]
    const before = structuredClone(roles)
    assert.equal(service.pickRole({ title: 'Type', roles }, infos, 'dev'), role)
    assert.deepEqual(roles, before)
  })

  it('единственная роль выбирается без --role', () => {
    assert.equal(selection().pickRole({ title: 'Type', roles: [role] }, infos, undefined), role)
  })

  it('отсутствующая системная роль сохраняет подсказку типа, empty roles — common.none', () => {
    assert.deepEqual(error(() => selection().pickRole({ title: 'Type', roles: [] }, infos, 'developer')), {
      key: 'role.missing', params: { role: 'developer', type: 'Type', ids: { key: 'common.none' }, hint: { key: 'role.missing.systemHint', params: { type: 'Type' } } }
    })
    assert.deepEqual(error(() => selection().pickRole({ title: 'Type', roles: [role] }, infos, 'custom')), {
      key: 'role.missing', params: { role: 'custom', type: 'Type', ids: 'dev', hint: { key: 'role.missing.hint' } }
    })
  })

  it('несколько ролей без выбора сохраняют ошибку для agent client; пустой список тоже требует --role', () => {
    assert.throws(() => selection().pickRole({ title: 'Type', roles: [role, { ...role, id: 'qa' }] }, infos, undefined), { message: '--role обязателен. Роли: dev, qa' })
    assert.throws(() => selection().pickRole({ title: 'Type', roles: [] }, infos, undefined), { message: '--role обязателен. Роли: ' })
  })

  for (const agent of ['codex', 'gemini'] as const) {
    it(`агент роли ${agent} проверяется при явном и неявном выборе`, () => {
      const type = { title: 'Type', roles: [{ ...role, agent }] }
      const key = agent === 'codex' ? 'agent.disabled' : 'agent.notInstalled'
      assert.equal(error(() => selection().pickRole(type, infos, 'dev')).key, key)
      assert.equal(error(() => selection().pickRole(type, infos, undefined)).key, key)
    })
  }

  it('две error factories изолированы и используются в агенте и missing role', () => {
    const one: runtime.AgentSelectionServices = selection('one')
    const two: runtime.AgentSelectionServices = selection('two')
    assert.throws(() => one.assertAgentUsable(infos, 'codex'), { message: 'one:agent.disabled' })
    assert.throws(() => two.assertAgentUsable(infos, 'codex'), { message: 'two:agent.disabled' })
    assert.throws(() => one.pickRole({ title: 'Type', roles: [] }, infos, 'dev'), { message: 'one:role.missing' })
    assert.throws(() => two.pickRole({ title: 'Type', roles: [] }, infos, 'dev'), { message: 'two:role.missing' })
  })
})
