import type { OrcaApi } from './legacy-api.ts'
import type { OperatorProduct } from '@orca-board/contracts'
import { createOrcaClient, OrcaClientError } from './client.ts'
import { createIpcTransport } from './ipc.ts'
import { createLegacyBindings } from './platform.ts'

/** Поэтапный Desktop adapter: native ports прежние, group CRUD уже вызывает общий operator client. */
export function createDesktopBindings(api: OrcaApi, product: OperatorProduct) {
  const bindings = createLegacyBindings(api)
  if (!api.operator) return { ...bindings, dispose: async () => {} }
  const operator = createOrcaClient({ transport: createIpcTransport(api.operator), product, pollMs: 0 })
  const revision = async () => {
    await operator.connect(); await operator.refresh()
    const snapshot = operator.state.snapshot
    if (!snapshot || typeof snapshot !== 'object' || !('revision' in snapshot) || typeof snapshot.revision !== 'number') throw new OrcaClientError('protocol.invalidReply')
    return snapshot.revision
  }
  const compatibleRevision = async () => {
    try { return await revision() }
    catch (error) {
      if (error instanceof Error && /No handler registered.*operator:hello/.test(error.message)) return undefined
      throw error
    }
  }
  // Недоступный новый main/preload не отключает legacy API после HMR.
  bindings.client.projects.createGroup = async name => {
    const current = await compatibleRevision(); if (current === undefined) return api.projects.createGroup(name)
    return operator.call('profile', 'createGroup', [name], { revision: current })
  }
  bindings.client.projects.renameGroup = async (id, name) => {
    const current = await compatibleRevision(); if (current === undefined) return api.projects.renameGroup(id, name)
    return operator.call('profile', 'renameGroup', [id, name], { revision: current })
  }
  bindings.client.projects.removeGroup = async id => {
    const current = await compatibleRevision(); if (current === undefined) return api.projects.removeGroup(id)
    await operator.call('profile', 'removeGroup', [id], { revision: current })
  }
  return { ...bindings, dispose: async () => { await operator.close().catch(() => {}) } }
}
