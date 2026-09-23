// Запуск: pnpm --filter @orca-board/desktop test. Приёмка задачи на настоящем git-репозитории.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { acceptReview, resolveHumanRequest } from './review'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-review-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Задача-ответ для человека, сданная воркером, с worktree на ветке orca/<id>. */
function answerTask(store: TaskStore) {
  const task = store.createTask({ title: 'Макеты', answerFor: 'human' })
  const branch = `orca/${task.id}`
  const worktree = path.join(tmp, task.id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
  store.updateTask(task.id, { worktree, branch })
  const d = store.startDispatch(task.id, 'pty')
  store.finishDispatch(d.id, 'суть', [], 'ответ')
  return { task, branch, worktree }
}

const branchExists = (branch: string): boolean => git(repo, 'branch', '--list', branch) !== ''

describe('acceptReview задачи-ответа', () => {
  it('коммиты в ветке сливаются в master, decision уходит в answer_accepted', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch, worktree } = answerTask(store)
    writeFileSync(path.join(worktree, 'mockup.html'), '<p>A</p>\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'макеты')
    writeFileSync(path.join(worktree, 'draft.md'), 'черновик\n')

    acceptReview(store, repo, task.id, 'делаем A')

    assert.equal(existsSync(path.join(repo, 'mockup.html')), true, 'коммит воркера в master')
    assert.equal(existsSync(path.join(repo, 'draft.md')), false, 'незакоммиченный черновик не сливается')
    assert.equal(branchExists(branch), false)
    assert.equal(existsSync(worktree), false)
    assert.equal(store.getTask(task.id)!.status, 'done')
    const e = store.listEvents().find((x) => x.type === 'answer_accepted')!
    assert.equal(e.payload.decision, 'делаем A')
  })

  it('без коммитов — ветка и worktree просто удаляются, master не меняется', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch, worktree } = answerTask(store)
    const head = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(path.join(worktree, 'draft.md'), 'черновик\n')

    acceptReview(store, repo, task.id)

    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
    assert.equal(branchExists(branch), false)
    assert.equal(store.getTask(task.id)!.status, 'done')
  })

  it('конфликт мержа — ошибка, ветка с коммитами сохранена, задача не в done', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch, worktree } = answerTask(store)
    writeFileSync(path.join(worktree, 'README.md'), 'из ветки\n')
    git(worktree, 'commit', '-qam', 'ветка')
    writeFileSync(path.join(repo, 'README.md'), 'из master\n')
    git(repo, 'commit', '-qam', 'master')

    assert.throws(() => acceptReview(store, repo, task.id), /мерж не удался/)

    assert.equal(branchExists(branch), true)
    assert.equal(existsSync(worktree), true)
    assert.equal(store.getTask(task.id)!.status, 'needs_input')
  })
})

describe('resolveHumanRequest', () => {
  const answerRequest = (store: TaskStore, taskId: string) => store.pendingRequests().find((r) => r.taskId === taskId && r.kind === 'answer')!
  const noStart = (): never => assert.fail('воркер не должен стартовать')

  it('accept — приёмка с git-частью, решение уходит в answer_accepted, запрос решён', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch } = answerTask(store)
    const req = answerRequest(store, task.id)

    const out = resolveHumanRequest(store, repo, req.id, { action: 'accept', text: 'делаем B' }, noStart)

    assert.equal(out.request.status, 'resolved')
    assert.equal(branchExists(branch), false)
    assert.equal(store.getTask(task.id)!.status, 'done')
    assert.equal(store.listEvents().find((e) => e.type === 'answer_accepted')!.payload.decision, 'делаем B')
    assert.throws(() => resolveHumanRequest(store, repo, req.id, { action: 'accept' }, noStart), /уже решено/)
  })

  it('clarify — сразу стартует воркера', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task } = answerTask(store)
    const started: string[] = []
    const out = resolveHumanRequest(store, repo, answerRequest(store, task.id).id, { action: 'clarify', text: 'подробнее' }, (id) => {
      started.push(id)
      return { ptyId: 'p2', dispatchId: 'd2' }
    })
    assert.deepEqual(started, [task.id])
    assert.deepEqual(out.worker, { ptyId: 'p2', dispatchId: 'd2' })
    assert.equal(store.getTask(task.id)!.feedback, 'подробнее')
  })

  it('старт после clarify упал — запрос решён, задача в ready, координатору escalation с причиной', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task } = answerTask(store)
    const req = answerRequest(store, task.id)
    const out = resolveHumanRequest(store, repo, req.id, { action: 'clarify', text: 'подробнее' }, () => {
      throw new Error('агент выключен')
    })
    assert.equal(out.startError, 'агент выключен')
    assert.equal(store.getRequest(req.id)!.status, 'resolved')
    assert.equal(store.getTask(task.id)!.status, 'ready')
    const esc = store.listEvents().filter((e) => e.type === 'escalation').at(-1)!
    assert.equal(esc.taskId, task.id)
    assert.match(String(esc.payload.reason), /не запустился: агент выключен/)
    assert.equal(esc.payload.requestId, req.id)
  })
})
