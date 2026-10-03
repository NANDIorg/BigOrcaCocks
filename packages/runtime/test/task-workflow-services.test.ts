import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, WORKFLOW_VERSION_TASK_SCOPE, type Workflow } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import type { WorkflowDeps } from '../src/workflow.ts'
import { workflowMessages, workflowResources, WorkflowHostError } from './workflow-test-host.ts'

let dir: string
let repo: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-task-workflow-')))
  repo = join(dir, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function graph(human = true, merge = true): Workflow {
  const path = ['start', 'work', ...(human ? ['human'] : []), ...(merge ? ['merge'] : []), 'end']
  return {
    version: WORKFLOW_VERSION_TASK_SCOPE,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 }, { id: 'work', type: 'work', x: 0, y: 0 },
      ...(human ? [{ id: 'human', type: 'human' as const, x: 0, y: 0 }] : []),
      ...(merge ? [{ id: 'merge', type: 'merge' as const, x: 0, y: 0 }] : []),
      { id: 'end', type: 'end', x: 0, y: 0, merged: merge }
    ],
    edges: path.slice(0, -1).map((from, i) => ({ id: `edge_${i}`, from, to: path[i + 1], outcome: from === 'human' ? 'accept' : from === 'merge' ? 'ok' : 'next' }))
  }
}

function fixture(wf = graph()) {
  assert.equal(typeof runtime.createTaskWorkflowServices, 'function', 'Task workflow работает без Desktop')
  const messages = workflowMessages()
  const review = runtime.createReviewServices({ resources: workflowResources, messages })
  const service = runtime.createTaskWorkflowServices({ resources: workflowResources, review, messages })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const run = store.createRun('Goal', undefined, wf)
  const deps: WorkflowDeps = {
    store, repoRoot: repo, run: () => ({ roles: DEFAULT_ROLES, workflow: wf }),
    startWorker(taskId, opts) {
      service.enterWork(deps, taskId)
      const task = store.getTask(taskId)!
      const branch = task.branch ?? `orca/${taskId}`; const worktree = task.worktree ?? join(dir, taskId)
      if (!existsSync(worktree)) git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
      store.updateTask(taskId, { branch, worktree })
      const dispatch = store.startDispatch(taskId, `pty_${taskId}`, undefined, { roleId: opts?.roleId ?? task.roleId })
      return { ptyId: dispatch.ptyId, dispatchId: dispatch.id }
    }
  }
  const task = store.createTask({ title: 'Work', roleId: 'developer', runId: run.id })
  const started = deps.startWorker(task.id)
  const done = () => {
    const before = store.listEvents().length
    store.finishDispatch(store.getTask(task.id)!.dispatchId!, 'result', [])
    return store.listEvents().slice(before)
  }
  return { service, review, store, deps, task, started, done }
}

it('общий граф проводит done → человек → приёмка → мерж → конец', () => {
  const f = fixture(); const worktree = f.store.getTask(f.task.id)!.worktree!
  writeFileSync(join(worktree, 'result.txt'), 'done\n')
  f.service.handleWorkflowEvents(f.deps, f.done())
  assert.equal(f.store.getTask(f.task.id)?.stage?.nodeId, 'human')
  const request = f.store.pendingRequests().find(request => request.taskId === f.task.id)!
  f.review.resolveHumanRequest(f.store, repo, request.id, { action: 'accept' }, f.deps.startWorker,
    request => f.service.approvalResolved(f.deps, request))
  assert.equal(f.store.getTask(f.task.id)?.status, 'done')
  assert.equal(readFileSync(join(repo, 'result.txt'), 'utf8'), 'done\n')
  assert.equal(existsSync(worktree), false)
  assert.equal(f.store.pendingRequests().length, 0)
})

it('done старого dispatch не продвигает этап нового запуска', () => {
  const f = fixture(); const old = f.done()
  f.store.reopenTask(f.task.id, 'retry'); f.deps.startWorker(f.task.id)
  const before = structuredClone(f.store.snapshot())
  f.service.handleWorkflowEvents(f.deps, old)
  assert.deepEqual(f.store.snapshot(), before)
})

it('добор потерянного done после рестарта создаёт единственный approval', () => {
  const f = fixture(); f.done()
  f.service.resumeStuckStages(f.deps)
  assert.equal(f.store.getTask(f.task.id)?.stage?.nodeId, 'human')
  assert.equal(f.store.pendingRequests().length, 1)
  const before = structuredClone(f.store.snapshot())
  f.service.resumeStuckStages(f.deps)
  assert.deepEqual(f.store.snapshot(), before)
})

it('остановленный этап ждёт решения человека при доборе после рестарта', () => {
  const f = fixture(); f.done(); f.store.blockStage(f.task.id, 'fix the graph')
  const before = structuredClone(f.store.snapshot())
  f.service.resumeStuckStages(f.deps)
  assert.deepEqual(f.store.snapshot(), before)
})

it('конец без мержа сохраняет закоммиченную ветку и не меняет master', () => {
  const f = fixture(graph(false, false)); const task = f.store.getTask(f.task.id)!
  const head = git(repo, 'rev-parse', 'master')
  writeFileSync(join(task.worktree!, 'result.txt'), 'saved\n')
  f.service.handleWorkflowEvents(f.deps, f.done())
  assert.equal(f.store.getTask(task.id)?.status, 'done')
  assert.equal(git(repo, 'rev-parse', 'master'), head)
  assert.equal(git(repo, 'show', `${task.branch}:result.txt`), 'saved')
  assert.equal(existsSync(task.worktree!), false)
  assert.equal(f.store.getTask(task.id)?.branch, task.branch)
})

it('приёмка работающего этапа возвращает код хоста до мутаций', () => {
  const f = fixture(); const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.service.reviewAccept(f.deps, f.task.id), e => e instanceof WorkflowHostError && e.key === 'review.notReviewable')
  assert.deepEqual(f.store.snapshot(), before)
})

it('повтор остановленного мержа возвращает stageBlocked, сохраняя работу', () => {
  const f = fixture(graph(false)); const task = f.store.getTask(f.task.id)!
  f.deps.mergeTarget = () => { throw new Error('target missing') }
  writeFileSync(join(task.worktree!, 'result.txt'), 'keep\n')
  f.service.handleWorkflowEvents(f.deps, f.done())
  assert.equal(f.store.getTask(task.id)?.stage?.nodeId, 'merge')
  assert.throws(() => f.service.reviewAccept(f.deps, task.id), e => e instanceof WorkflowHostError && e.key === 'review.stageBlocked')
  assert.equal(readFileSync(join(task.worktree!, 'result.txt'), 'utf8'), 'keep\n')
  assert.equal(git(repo, 'status', '--porcelain'), '')
})
