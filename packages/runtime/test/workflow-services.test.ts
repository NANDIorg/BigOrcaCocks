import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, type Workflow, type WfNode, type WfEdge } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import type { RunWorkflowDeps } from '../src/workflow-run.ts'
import { workflowMessages, workflowResources, WorkflowHostError } from './workflow-test-host.ts'

let dir: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-workflow-binding-'))) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const node = (n: Partial<WfNode> & { id: string; type: WfNode['type'] }): WfNode => ({ x: 0, y: 0, ...n }) as WfNode
const edge = (from: string, outcome: WfEdge['outcome'], to: string): WfEdge => ({ id: `${from}_${outcome}`, from, outcome, to })
const taskGraph = (): Workflow => ({ version: 1, nodes: [node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' }),
  node({ id: 'human', type: 'human' }), node({ id: 'merge', type: 'merge' }), node({ id: 'end', type: 'end' })],
  edges: [edge('start', 'next', 'work'), edge('work', 'next', 'human'), edge('human', 'accept', 'merge'), edge('human', 'reject', 'work'), edge('merge', 'ok', 'end')] })
const runGraph = (gate = false): Workflow => ({ version: 2, nodes: [node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' }),
  ...(gate ? [node({ id: 'gate', type: 'gate', roleId: 'reviewer' })] : []), node({ id: 'human', type: 'human' }), node({ id: 'end', type: 'end' })],
  edges: [edge('start', 'next', 'work'), edge('work', 'next', gate ? 'gate' : 'human'),
    ...(gate ? [edge('gate', 'accept', 'human')] : []), edge('human', 'accept', 'end')] })
function fixture(label = 'one') {
  assert.equal(typeof runtime.createWorkflowServices, 'function', 'Единый API доступен общему host')
  const repo = join(dir, label); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
  const services = runtime.createWorkflowServices({ resources: workflowResources, messages: workflowMessages() })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS); const starts: string[] = []; let targetCalls = 0
  const deps: RunWorkflowDeps = { store, repoRoot: repo, run: () => ({ roles: DEFAULT_ROLES }), isAlive: () => true,
    startCoordinator: () => {}, startWorker(taskId, opts) {
      services.task.enterWork(deps, taskId)
      const task = store.getTask(taskId)!; const base = workflowResources.ensureRunBranch(store, repo, task.runId)
      const branch = task.branch ?? `orca/${taskId}`; const worktree = task.worktree ?? join(dir, `${label}_${taskId}`)
      if (!existsSync(worktree)) git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, ...(base ? [base.branch] : []))
      store.updateTask(taskId, { branch, worktree }); starts.push(taskId)
      const dispatch = store.startDispatch(taskId, `pty_${label}_${starts.length}`, undefined, { roleId: opts?.roleId ?? task.roleId })
      return { ptyId: dispatch.ptyId, dispatchId: dispatch.id }
    }, mergeTarget: task => { targetCalls++; return workflowResources.mergeTarget(store, repo, task) } }
  const binding = services.forProject(deps)
  const done = (taskId: string, deliver = true) => {
    const before = store.listEvents().length
    store.finishDispatch(store.getTask(taskId)!.dispatchId!, 'result', [])
    const events = store.listEvents().slice(before); if (deliver) binding.handleEvents(events)
    return events
  }
  return { repo, services, store, deps, binding, starts, done, targetCalls: () => targetCalls }
}
function legacy(f: ReturnType<typeof fixture>, wf = taskGraph()) {
  const run = f.store.createRun('Legacy', undefined, wf)
  const task = f.store.createTask({ title: 'Task', roleId: 'developer', runId: run.id })
  f.deps.startWorker(task.id)
  return task
}
function global(f: ReturnType<typeof fixture>, wf = runGraph()) {
  const run = f.store.createGlobalTask({ title: 'Global', workflow: wf })
  workflowResources.ensureRunBranch(f.store, f.repo, run.id); f.store.setRunPty(run.id, 'coordinator')
  f.services.run.startRunWorkflow(f.deps, run.id)
  return run
}
it('binding проводит legacy событие и approval через task executor с настоящим merge', () => {
  const f = fixture(); const task = legacy(f); const worktree = f.store.getTask(task.id)!.worktree!
  writeFileSync(join(worktree, 'legacy.txt'), 'legacy\n'); f.done(task.id)
  const request = f.store.pendingRequests()[0]
  assert.equal(f.store.getTask(task.id)?.stage?.nodeId, 'human')
  f.binding.resolveHumanRequest(request.id, { action: 'accept' })
  assert.equal(f.store.getTask(task.id)?.status, 'done')
  assert.equal(readFileSync(join(f.store.getRun(task.runId!)!.git!.worktree!, 'legacy.txt'), 'utf8'), 'legacy\n')
  const before = structuredClone(f.store.snapshot()); const starts = [...f.starts]
  assert.throws(() => f.binding.resolveHumanRequest(request.id, { action: 'accept' }), e => e instanceof WorkflowHostError && e.key === 'request.alreadyResolved')
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(f.starts, starts)
})
it('binding ведёт путь подзадачи и human самого прогона разными executor', () => {
  const f = fixture(); const run = global(f)
  const task = f.store.createTask({ title: 'Path', roleId: 'developer', runId: run.id }); f.deps.startWorker(task.id)
  writeFileSync(join(f.store.getTask(task.id)!.worktree!, 'path.txt'), 'path\n'); f.done(task.id)
  assert.equal(f.store.getTask(task.id)?.status, 'done')
  assert.equal(f.store.getRun(run.id)?.stage?.nodeId, 'work')
  assert.equal(readFileSync(join(f.store.getRun(run.id)!.git!.worktree!, 'path.txt'), 'utf8'), 'path\n')
  f.services.run.finishRunStage(f.deps, run.id)
  f.binding.resolveHumanRequest(f.store.pendingRequests(run.id)[0].id, { action: 'accept' })
  assert.equal(f.store.getRun(run.id)?.status, 'done')
  assert.equal(existsSync(join(f.repo, 'path.txt')), false)
})
it('binding review принимает gate прогона', () => {
  const f = fixture(); const run = global(f, runGraph(true))
  const task = f.store.createTask({ title: 'Path', roleId: 'developer', runId: run.id }); f.deps.startWorker(task.id); f.done(task.id)
  f.services.run.finishRunStage(f.deps, run.id)
  const gate = f.store.listTasks().find(t => t.gateFor?.nodeId === 'gate')!
  f.binding.reviewDecision(gate.id, 'accept', 'ready')
  assert.equal(f.store.getRun(run.id)?.stage?.nodeId, 'human')
  assert.equal(f.store.getTask(gate.id)?.status, 'in_progress', 'завершение worker приходит отдельно')
  f.done(gate.id)
  assert.equal(f.store.getTask(gate.id)?.status, 'done')
})
it('binding decision request выбирает ноду прогона через run executor', () => {
  const f = fixture(); const wf: Workflow = { version: 2, nodes: [node({ id: 'start', type: 'start' }),
    node({ id: 'decision', type: 'decision', roleId: 'reviewer', question: 'Ready?', options: [{ id: 'yes', label: 'Yes' }] }),
    node({ id: 'end', type: 'end' })], edges: [edge('start', 'next', 'decision'), edge('decision', 'yes', 'end')] }
  const run = global(f, wf); const decider = f.store.listTasks().find(t => t.gateFor?.nodeId === 'decision')!
  const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.binding.reviewDecision(decider.id, 'accept'), /decision choose/)
  assert.deepEqual(f.store.snapshot(), before)
  const request = f.services.run.escalateDecision(f.deps, decider.id, 'uncertain')
  f.binding.resolveHumanRequest(request.requestId, { action: 'answer', optionId: 'yes', text: 'ready' })
  assert.equal(f.store.getRun(run.id)?.status, 'done')
  assert.equal(f.store.getRun(run.id)?.stageHistory?.find(s => s.nodeId === 'decision')?.decision?.by, 'human')
})
it('binding добирает потерянный done задачи один раз и принимает review через общий API', () => {
  const f = fixture(); const task = legacy(f); f.done(task.id, false)
  f.binding.resumeStuckStages(); assert.equal(f.store.pendingRequests().length, 1)
  const before = structuredClone(f.store.snapshot()); f.binding.resumeStuckStages(); assert.deepEqual(f.store.snapshot(), before)
  writeFileSync(join(f.store.getTask(task.id)!.worktree!, 'review.txt'), 'review\n')
  f.binding.reviewDecision(task.id, 'accept')
  assert.equal(f.store.getTask(task.id)?.status, 'done')
  assert.equal(readFileSync(join(f.store.getRun(task.runId!)!.git!.worktree!, 'review.txt'), 'utf8'), 'review\n')
})
it('две привязки одного service используют собственные store, Git targets и callbacks', () => {
  const a = fixture('a'); const b = fixture('b'); const bBinding = a.services.forProject(b.deps)
  const ta = legacy(a); const tb = legacy(b); const before = structuredClone(b.store.snapshot())
  writeFileSync(join(a.store.getTask(ta.id)!.worktree!, 'a.txt'), 'a\n'); a.done(ta.id)
  a.binding.resolveHumanRequest(a.store.pendingRequests()[0].id, { action: 'accept' })
  assert.deepEqual(b.store.snapshot(), before); assert.equal(b.targetCalls(), 0); assert.ok(a.targetCalls() > 0)
  b.done(tb.id)
  bBinding.reviewDecision(tb.id, 'reject', 'retry')
  assert.equal(b.starts.length, 2); assert.equal(a.starts.length, 1)
  assert.equal(existsSync(join(b.repo, 'a.txt')), false)
  assert.equal(b.store.getTask(tb.id)?.status, 'in_progress')
})


/** Два gate executor получают события через тот же project binding, что Desktop. */
function gateFixture(scope: 'task' | 'run') {
  const f = fixture()
  let targetId: string
  if (scope === 'task') {
    const wf: Workflow = { version: 1, nodes: [node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' }),
      node({ id: 'gate', type: 'gate', roleId: 'reviewer' }), node({ id: 'end', type: 'end', merged: false })],
      edges: [edge('start', 'next', 'work'), edge('work', 'next', 'gate'), edge('gate', 'accept', 'end')] }
    const task = legacy(f, wf); f.done(task.id); targetId = task.id
  } else {
    const run = global(f, runGraph(true)); targetId = run.id
    const task = f.store.createTask({ title: 'Path', roleId: 'developer', runId: run.id })
    f.deps.startWorker(task.id); f.done(task.id); f.services.run.finishRunStage(f.deps, run.id)
  }
  const gate = f.store.listTasks().find(t => t.gateFor?.nodeId === 'gate')!
  assert.ok(gate)
  const accept = () => f.binding.reviewDecision(scope === 'task' ? targetId : gate.id, 'accept')
  return { ...f, gate, targetId, accept }
}
for (const scope of ['task', 'run'] as const) {
  it(`${scope} gate: старый done не останавливает проверку нового dispatch`, () => {
    const f = gateFixture(scope); const old = f.done(f.gate.id, false)
    const oldDispatch = f.store.getTask(f.gate.id)!.dispatchId!
    f.store.reopenTask(f.gate.id, 'retry'); const next = f.deps.startWorker(f.gate.id)
    assert.notEqual(next.dispatchId, oldDispatch)
    const before = structuredClone(f.store.snapshot())
    f.binding.handleEvents(old)
    assert.deepEqual(f.store.snapshot(), before)
    assert.equal(f.store.getTask(f.gate.id)?.status, 'in_progress')
    assert.ok(existsSync(f.store.getTask(f.gate.id)!.worktree!))
  })
  it(`${scope} gate: старый exit не удаляет worktree нового dispatch после решения`, () => {
    const f = gateFixture(scope); const beforeExit = f.store.listEvents().length
    const dispatch = f.store.getDispatch(f.store.getTask(f.gate.id)!.dispatchId!)!
    f.store.ptyExited(dispatch.ptyId, 1)
    const old = f.store.listEvents().slice(beforeExit).filter(e => e.type === 'escalation')
    assert.equal(old.length, 1)
    f.accept()
    f.store.reopenTask(f.gate.id, 'retry'); const next = f.deps.startWorker(f.gate.id)
    assert.notEqual(next.dispatchId, dispatch.id)
    const worktree = f.store.getTask(f.gate.id)!.worktree!
    const before = structuredClone(f.store.snapshot())
    f.binding.handleEvents(old)
    assert.deepEqual(f.store.snapshot(), before)
    assert.equal(existsSync(worktree), true)
    assert.equal(f.store.getTask(f.gate.id)?.status, 'in_progress')
  })
  it(`${scope} gate: актуальный done без dispatchId сохраняет legacy событие и останавливает gate без решения`, () => {
    const f = gateFixture(scope); const events = f.done(f.gate.id, false).map(e => {
      const { dispatchId: _dispatchId, ...legacyEvent } = e
      return legacyEvent
    })
    f.binding.handleEvents(events)
    const blocks = f.store.listEvents().filter(e => e.type === 'workflow_blocked')
    assert.equal(blocks.length, 1)
    assert.match(String(blocks[0].payload.reason), /сдана без решения/)
    if (scope === 'task') assert.ok(f.store.getTask(f.targetId)?.stageBlock)
    else assert.equal(blocks[0].payload.runId, f.targetId)
  })
}
