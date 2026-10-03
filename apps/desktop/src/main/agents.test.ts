import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentInfo, AgentKind, Role } from '@orca-board/core'
import { assertAgentUsable, missingRoleMessage, parseTopLevelToml, pickRole } from './agents'
import { OrcaError, ipcError, setMainLocale } from './i18n'

afterEach(() => setMainLocale('ru'))
const agent: AgentInfo = { id: 'claude', title: 'Claude', installed: true, enabled: true, models: [], defaults: {} }
const role: Role = { id: 'dev', title: 'Developer', agent: 'claude', model: 'opus', extraArgs: '--verbose' }
function thrown(fn: () => unknown): OrcaError {
  try { fn() } catch (e) {
    assert.ok(e instanceof OrcaError, String(e))
    return e
  }
  return assert.fail('guard не отверг выбор')
}

describe('Desktop adapter агента и роли', () => {
  it('assertion signature и выбранная роль сохраняют прежние options', () => {
    const id: string = 'claude'
    assertAgentUsable([agent], id)
    const kind: AgentKind = id
    assert.equal(kind, 'claude')
    assert.equal(pickRole({ title: 'Type', roles: [role] }, [agent], undefined), role)
    assert.equal(pickRole({ title: 'Type', roles: [role, { ...role, id: 'qa' }] }, [agent], 'dev'), role)
  })

  it('unknown/notInstalled сохраняют коды и русские причины', () => {
    assert.equal(thrown(() => assertAgentUsable([], 'unknown')).key, 'agent.unknown')
    const e = thrown(() => assertAgentUsable([], 'claude'))
    assert.equal(e.key, 'agent.notInstalled')
    assert.match(e.message, /агент claude не установлен/)
    assert.match(e.message, /claude.*PATH/)
  })

  it('disabled сохраняет русский message, IPC переводится после смены языка', () => {
    const e = thrown(() => assertAgentUsable([{ ...agent, enabled: false }], 'claude'))
    assert.equal(e.key, 'agent.disabled')
    assert.match(e.message, /Включены: нет$/)
    setMainLocale('en')
    const en = ipcError(e) as Error
    assert.equal(en.name, 'OrcaError[agent.disabled]')
    assert.match(en.message, /Enabled: none$/)
    assert.match(e.message, /Включены: нет$/)
    setMainLocale('ru')
    assert.match((ipcError(e) as Error).message, /Включены: нет$/)
  })

  it('missing role сохраняет вложенные сообщения и инструкцию agent client', () => {
    setMainLocale('en')
    const type = { title: 'Type', roles: [] }
    const e = thrown(() => pickRole(type, [agent], 'developer'))
    assert.equal(e.key, 'role.missing')
    assert.equal(e.message, missingRoleMessage('developer', type))
    assert.match(e.message, /роли «developer» нет/)
    assert.equal((ipcError(e) as Error).name, 'OrcaError[role.missing]')
    assert.notEqual((ipcError(e) as Error).message, e.message)
    assert.throws(() => pickRole({ title: 'Type', roles: [role, { ...role, id: 'qa' }] }, [agent], undefined), { message: '--role обязателен. Роли: dev, qa' })
  })

  it('роль с выключенным агентом отвергается, TOML export совместим', () => {
    assert.equal(thrown(() => pickRole({ title: 'Type', roles: [role] }, [{ ...agent, enabled: false }], undefined)).key, 'agent.disabled')
    assert.deepEqual(parseTopLevelToml('model = "custom"\n[other]\nmodel = "wrong"'), { model: 'custom' })
  })
})
