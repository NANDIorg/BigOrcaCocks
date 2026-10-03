import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import type { ProjectMessageKey, ProjectMessageParams } from '../src/project-messages.ts'
import type { ClientCommandContext } from '@orca-board/contracts'

export class ProfileHostError extends Error {
  readonly key: ProjectMessageKey
  readonly params?: ProjectMessageParams
  constructor(key: ProjectMessageKey, params?: ProjectMessageParams) { super(key); this.key = key; this.params = params }
}
export const operator: ClientCommandContext = { clientId: 'one', actor: { kind: 'operator', id: 'person' } }
export const profileGraph = () => ({ version: 2 as const, nodes: [{ id: 's', type: 'start' as const, x: 0, y: 0 },
  { id: 'w', type: 'work' as const, roleIds: ['developer'], x: 0, y: 0 }, { id: 'e', type: 'end' as const, x: 0, y: 0 }],
  edges: [{ id: 'sw', from: 's', outcome: 'next' as const, to: 'w' }, { id: 'we', from: 'w', outcome: 'next' as const, to: 'e' }] })

export function profileFixture() {
  assert.equal(typeof runtime.createProfileCommands, 'function', 'Общий API профиля экспортирован без Desktop')
  assert.equal(typeof runtime.createProjectConfigCommands, 'function', 'Конфигурация проекта адресуется явно')
  assert.equal(typeof runtime.createWorkflowAssistantServices, 'function', 'Workflow helper общий')
  const dir = mkdtempSync(join(tmpdir(), 'orca-profile-commands-'))
  const dataDir = join(dir, 'profile')
  const messages = { Error: ProfileHostError, text: (key: ProjectMessageKey) => key }
  const services = runtime.createProjectServices({ messages, settings: runtime.createRuntimeSettings(messages) })
  const manager = new services.ProjectManager(dataDir)
  const repo = (name: string) => {
    const root = join(dir, name); mkdirSync(root)
    execFileSync('git', ['init', '-q', root], { stdio: 'pipe' })
    return realpathSync(root)
  }
  const a = manager.add(repo('A')); const b = manager.add(repo('B')); manager.setActive(a.id)
  let lookups = 0; let allow = true; let metaReads = 0
  const authorize = (context: ClientCommandContext) => allow && context.actor.kind === 'operator'
  const host = { manager: () => { lookups++; return manager }, authorize,
    workflowAssistant: runtime.createWorkflowAssistantServices({ messages }),
    exportMeta: () => { metaReads++; return { appVersion: '2.3.4', exportedAt: '2026-10-04T00:00:00Z' } } }
  const commands = runtime.createProfileCommands(host)
  const config = runtime.createProjectConfigCommands(host)
  return { dir, dataDir, manager, commands, config, host, a, b, repo,
    lookups: () => lookups, metaReads: () => metaReads, deny: () => { allow = false },
    reload: () => new services.ProjectManager(dataDir), close: () => rmSync(dir, { recursive: true, force: true }) }
}
