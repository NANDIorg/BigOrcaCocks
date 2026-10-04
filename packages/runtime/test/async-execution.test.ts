import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskStore, DEFAULT_ROLES, WORKFLOW_VERSION_TASK_SCOPE, withStatusSource, type Workflow } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, commitGate } from './git-queue-fixture.ts'
import { createAttachmentServices } from '../src/attachments.ts'
import { workflowMessages } from './workflow-test-host.ts'

const stale = (error: unknown) => error instanceof runtime.CommandError && error.code === 'command.stale'
function fixture(t: TestContext, failSpawn = false) {
  const f = gitQueueFixture(t); const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const gitOps = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  const resources = runtime.createExecutionResources({ messages: { error: key => new Error(key) }, git: gitOps, logger: { warn: () => {} } })
  t.after(() => resources.effects.stop()); const store = new TaskStore(); let current = true
  const ctx = { projectId: 'P', socketPath: join(f.dir, 'orca.sock'), roles: DEFAULT_ROLES, typeTitle: 'Type', permissionMode: 'auto' as const, isCurrent: () => current }
  const sessions = runtime.createSessionRegistry({ spawn: () => { if (failSpawn) throw new Error('native PTY launch failed'); return ({ onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }) } })
  const workers = runtime.createWorkerServices({ resources, messages: { error: key => new Error(key) }, sessions,
    launcher: runtime.createAgentLauncher({ settingsInvalid: path => new Error(path) }),
    host: { dataDir: join(f.dir, 'profile'), cliBinDir: join(f.dir, 'cli'), prompts: { worker: 'worker', coordinator: 'coordinator', assistant: 'assistant' },
      language: () => 'ru', shell: () => process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', extraPathDirs: () => [],
      launchOptions: () => ({ home: f.dir, tempRoot: f.dir, env: {}, findBin: () => join(f.dir, 'agent') }) } })
  const messages = workflowMessages(); const workflow = runtime.createWorkflowServices({ resources, messages })
  const deps = { projectId: ctx.projectId, isCurrent: ctx.isCurrent, store, repoRoot: f.root, run: () => ({ roles: DEFAULT_ROLES }),
    isAlive: sessions.isAlive, startWorker: (id: string) => workers.startWorker(store, f.root, ctx, id), startCoordinator: () => {} }
  return { ...f, resources, store, workers, ctx, sessions, workflow, deps, unregister: () => { current = false } }
}
function checkoutGate(t: TestContext, f: ReturnType<typeof fixture>) {
  const gate = commitGate(t, f.dir, f.root)
  renameSync(join(f.dir, 'hooks', 'pre-commit'), join(f.dir, 'hooks', 'post-checkout')); return gate
}

for (const mutation of ['visit', 'dispatch', 'registration'] as const) test(`worker preparation: ${mutation} during real checkout prevents late spawn/store`, { timeout: 15000 }, async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' })
  task.stage = { nodeId: 'work', visits: { work: 1 } }; const gate = checkoutGate(t, f)
  const pending = f.workers.startWorker(f.store, f.root, f.ctx, task.id); const rejected = assert.rejects(Promise.resolve(pending), stale)
  await gate.entered()
  await f.resources.git.createInitialCommit(f.other, 'empty')
  if (mutation === 'visit') task.stage.visits.work = 2
  else if (mutation === 'dispatch') f.store.startDispatch(task.id, 'replacement')
  else f.unregister()
  const snapshot = structuredClone(f.store.snapshot()); gate.release(); await rejected
  assert.deepEqual(f.store.snapshot(), snapshot); assert.equal(f.sessions.terminalSnapshots().length, 0)
  assert.equal(git(f.root, 'branch', '--show-current'), 'main')
})
test('worker command: policy revoked during actual checkout prevents late dispatch', { timeout: 15000 }, async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' }); const gate = checkoutGate(t, f)
  const project = { projectId: 'P', root: f.root, store: f.store, workflow: f.deps, environment: () => f.ctx,
    agents: () => DEFAULT_ROLES.map(role => ({ id: role.agent, title: role.agent, installed: true, enabled: true, models: [], defaults: {} })) }
  let allowed = true
  const commands = runtime.createWorkerCommands({ workers: f.workers, workflow: f.workflow.task, resources: f.resources,
    lifecycle: runtime.createTaskWorkerLifecycle(f.sessions), preflight: runtime.createWorkerPreflight({ messages: { error: key => new Error(key) },
      selection: runtime.createAgentSelection({ error: key => new Error(key) }), launchPolicy: f.resources }),
    project: id => id === 'P' ? project : undefined, isCurrent: captured => captured === project, authorize: () => allowed })
  const pending = commands.start({ projectId: 'P', clientId: 'C', actor: { kind: 'operator', id: 'user' } }, task.id)
  const rejected = assert.rejects(pending, error => error instanceof runtime.CommandError && error.code === 'command.forbidden')
  await gate.entered(); allowed = false; const before = structuredClone(f.store.snapshot())
  await f.resources.git.createInitialCommit(f.other, 'empty'); gate.release(); await rejected
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.store.activeDispatches().length, 0)
  assert.equal(f.sessions.terminalSnapshots().length, 0)
})
test('explicit stop while task is ready aborts held checkout and permits next queue job', { timeout: 15000 }, async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' }); const gate = checkoutGate(t, f)
  const pending = f.workers.startWorker(f.store, f.root, f.ctx, task.id); const rejected = assert.rejects(Promise.resolve(pending), stale)
  await gate.entered(); const lifecycle = runtime.createTaskWorkerLifecycle(f.sessions)
  const ops = runtime.createWorkerOperations({ workers: f.workers, workflow: f.workflow.task,
    preflight: runtime.createWorkerPreflight({ messages: { error: key => new Error(key) }, selection: runtime.createAgentSelection({ error: key => new Error(key) }), launchPolicy: f.resources }), lifecycle, resources: f.resources })
  ops.stop({ store: f.store, projectId: 'P' }, task.id); await rejected
  assert.equal(f.store.getTask(task.id)!.status, 'ready'); assert.equal(f.store.snapshot().dispatches.length, 0)
  assert.equal(f.sessions.terminalSnapshots().length, 0)
  await f.resources.git.projectFetch(f.alias); gate.release()
})
test('two concurrent launches create one live session and dispatch', async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' })
  const results = await Promise.allSettled([f.workers.startWorker(f.store, f.root, f.ctx, task.id), f.workers.startWorker(f.store, f.root, f.ctx, task.id)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.store.activeDispatches().length, 1); assert.equal(f.sessions.terminalSnapshots().length, 1)
})
test('stop during awaited workflow preparation cancels start before worker dispatch exists', async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' })
  const ops = runtime.createWorkerOperations({ workers: f.workers, workflow: f.workflow.task, resources: f.resources,
    lifecycle: runtime.createTaskWorkerLifecycle(f.sessions), preflight: runtime.createWorkerPreflight({ messages: { error: key => new Error(key) },
      selection: runtime.createAgentSelection({ error: key => new Error(key) }), launchPolicy: f.resources }) })
  const project = { projectId: 'P', root: f.root, store: f.store, workflow: f.deps, environment: () => f.ctx,
    agents: () => DEFAULT_ROLES.map(role => ({ id: role.agent, title: role.agent, installed: true, enabled: true, models: [], defaults: {} })) }
  const pending = ops.start(project, task.id); const rejected = assert.rejects(pending, stale)
  ops.stop(project, task.id); await rejected
  assert.equal(f.store.snapshot().dispatches.length, 0); assert.equal(f.sessions.terminalSnapshots().length, 0)
})
test('review stale after actual commit does not merge/delete worktree or accept task', { timeout: 15000 }, async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' })
  const wt = join(f.dir, 'task'); git(f.root, 'worktree', 'add', '-qb', 'task', wt); f.store.updateTask(task.id, { branch: 'task', worktree: wt })
  writeFileSync(join(wt, 'answer.txt'), 'valuable'); const gate = commitGate(t, f.dir, f.root); const head = git(f.root, 'rev-parse', 'HEAD')
  const pending = f.workflow.review.acceptReview(f.store, f.root, task.id, undefined, undefined, f.deps)
  const rejected = assert.rejects(Promise.resolve(pending), stale); await gate.entered(); f.store.startDispatch(task.id, 'replacement')
  const snapshot = structuredClone(f.store.snapshot()); gate.release(); await rejected
  assert.deepEqual(f.store.snapshot(), snapshot); assert.equal(git(f.root, 'rev-parse', 'HEAD'), head)
  assert.equal(existsSync(wt), true); assert.equal(git(wt, 'show', 'HEAD:answer.txt'), 'valuable')
})
test('async review conflict preserves task branch and files', async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' }); const wt = join(f.dir, 'task')
  writeFileSync(join(f.root, 'same.txt'), 'base\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'base')
  git(f.root, 'worktree', 'add', '-qb', 'task', wt); f.store.updateTask(task.id, { branch: 'task', worktree: wt })
  writeFileSync(join(wt, 'same.txt'), 'feature\n'); writeFileSync(join(f.root, 'same.txt'), 'main\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'main')
  await assert.rejects(f.workflow.review.acceptReview(f.store, f.root, task.id), /CONFLICT|conflict/i)
  assert.equal(existsSync(wt), true); assert.equal(readFileSync(join(wt, 'same.txt'), 'utf8'), 'feature\n')
  assert.throws(() => git(f.root, 'rev-parse', '--verify', 'MERGE_HEAD')); assert.notEqual(f.store.getTask(task.id)!.status, 'done')
})
test('task Git node: changed visit during hook neither advances nor writes stale failure', { timeout: 15000 }, async t => {
  const f = fixture(t); const wf: Workflow = { version: WORKFLOW_VERSION_TASK_SCOPE,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'git', type: 'git', operation: 'create_branch', branch: 'prepared', x: 0, y: 0 }, { id: 'work', type: 'work', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'git' }, { id: 'b', from: 'git', outcome: 'ok', to: 'work' }] }
  const run = f.store.createRun('Goal', undefined, wf); const task = f.store.createTask({ title: 'Work', runId: run.id, roleId: 'developer' })
  const gate = checkoutGate(t, f); const deps = { ...f.deps, run: () => ({ roles: DEFAULT_ROLES, workflow: wf }) }
  const pending = f.workflow.task.enterWork(deps, task.id); const rejected = assert.rejects(Promise.resolve(pending), stale)
  await gate.entered(); task.stage!.visits.git = 2; const snapshot = structuredClone(f.store.snapshot()); gate.release(); await rejected
  assert.deepEqual(f.store.snapshot(), snapshot); assert.equal(f.sessions.terminalSnapshots().length, 0)
})
test('run Git node: replaced visit after native commit does not advance or block new stage', { timeout: 15000 }, async t => {
  const f = fixture(t); const wf: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'git', type: 'git', operation: 'commit', message: 'actual commit', x: 0, y: 0 }, { id: 'human', type: 'human', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'git' }, { id: 'b', from: 'git', outcome: 'ok', to: 'human' }] }
  const run = f.store.createRun('Goal', undefined, wf); const g = await f.resources.ensureRunBranch(f.store, f.root, run.id)
  writeFileSync(join(g!.worktree!, 'valuable.txt'), 'native commit'); const gate = commitGate(t, f.dir, f.root)
  const deps = { ...f.deps, run: () => ({ roles: DEFAULT_ROLES, workflow: wf }) }
  const pending = f.workflow.run.startRunWorkflow(deps, run.id); const rejected = assert.rejects(Promise.resolve(pending), stale)
  await gate.entered(); run.stage!.visits.git = 2; const snapshot = structuredClone(f.store.snapshot()); gate.release(); await rejected
  assert.deepEqual(f.store.snapshot(), snapshot); assert.equal(git(g!.worktree!, 'show', 'HEAD:valuable.txt'), 'native commit')
})
test('completed service-task cleanup binds its dispatch after parent deliberately advances', async t => {
  const f = fixture(t); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'old', type: 'ask', roleId: 'developer', instructions: 'Ask', x: 0, y: 0 }, { id: 'next', type: 'human', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'old' }, { id: 'b', from: 'old', outcome: 'next', to: 'next' }] }
  const run = f.store.createRun('Parent', undefined, workflow); f.store.enterRunStage(run.id, { roleIds: ['developer'] })
  const task = f.store.createTask({ title: 'Old question', runId: run.id, stageOf: { nodeId: 'old', visit: 1 } })
  f.store.advanceRunStage(run.id, 'next', { nodeId: 'old', roleIds: ['developer'] })
  const scope = f.resources.effects.capture({ id: 'P', root: f.root, store: f.store }, { taskId: task.id, parentPosition: false })
  t.after(() => scope.close()); assert.equal(scope.commit(() => 'current cleanup'), 'current cleanup')
  f.store.startDispatch(task.id, 'replacement')
  assert.throws(() => scope.commit(() => f.store.acceptTask(task.id)), stale)
  assert.equal(f.store.getTask(task.id)!.status, 'in_progress')
})
for (const referenced of [false, true]) test(`async attachment failure ${referenced ? 'preserves durable references' : 'removes unreferenced files'}`, async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Work', roleId: 'developer' }); const wt = join(f.dir, 'task')
  git(f.root, 'worktree', 'add', '-qb', 'task', wt); f.store.updateTask(task.id, { worktree: wt, branch: 'task' })
  const d = f.store.startDispatch(task.id, 'old'); f.store.finishDispatch(d.id, 'done', [], 'answer')
  let saved: string[] = []
  await assert.rejects(f.resources.rejectWithImages(f.store, f.root, task.id, [{ name: 'note.txt', mime: 'text/plain', data: new TextEncoder().encode('note') }], 'feedback', async paths => {
    saved = paths; await Promise.resolve(); if (referenced) f.store.rejectReview(task.id, 'feedback', paths); throw new Error('late launch error')
  }), /late launch error/)
  assert.equal(saved.length, 1); assert.equal(existsSync(saved[0]), referenced)
})

test('native worker launch failure after valid worktree preparation blocks current task stage', async t => {
  const f = fixture(t, true); const workflow: Workflow = { version: WORKFLOW_VERSION_TASK_SCOPE,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'one', type: 'work', roleId: 'developer', x: 0, y: 0 }, { id: 'two', type: 'work', roleId: 'developer', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'one' }, { id: 'b', from: 'one', outcome: 'next', to: 'two' }] }
  const run = f.store.createRun('Goal', undefined, workflow)
  const task = f.store.createTask({ title: 'Work', roleId: 'developer', runId: run.id })
  const deps = { ...f.deps, run: () => ({ roles: DEFAULT_ROLES, workflow }) }
  await f.workflow.task.enterWork(deps, task.id)
  await f.workflow.task.advance(deps, task.id, 'next')
  assert.equal(task.stage?.nodeId, 'two'); assert.match(task.stageBlock!.reason, /native PTY launch failed/)
  assert.equal(task.stageBlock?.nodeId, 'two'); assert.equal(f.store.snapshot().dispatches.length, 0)
  assert.ok(task.worktree); assert.ok(existsSync(task.worktree))
})

test('delegated launch failure cannot block a replacement task visit', async t => {
  const f = fixture(t); const workflow: Workflow = { version: WORKFLOW_VERSION_TASK_SCOPE,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'one', type: 'work', roleId: 'developer', x: 0, y: 0 }, { id: 'two', type: 'work', roleId: 'developer', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'one' }, { id: 'b', from: 'one', outcome: 'next', to: 'two' }] }
  const run = f.store.createRun('Goal', undefined, workflow)
  const task = f.store.createTask({ title: 'Work', roleId: 'developer', runId: run.id })
  let release!: () => void; let enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve }); const entered = new Promise<void>(resolve => { enter = resolve })
  const deps = { ...f.deps, run: () => ({ roles: DEFAULT_ROLES, workflow }), startWorker: async () => { enter(); await held; throw new Error('late native failure') } }
  await f.workflow.task.enterWork(deps, task.id)
  const rejected = assert.rejects(f.workflow.task.advance(deps, task.id, 'next'), stale)
  await entered; task.stage!.visits.two = 2; const before = structuredClone(f.store.snapshot()); release(); await rejected
  assert.deepEqual(f.store.snapshot(), before)
})

test('branchless review and merge do not require a Git repository', async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Answer only' })
  assert.deepEqual(await f.workflow.review.mergeTaskBranch(f.dir, task), { ok: true })
  await f.workflow.review.acceptReview(f.store, f.dir, task.id)
  assert.equal(task.status, 'done')
})
test('run phase after awaited Git keeps workflow authorship', async t => {
  const f = fixture(t); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'git', type: 'git', operation: 'commit', message: 'commit', x: 0, y: 0 }, { id: 'ask', type: 'ask', roleId: 'developer', instructions: 'Ask', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'git' }, { id: 'b', from: 'git', outcome: 'ok', to: 'ask' }] }
  const run = f.store.createRun('Goal', undefined, workflow); await f.resources.ensureRunBranch(f.store, f.root, run.id)
  await withStatusSource('human', () => f.workflow.run.startRunWorkflow(f.deps, run.id))
  const task = f.store.listTasks().find(task => task.runId === run.id)!
  assert.equal(task.status, 'in_progress'); assert.equal(task.statusHistory?.[0]?.by, 'workflow'); assert.equal(task.statusHistory?.at(-1)?.by, 'workflow')
})
test('run worker late failure cannot block a replaced ask visit', async t => {
  const f = fixture(t); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'ask', type: 'ask', roleId: 'developer', instructions: 'Ask', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'ask' }] }
  const run = f.store.createRun('Goal', undefined, workflow); await f.resources.ensureRunBranch(f.store, f.root, run.id)
  let release!: () => void; let enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve }); const entered = new Promise<void>(resolve => { enter = resolve })
  const deps = { ...f.deps, startWorker: async () => { enter(); await held; throw new Error('late failure') } }
  const rejected = assert.rejects(f.workflow.run.startRunWorkflow(deps, run.id), stale)
  await entered; run.stage!.visits.ask = 2; const before = structuredClone(f.store.snapshot()); release(); await rejected
  assert.deepEqual(f.store.snapshot(), before)
})
test('human request late launch failure cannot escalate a replacement dispatch', async t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Answer', answerFor: 'human' })
  const d = f.store.startDispatch(task.id, 'old'); f.store.finishDispatch(d.id, 'done', [], 'answer')
  const request = f.store.pendingRequests().find(request => request.taskId === task.id)!
  let release!: () => void; let enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve }); const entered = new Promise<void>(resolve => { enter = resolve })
  const rejected = assert.rejects(f.workflow.review.resolveHumanRequest(f.store, f.root, request.id, { action: 'clarify', text: 'More' },
    async () => { enter(); await held; throw new Error('late failure') }, undefined, undefined, f.deps), stale)
  await entered; f.store.startDispatch(task.id, 'replacement'); const before = structuredClone(f.store.snapshot()); release(); await rejected
  assert.deepEqual(f.store.snapshot(), before)
})

test('fork effects capture both lane visits before awaiting the first launcher', async t => {
  const f = fixture(t); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'fork', type: 'fork', branches: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], x: 0, y: 0 },
      { id: 'one', type: 'ask', roleId: 'developer', instructions: 'A', x: 0, y: 0 }, { id: 'two', type: 'ask', roleId: 'developer', instructions: 'B', x: 0, y: 0 }],
    edges: [{ id: 's-f', from: 's', outcome: 'next', to: 'fork' }, { id: 'f-a', from: 'fork', outcome: 'a', to: 'one' }, { id: 'f-b', from: 'fork', outcome: 'b', to: 'two' }] }
  const run = f.store.createRun('Goal', undefined, workflow); await f.resources.ensureRunBranch(f.store, f.root, run.id)
  let release!: () => void; let enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve }); const entered = new Promise<void>(resolve => { enter = resolve })
  const deps = { ...f.deps, startWorker: async () => { enter(); await held; return { ptyId: 'p', dispatchId: 'd' } } }
  const rejected = assert.rejects(f.workflow.run.startRunWorkflow(deps, run.id), stale)
  await entered; run.stage!.visits.two = 2
  const before = structuredClone(f.store.snapshot()); release(); await rejected
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.store.listTasks().filter(task => task.stageOf?.nodeId === 'two').length, 0)
})

test('run transition captures new visit before handing its Promise back to effects', async t => {
  const f = fixture(t); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'ask', type: 'ask', roleId: 'developer', instructions: 'Ask', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'ask' }] }
  const run = f.store.createRun('Goal', undefined, workflow); await f.resources.ensureRunBranch(f.store, f.root, run.id)
  let changed = false
  f.store.subscribe(() => { if (run.stage?.nodeId === 'ask' && !changed) { changed = true; queueMicrotask(() => { run.stage!.visits.ask = 2 }) } })
  await assert.rejects(f.workflow.run.startRunWorkflow(f.deps, run.id), stale)
  assert.equal(run.stage!.visits.ask, 2); assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.snapshot().dispatches.length, 0)
})

for (const mutation of ['registration', 'visit'] as const) test(`return attachments: ${mutation} during placement handoff prevents files and apply`, async t => {
  const f = fixture(t); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'work', type: 'work', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'work' }] }
  const run = f.store.createRun('Goal', undefined, workflow); const g = await f.resources.ensureRunBranch(f.store, f.root, run.id)
  f.store.enterRunStage(run.id)
  const attachments = createAttachmentServices({ effects: f.resources.effects, messages: { error: key => new Error(key) }, logger: { warn: () => {} },
    branches: { ensureRunBranch: async (...args) => {
      const result = await f.resources.ensureRunBranch(...args)
      queueMicrotask(() => { if (mutation === 'registration') f.unregister(); else run.stage!.visits.work = 2 })
      return result
    } } })
  const before = structuredClone(f.store.snapshot())
  await assert.rejects(attachments.returnRunWithImages(f.store, f.root, run.id,
    [{ name: 'note.txt', mime: 'text/plain', data: new TextEncoder().encode('note') }], 'Feedback', () => {
      f.store.updateGlobalTask(run.id, { description: 'late apply' }); return 'changed'
    }, f.deps), stale)
  assert.equal(run.objective, 'Goal')
  if (mutation === 'registration') assert.deepEqual(f.store.snapshot(), before)
  assert.equal(existsSync(join(f.resources.attachmentsRoot(g!.worktree!), run.id, 'returns')), false)
})
