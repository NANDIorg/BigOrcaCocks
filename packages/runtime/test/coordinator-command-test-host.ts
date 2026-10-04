import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, TaskStore, type Workflow } from '@orca-board/core'
import type { ProjectCommandContext } from '@orca-board/contracts'
import * as runtime from '../src/index.ts'
import type { PtyFactory, PtyProcess } from '../src/sessions.ts'
import { messages, resources } from './execution-test-host.ts'
import { workflowMessages } from './workflow-test-host.ts'

export const feedbackFile = [{ name: 'notes.txt', mime: 'text/plain', data: new Uint8Array([65, 66]) }]
export const runGraph: Workflow = { version: 2,
  nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'work', type: 'work', x: 0, y: 0 },
    { id: 'human', type: 'human', x: 0, y: 0 }, { id: 'end', type: 'end', x: 0, y: 0 }],
  edges: [{ id: 'a', from: 'start', outcome: 'next', to: 'work' }, { id: 'b', from: 'work', outcome: 'next', to: 'human' },
    { id: 'c', from: 'human', outcome: 'accept', to: 'end' }, { id: 'd', from: 'human', outcome: 'reject', to: 'work' }] }

/** Настоящий store/Git/workflow/launcher; единственная внешняя подмена — native PTY процесс. */
export function coordinatorFixture(error: (key: 'workflow.runFinished' | 'workflow.coordinatorNotRunning') => Error = key => new Error(key)) {
  assert.equal(typeof runtime.createCoordinatorCommands, 'function', 'Общий API координатора нужен вне Electron')
  assert.equal(typeof runtime.createCoordinatorOperations, 'function', 'Сокет и команды используют одну orchestration')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-coordinator-command-')))
  const processes: Array<{ options: Parameters<PtyFactory>[2]; proc: PtyProcess }> = []
  let failSpawn = false; let allowed = true; let lookups = 0
  const policy: Array<{ context: ProjectCommandContext; command: string }> = []
  const sessions = runtime.createSessionRegistry({ spawn: (_command, _args, options) => {
    if (failSpawn) throw new Error('native spawn failed')
    let exit = (_event: { exitCode: number }) => {}
    const proc: PtyProcess = { onData: () => {}, onExit: fn => { exit = fn }, write: () => {}, resize: () => {}, kill: () => exit({ exitCode: 130 }) }
    processes.push({ options, proc }); return proc
  } })
  const common = resources()
  const workflow = runtime.createWorkflowServices({ resources: common, messages: workflowMessages('en') })
  const workers = runtime.createWorkerServices({ resources: common, messages, sessions,
    launcher: runtime.createAgentLauncher({ settingsInvalid: path => new Error(path) }),
    host: { dataDir: join(dir, 'profile'), cliBinDir: join(dir, 'cli'), nodePath: '/test/node',
      prompts: { worker: 'WORKER_SKILL', coordinator: 'COORDINATOR_SKILL', assistant: 'ASSISTANT_SKILL' },
      language: () => 'en', shell: () => '/bin/sh', extraPathDirs: () => [], platform: 'linux', env: { PATH: '/bin' },
      launchOptions: () => ({ platform: 'linux', home: dir, tempRoot: dir, env: {}, findBin: bin => bin }) } })
  const projects = new Map<string, runtime.CoordinatorProject>()
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
  for (const id of ['A', 'B']) {
    const root = join(dir, id); mkdirSync(root); git(root, 'init', '-qb', 'master')
    writeFileSync(join(root, 'README.md'), 'base\n'); git(root, 'add', 'README.md'); git(root, 'commit', '-qm', 'init')
    const store = new TaskStore(runtime.jsonPersistence(join(dir, `${id}.json`)), () => DEFAULT_COLUMNS)
    const environment = (): runtime.WorkerEnvContext => ({ socketPath: join(dir, 'orca.sock'), projectId: id,
      roles: DEFAULT_ROLES, permissionMode: 'auto', typeTitle: id })
    const deps: runtime.RunWorkflowDeps = { projectId: id, isCurrent: () => projects.get(id)?.store === store, store, repoRoot: root, run: () => ({ roles: DEFAULT_ROLES }),
      isAlive: sessions.isAlive, startCoordinator: async runId => { await workers.startCoordinator(store, root, environment(), '', undefined, undefined, [], runId) },
      startWorker: async (taskId, opts) => (await workers.startWorker(store, root, environment(), taskId, undefined, undefined, opts?.roleId)),
      mergeTarget: async task => (await common.mergeTarget(store, root, task)) }
    projects.set(id, { projectId: id, isCurrent: () => projects.get(id)?.store === store, store, root, workflow: deps, environment,
      newRunEnvironment: (typeId = 'default') => {
        if (typeId !== 'default') throw new Error('unknown type')
        return { ...environment(), type: { typeId, snapshot: { id: typeId, title: id, roles: DEFAULT_ROLES }, workflow: runGraph } }
      } })
  }
  const host: runtime.CoordinatorCommandHost = { isCurrent: (project, context) => projects.get(context.projectId) === project, workers, workflow: workflow.run, resources: common, messages: { error },
    authorize: (context, command) => { policy.push({ context, command }); return allowed },
    project: id => { lookups++; return projects.get(id) } }
  const commands = runtime.createCoordinatorCommands(host)
  return { dir, commands, host, common, workflow, sessions, workers, projects, processes, policy, git,
    context: (projectId = 'A', kind: 'operator' | 'agent' | 'system' = 'operator') => ({ projectId, clientId: 'desktop:1', actor: { kind, id: 'local-user' } }),
    counts: () => ({ lookups, spawns: processes.length }), deny: () => { allowed = false }, fail: () => { failSpawn = true },
    finishWork: async (runId: string, projectId = 'A') => {
      const project = projects.get(projectId)!
      const task = project.store.createTask({ title: 'Finished work', runId, roleId: 'developer' })
      project.store.moveTask(task.id, 'done')
      await workflow.run.finishRunStage(project.workflow, runId)
    },
    close: () => { sessions.killAll(); rmSync(dir, { recursive: true, force: true }) } }
}
