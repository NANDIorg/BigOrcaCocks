import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, type Workflow, type WfNode, type WfEdge } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import type { RunWorkflowDeps } from '../src/workflow-run.ts'
import { workflowMessages, workflowResources, WorkflowHostError } from './workflow-test-host.ts'

let dir: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-run-workflow-'))) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const node = (n: Partial<WfNode> & { id: string; type: WfNode['type'] }): WfNode => ({ x: 0, y: 0, ...n }) as WfNode
const edge = (from: string, outcome: WfEdge['outcome'], to: string): WfEdge => ({ id: `${from}_${outcome}`, from, outcome, to })
function fork(left: WfNode['type'] = 'human', right: WfNode['type'] = 'human'): Workflow {
  return { version: 2, nodes: [node({ id: 'start', type: 'start' }),
    node({ id: 'fork', type: 'fork', branches: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }] }),
    node({ id: 'left', type: left, roleId: 'reviewer' }), node({ id: 'right', type: right, roleId: 'reviewer' }),
    node({ id: 'join', type: 'join', forkId: 'fork' }), node({ id: 'end', type: 'end' })],
    edges: [edge('start', 'next', 'fork'), edge('fork', 'left', 'left'), edge('fork', 'right', 'right'),
      edge('left', left === 'human' || left === 'gate' ? 'accept' : 'next', 'join'),
      edge('right', right === 'human' || right === 'gate' ? 'accept' : 'next', 'join'), edge('join', 'next', 'end')] }
}
function single(n: WfNode, retry = false): Workflow {
  return { version: 2, nodes: [node({ id: 'start', type: 'start' }), n, node({ id: 'end', type: 'end' })],
    edges: [edge('start', 'next', n.id), edge(n.id, n.type === 'gate' ? 'accept' : n.type === 'decision' ? 'yes' : 'next', 'end'),
      ...(retry ? [edge(n.id, 'reject', n.id)] : [])] }
}
function fixture(wf: Workflow, label = 'one', language = 'ru', failNode?: string) {
  assert.equal(typeof runtime.createRunWorkflowServices, 'function', 'Run workflow работает без Desktop')
  const repo = join(dir, label); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
  const messages = workflowMessages(language)
  const review = runtime.createReviewServices({ resources: workflowResources, messages })
  const workflow = runtime.createTaskWorkflowServices({ resources: workflowResources, review, messages })
  const service = runtime.createRunWorkflowServices({ resources: workflowResources, workflow, messages })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const starts: string[] = []
  const deps: RunWorkflowDeps = { store, repoRoot: repo, run: () => ({ roles: DEFAULT_ROLES }), isAlive: () => true,
    startCoordinator: () => {},
    startWorker(taskId) {
      const task = store.getTask(taskId)!
      if ((task.gateFor?.nodeId ?? task.stageOf?.nodeId) === failNode) throw new Error('agent unavailable')
      workflow.enterWork(deps, taskId)
      const branch = task.branch ?? `orca/${taskId}`; const worktree = task.worktree ?? join(dir, `${label}_${taskId}`)
      const base = workflowResources.ensureRunBranch(store, repo, task.runId)
      if (!existsSync(worktree)) git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, ...(base ? [base.branch] : []))
      store.updateTask(taskId, { branch, worktree }); starts.push(taskId)
      const dispatch = store.startDispatch(taskId, `pty_${taskId}_${starts.length}`, undefined, { roleId: task.roleId })
      return { ptyId: dispatch.ptyId, dispatchId: dispatch.id }
    }, mergeTarget: task => workflowResources.mergeTarget(store, repo, task) }
  const run = store.createGlobalTask({ title: label, workflow: wf })
  workflowResources.ensureRunBranch(store, repo, run.id)
  store.setRunPty(run.id, `coordinator_${label}`)
  service.startRunWorkflow(deps, run.id)
  return { service, workflow, review, store, deps, run, starts, repo }
}

it('два approval пути: неоднозначная карточка без мутаций, решение двигает только свой путь', () => {
  const f = fixture(fork()); const requests = f.store.pendingRequests(f.run.id)
  assert.equal(requests.length, 2)
  const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.service.acceptRun(f.deps, f.run.id), e => e instanceof WorkflowHostError && e.key === 'global.approvalAmbiguous')
  assert.deepEqual(f.store.snapshot(), before)
  const request = requests.find(r => r.nodeId === 'left')!
  f.review.resolveHumanRequest(f.store, f.repo, request.id, { action: 'accept' }, f.deps.startWorker,
    request => f.service.handleRunRequest(f.deps, request), f.deps.mergeTarget)
  assert.equal(f.store.pendingRequests(f.run.id).length, 1)
  assert.equal(f.store.pendingRequests(f.run.id)[0].nodeId, 'right')
  assert.equal(f.store.getRun(f.run.id)?.lanes?.find(l => l.branchId === 'right')?.nodeId, 'right')
})
it('повтор после восстановления не создаёт второй gate или ask и не запускает воркеры ещё раз', () => {
  const f = fixture(fork('gate', 'ask')); const before = structuredClone(f.store.snapshot()); const starts = [...f.starts]
  f.service.startRunWorkflow(f.deps, f.run.id)
  assert.deepEqual(f.store.snapshot(), before)
  assert.deepEqual(f.starts, starts)
  assert.equal(starts.length, 2)
})
it('повтор human effects сохраняет единственный approval на каждый путь', () => {
  const f = fixture(fork()); const before = structuredClone(f.store.snapshot())
  f.service.startRunWorkflow(f.deps, f.run.id)
  assert.deepEqual(f.store.snapshot(), before)
})
it('ответ заменённому gate не двигает новую проверку', () => {
  const f = fixture(single(node({ id: 'gate', type: 'gate', roleId: 'reviewer' }), true))
  const gate = f.store.listTasks().find(t => t.gateFor)!
  f.service.runGateDecision(f.deps, gate.id, 'reject', 'retry')
  assert.equal(f.store.listTasks().filter(t => t.gateFor).length, 2)
  const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.service.runGateDecision(f.deps, gate.id, 'accept'), /уже не актуальна/)
  assert.deepEqual(f.store.snapshot(), before)
})
it('повтор решения decision не двигает завершённый граф', () => {
  const f = fixture(single(node({ id: 'decision', type: 'decision', roleId: 'reviewer', question: 'Ready?', options: [{ id: 'yes', label: 'Yes' }] })))
  const decider = f.store.listTasks().find(t => t.gateFor?.nodeId === 'decision')!
  f.service.runDecision(f.deps, decider.id, 'yes', 'ready')
  const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.service.runDecision(f.deps, decider.id, 'yes', 'late'), /уже принято/)
  assert.deepEqual(f.store.snapshot(), before)
})
it('два экземпляра services независимо выбирают язык approval и свой store', () => {
  const a = fixture(fork(), 'a', 'ru'); const b = fixture(fork(), 'b', 'en')
  assert.ok(a.store.pendingRequests().every(r => r.title.startsWith('ru:runApproval.laneTitle')))
  assert.ok(b.store.pendingRequests().every(r => r.title.startsWith('en:runApproval.laneTitle')))
  const before = structuredClone(b.store.snapshot())
  a.review.resolveHumanRequest(a.store, a.repo, a.store.pendingRequests()[0].id, { action: 'accept' }, a.deps.startWorker,
    request => a.service.handleRunRequest(a.deps, request), a.deps.mergeTarget)
  assert.deepEqual(b.store.snapshot(), before)
})
it('ошибка запуска worker одного пути не блокирует эффекты соседнего', () => {
  const f = fixture(fork('gate', 'ask'), 'one', 'ru', 'left')
  const other = f.store.listTasks().find(t => t.stageOf?.nodeId === 'right')!
  assert.ok(other.dispatchId)
  assert.ok(f.starts.includes(other.id))
  assert.ok(f.store.listEvents().some(e => e.type === 'workflow_blocked' && String(e.payload.reason).includes('agent unavailable')), 'сбой остановил свой путь с причиной')
})
