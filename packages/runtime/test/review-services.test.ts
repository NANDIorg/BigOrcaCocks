import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { workflowMessages, workflowResources, WorkflowHostError } from './workflow-test-host.ts'

let dir: string
let repo: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-review-')))
  repo = join(dir, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fixture(language = 'ru') {
  assert.equal(typeof runtime.createReviewServices, 'function', 'Review работает без Desktop')
  const service = runtime.createReviewServices({ resources: workflowResources, messages: workflowMessages(language) })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  return { service, store }
}

function answerTask(store: TaskStore) {
  const task = store.createTask({ title: 'Answer', roleId: 'developer', answerFor: 'human' })
  const branch = `orca/${task.id}`; const worktree = join(dir, task.id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
  store.updateTask(task.id, { worktree, branch })
  const dispatch = store.startDispatch(task.id, 'pty_old')
  store.finishDispatch(dispatch.id, 'Answer summary', [], 'Answer body')
  const request = store.pendingRequests().find(request => request.taskId === task.id)!
  assert.ok(request)
  return { task, worktree, branch, request }
}

it('общая приёмка сливает в ветку прогона, сохраняя master', () => {
  const f = fixture(); const run = f.store.createGlobalTask({ title: 'Feature' })
  const runGit = workflowResources.ensureRunBranch(f.store, repo, run.id)!
  const task = f.store.createTask({ title: 'Work', roleId: 'developer', runId: run.id })
  const branch = `orca/${task.id}`; const worktree = join(dir, task.id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, runGit.branch)
  f.store.updateTask(task.id, { branch, worktree })
  writeFileSync(join(worktree, 'feature.txt'), 'result\n')
  const head = git(repo, 'rev-parse', 'master')
  f.service.acceptReview(f.store, repo, task.id, undefined, task => workflowResources.mergeTarget(f.store, repo, task))
  assert.equal(readFileSync(join(runGit.worktree!, 'feature.txt'), 'utf8'), 'result\n')
  assert.equal(git(repo, 'rev-parse', 'master'), head)
  assert.equal(f.store.getTask(task.id)?.status, 'done')
  assert.equal(existsSync(worktree), false)
  assert.equal(git(repo, 'branch', '--list', branch), '')
})

it('пропавшая цель отвергается до коммита хвостов и удаления работы', () => {
  const f = fixture(); const task = f.store.createTask({ title: 'Work' })
  const branch = `orca/${task.id}`; const worktree = join(dir, task.id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
  writeFileSync(join(worktree, 'tail.txt'), 'uncommitted\n')
  const before = git(repo, 'rev-parse', branch)
  assert.throws(() => f.service.mergeTaskBranch(repo, { title: task.title, branch, worktree }, { cwd: repo, branch: 'feature/missing' }),
    e => e instanceof WorkflowHostError && e.key === 'git.mergeTargetMissing')
  assert.equal(git(repo, 'rev-parse', branch), before)
  assert.equal(git(worktree, 'status', '--porcelain'), '?? tail.txt')
  assert.equal(readFileSync(join(worktree, 'tail.txt'), 'utf8'), 'uncommitted\n')
})

it('устаревший ответ не принимается и не меняет Git/store', () => {
  const f = fixture(); const { task, branch, worktree } = answerTask(f.store)
  writeFileSync(join(worktree, 'tail.txt'), 'keep\n')
  f.store.reopenTask(task.id, 'retry'); f.store.startDispatch(task.id, 'pty_new')
  const before = structuredClone(f.store.snapshot()); const head = git(repo, 'rev-parse', branch)
  assert.throws(() => f.service.acceptReview(f.store, repo, task.id))
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(git(repo, 'rev-parse', branch), head)
  assert.equal(readFileSync(join(worktree, 'tail.txt'), 'utf8'), 'keep\n')
})

it('повтор решённого запроса отказывает до запуска и правки store', () => {
  const f = fixture(); const { request } = answerTask(f.store)
  f.store.resolveRequest(request.id, { action: 'clarify', text: 'fix' })
  const before = structuredClone(f.store.snapshot()); let starts = 0
  assert.throws(() => f.service.resolveHumanRequest(f.store, repo, request.id, { action: 'clarify', text: 'again' }, () => {
    starts++; return { ptyId: 'pty_again', dispatchId: 'disp_again' }
  }), e => e instanceof WorkflowHostError && e.key === 'request.alreadyResolved')
  assert.deepEqual(f.store.snapshot(), before); assert.equal(starts, 0)
})

it('отказ старта возвращает перевод для UI и исходную причину в escalation', () => {
  const f = fixture('en'); const { task, request } = answerTask(f.store)
  const error = new WorkflowHostError('review.stageBlocked', { reason: 'native failure' })
  const result = f.service.resolveHumanRequest(f.store, repo, request.id, { action: 'clarify', text: 'fix' }, () => { throw error })
  assert.equal(result.startError, 'en:translated:review.stageBlocked')
  assert.equal(result.request.status, 'resolved'); assert.equal(result.worker, undefined)
  assert.equal(f.store.getTask(task.id)?.status, 'ready')
  const escalation = f.store.listEvents().filter(event => event.type === 'escalation').at(-1)!
  assert.ok(String(escalation.payload.reason).includes(error.message))
  assert.equal(String(escalation.payload.reason).includes('en:translated'), false)
})

it('два хоста review используют собственные реализации ошибок', () => {
  const a = fixture(); const b = fixture()
  class OtherError extends Error {}
  const other = runtime.createReviewServices({ resources: workflowResources, messages: { ...workflowMessages('en'), error: key => new OtherError(key) } })
  const task = a.store.createTask({ title: 'No branch' })
  assert.throws(() => a.service.getReview(a.store, repo, task.id), e => e instanceof WorkflowHostError && e.key === 'review.noBranch')
  assert.throws(() => other.getReview(a.store, repo, task.id), e => e instanceof OtherError && e.message === 'review.noBranch')
  assert.equal(b.store.listTasks().length, 0)
})
