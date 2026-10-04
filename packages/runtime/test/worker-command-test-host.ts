import assert from 'node:assert/strict'
import { DEFAULT_ROLES, type AgentInfo, type Workflow } from '@orca-board/core'
import type { ProjectCommandContext } from '@orca-board/contracts'
import * as runtime from '../src/index.ts'
import { coordinatorFixture } from './coordinator-command-test-host.ts'

/** Реальные services/launcher/Git/store; native PTY наследуется из общего execution fixture. */
export function workerFixture(error: (key: runtime.ExecutionMessageKey | runtime.AgentSelectionErrorKey, params?: runtime.ExecutionMessageParams) => Error = key => new Error(key)) {
  assert.equal(typeof runtime.createWorkerCommands, 'function', 'Общий API воркеров нужен вне Electron')
  assert.equal(typeof runtime.createWorkerOperations, 'function', 'Socket и workflow используют одну orchestration')
  assert.equal(typeof runtime.createTaskWorkerLifecycle, 'function', 'Живость и закрытие PTY принадлежат runtime')
  const f = coordinatorFixture()
  let allowed = true; let lookups = 0
  const policy: Array<{ context: ProjectCommandContext; command: string }> = []
  const configs = new Map<string, { environment: runtime.WorkerEnvContext; agents: AgentInfo[]; workflow?: Workflow }>()
  const projects = new Map<string, runtime.WorkerProject>()
  const lifecycle = runtime.createTaskWorkerLifecycle(f.sessions)
  const preflight = runtime.createWorkerPreflight({ messages: { error }, selection: runtime.createAgentSelection({ error }),
    launchPolicy: runtime.createLaunchPolicy({ error }) })
  const operationHost = { workers: f.workers, workflow: f.workflow.task, preflight, lifecycle, resources: f.common }
  const operations = runtime.createWorkerOperations(operationHost)
  for (const [id, p] of f.projects) {
    const config = { environment: { ...p.environment(), roles: structuredClone(DEFAULT_ROLES).map(role => role.id === 'reviewer' ? { ...role, agent: 'codex' as const } : role) },
      agents: ['claude', 'codex'].map(id => ({ id, title: id, installed: true, enabled: true, models: [], defaults: {} })) as AgentInfo[],
      workflow: undefined as Workflow | undefined }
    configs.set(id, config)
    const project: runtime.WorkerProject = { projectId: id, isCurrent: () => projects.get(id) === project, store: p.store, root: p.root,
      agents: () => config.agents, environment: () => ({ ...config.environment, ...(config.workflow ? { workflow: config.workflow } : {}) }),
      workflow: { ...p.workflow, run: () => ({ roles: config.environment.roles, ...(config.workflow ? { workflow: config.workflow } : {}) }),
        startWorker: async (taskId, opts) => (await operations.start(project, taskId, opts)) } }
    projects.set(id, project)
  }
  const host: runtime.WorkerCommandHost = { ...operationHost, isCurrent: (project, context) => projects.get(context.projectId) === project,
    project: id => { lookups++; return projects.get(id) },
    authorize: (context, command) => { policy.push({ context, command }); return allowed } }
  return { ...f, projects, configs, host, operations, lifecycle, policy, commands: runtime.createWorkerCommands(host),
    deny: () => { allowed = false }, counts: () => ({ lookups, spawns: f.processes.length }) }
}
