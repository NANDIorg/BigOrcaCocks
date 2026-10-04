import assert from 'node:assert/strict'
import * as runtime from '../src/index.ts'
import type { ProjectCommandContext } from '@orca-board/contracts'
import { workerFixture } from './worker-command-test-host.ts'

/** Настоящие Git/store/workflow/resources; только native PTY заменён в общем fixture. */
export function reviewRequestFixture() {
  assert.equal(typeof runtime.createReviewCommands, 'function', 'Review API должен работать без Desktop')
  assert.equal(typeof runtime.createHumanRequestCommands, 'function', 'Human request API должен работать без Desktop')
  assert.equal(typeof runtime.createReviewOperations, 'function', 'IPC и socket используют одну orchestration')
  const f = workerFixture()
  let allowed = true; let lookups = 0
  const policy: Array<{ context: ProjectCommandContext; command: string }> = []
  const projects = new Map<string, runtime.ReviewProject>()
  for (const [id, p] of f.projects) {
    projects.set(id, { projectId: id, isCurrent: () => projects.get(id)?.store === p.store, store: p.store, root: p.root, workflow: { ...p.workflow,
      startCoordinator: async runId => { await f.workers.startCoordinator(p.store, p.root, p.environment(runId), '', undefined, undefined, [], runId) },
      isAlive: f.sessions.isAlive } })
  }
  const operationHost: runtime.ReviewOperationHost = { workflow: f.workflow, resources: f.common,
    lifecycle: f.lifecycle, messages: { error: key => new Error(key) } }
  const host = { ...operationHost, isCurrent: (project: runtime.ReviewProject, context: ProjectCommandContext) => projects.get(context.projectId) === project,
    project: (id: string) => { lookups++; return projects.get(id) },
    authorize: (context: ProjectCommandContext, command: string) => { policy.push({ context, command }); return allowed } }
  return { ...f, projects, policy, host, operations: runtime.createReviewOperations(operationHost),
    review: runtime.createReviewCommands(host), requests: runtime.createHumanRequestCommands(host),
    denyCommands: () => { allowed = false }, lookupCount: () => lookups }
}
