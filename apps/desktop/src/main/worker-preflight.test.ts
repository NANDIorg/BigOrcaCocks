import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentInfo, Role } from '@orca-board/core'
import { validateWorkerRole } from './worker-preflight'
import { OrcaError, ipcError, setMainLocale } from './i18n'

afterEach(() => setMainLocale('ru'))
const agent: AgentInfo = { id: 'claude', title: 'Claude', installed: true, enabled: true, models: [], defaults: {} }
const role: Role = { id: 'developer', title: 'Dev', agent: 'claude', extraArgs: '--verbose' }
function thrown(fn: () => unknown): OrcaError {
  try { fn() } catch (e) { assert.ok(e instanceof OrcaError); return e }
  return assert.fail('guard не отверг запуск')
}

it('Desktop preflight возвращает выбранную роль с прежними launch options', () => {
  const before = structuredClone(role)
  assert.equal(validateWorkerRole({ title: 'Type', roles: [role] }, [agent], 'developer'), role)
  assert.deepEqual(role, before)
})
it('missing role сохраняет worker.cannotStart и вложенную причину типа', () => {
  const e = thrown(() => validateWorkerRole({ title: 'Type', roles: [] }, [agent], 'developer'))
  assert.equal(e.key, 'worker.cannotStart'); assert.match(e.message, /роли «developer» нет/)
  assert.match(e.message, /Type/)
})
it('disabled сохраняет код агента и переводится при доставке IPC', () => {
  const e = thrown(() => validateWorkerRole({ title: 'Type', roles: [role] }, [{ ...agent, enabled: false }], role.id))
  assert.equal(e.key, 'agent.disabled'); assert.match(e.message, /Включены: нет$/)
  setMainLocale('en')
  assert.equal((ipcError(e) as Error).name, 'OrcaError[agent.disabled]')
  assert.match((ipcError(e) as Error).message, /Enabled: none$/)
})
it('invalid flags сохраняют worker.cannotStart и перевод вложенной ошибки', () => {
  const invalid = { ...role, extraArgs: 'positional' }
  const e = thrown(() => validateWorkerRole({ title: 'Type', roles: [invalid] }, [agent], role.id))
  assert.equal(e.key, 'worker.cannotStart'); assert.match(e.message, /developer/)
  setMainLocale('en')
  assert.notEqual((ipcError(e) as Error).message, e.message)
})
