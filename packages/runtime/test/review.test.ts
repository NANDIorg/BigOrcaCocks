// Запуск: pnpm --filter @orca-board/runtime test. Приёмка задачи на настоящем git-репозитории.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, WORKFLOW_VERSION, type HumanRequest, type Workflow } from '@orca-board/core'
import { createReviewServices } from '../src/index.ts'
import { workflowMessages, workflowResources, WorkflowHostError as OrcaError } from './workflow-test-host.ts'

const { acceptReview, mergeTaskBranch, resolveHumanRequest } = createReviewServices({ resources: workflowResources, messages: workflowMessages() })

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
  it('коммиты в ветке сливаются в master, decision уходит в answer_accepted', async () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch, worktree } = answerTask(store)
    writeFileSync(path.join(worktree, 'mockup.html'), '<p>A</p>\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'макеты')
    writeFileSync(path.join(worktree, 'draft.md'), 'черновик\n')

    await acceptReview(store, repo, task.id, 'делаем A')

    assert.equal(existsSync(path.join(repo, 'mockup.html')), true, 'коммит воркера в master')
    assert.equal(existsSync(path.join(repo, 'draft.md')), false, 'незакоммиченный черновик не сливается')
    assert.equal(branchExists(branch), false)
    assert.equal(existsSync(worktree), false)
    assert.equal(store.getTask(task.id)!.status, 'done')
    const e = store.listEvents().find((x) => x.type === 'answer_accepted')!
    assert.equal(e.payload.decision, 'делаем A')
  })

  it('без коммитов — ветка и worktree просто удаляются, master не меняется', async () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch, worktree } = answerTask(store)
    const head = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(path.join(worktree, 'draft.md'), 'черновик\n')

    await acceptReview(store, repo, task.id)

    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
    assert.equal(branchExists(branch), false)
    assert.equal(store.getTask(task.id)!.status, 'done')
  })

  it('конфликт мержа — ошибка, ветка с коммитами сохранена, задача не в done', async () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch, worktree } = answerTask(store)
    writeFileSync(path.join(worktree, 'README.md'), 'из ветки\n')
    git(worktree, 'commit', '-qam', 'ветка')
    writeFileSync(path.join(repo, 'README.md'), 'из master\n')
    git(repo, 'commit', '-qam', 'master')

    await assert.rejects(async () => await acceptReview(store, repo, task.id), /мерж не удался/)

    assert.equal(branchExists(branch), true)
    assert.equal(existsSync(worktree), true)
    assert.equal(store.getTask(task.id)!.status, 'needs_input')
  })
})

describe('mergeTaskBranch: повтор после сбоя и ошибки git, которые не конфликт', () => {
  /** Рабочая задача с коммитом в своей ветке orca/<id>. */
  function workBranch(id: string, file = 'feature.ts') {
    const branch = `orca/${id}`
    const worktree = path.join(tmp, id)
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
    writeFileSync(path.join(worktree, file), 'из ветки\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'работа')
    return { title: 'Фича', worktree, branch }
  }

  it('папки worktree нет (убрали руками, прошлая попытка) — без ENOENT: закоммиченное слито, ветка убрана', async () => {
    const t = workBranch('t1')
    rmSync(t.worktree, { recursive: true, force: true })
    assert.deepEqual(await mergeTaskBranch(repo, t), { ok: true })
    assert.equal(existsSync(path.join(repo, 'feature.ts')), true)
    assert.equal(branchExists(t.branch), false)
  })

  it('ветку уже слили и удалили (сбой после мержа) — повтор ничего не делает и не падает', async () => {
    const t = workBranch('t2')
    assert.deepEqual(await mergeTaskBranch(repo, t), { ok: true })
    const head = git(repo, 'rev-parse', 'HEAD')
    assert.deepEqual(await mergeTaskBranch(repo, t), { ok: true })
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
  })

  it('занятый index.lock в цели — исключение с текстом git, не conflict; ветка на месте', async () => {
    const t = workBranch('t3')
    const lock = path.join(repo, '.git', 'index.lock')
    writeFileSync(lock, '')
    // Текст зависит от версии git («Unable to create …index.lock» / «Unable to write index») — важно, что это исключение.
    await assert.rejects(async () => await mergeTaskBranch(repo, t), /мерж не удался:\n.*(index|lock)/)
    rmSync(lock)
    assert.equal(branchExists(t.branch), true)
    assert.equal(existsSync(t.worktree), true)
    assert.deepEqual(await mergeTaskBranch(repo, t), { ok: true }, 'причину убрали — повтор сливает')
    assert.equal(existsSync(path.join(repo, 'feature.ts')), true)
  })

  it('незакоммиченное в цели мешает мержу — исключение, не conflict', async () => {
    const t = workBranch('t4', 'README.md')
    writeFileSync(path.join(repo, 'README.md'), 'правка в master без коммита\n')
    await assert.rejects(async () => await mergeTaskBranch(repo, t), /мерж не удался/)
    assert.equal(branchExists(t.branch), true)
  })

  it('настоящий конфликт — conflict с текстом, слияние отменено', async () => {
    const t = workBranch('t5', 'README.md')
    writeFileSync(path.join(repo, 'README.md'), 'из master\n')
    git(repo, 'commit', '-qam', 'master')
    const result = await mergeTaskBranch(repo, t)
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.conflict, true)
    assert.equal(git(repo, 'status', '--porcelain'), '', 'merge --abort вернул цель в чистое состояние')
  })
})

describe('resolveHumanRequest', () => {
  const answerRequest = (store: TaskStore, taskId: string) => store.pendingRequests().find((r) => r.taskId === taskId && r.kind === 'answer')!
  const noStart = (): never => assert.fail('воркер не должен стартовать')

  it('accept — приёмка с git-частью, решение уходит в answer_accepted, запрос решён', async () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task, branch } = answerTask(store)
    const req = answerRequest(store, task.id)

    const out = await resolveHumanRequest(store, repo, req.id, { action: 'accept', text: 'делаем B' }, noStart)

    assert.equal(out.request.status, 'resolved')
    assert.equal(branchExists(branch), false)
    assert.equal(store.getTask(task.id)!.status, 'done')
    assert.equal(store.listEvents().find((e) => e.type === 'answer_accepted')!.payload.decision, 'делаем B')
    await assert.rejects(async () => await resolveHumanRequest(store, repo, req.id, { action: 'accept' }, noStart), e => e instanceof OrcaError && e.key === 'request.alreadyResolved')
  })

  it('clarify — сразу стартует воркера', async () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task } = answerTask(store)
    const started: string[] = []
    const out = await resolveHumanRequest(store, repo, answerRequest(store, task.id).id, { action: 'clarify', text: 'подробнее' }, (id) => {
      started.push(id)
      return { ptyId: 'p2', dispatchId: 'd2' }
    })
    assert.deepEqual(started, [task.id])
    assert.deepEqual(out.worker, { ptyId: 'p2', dispatchId: 'd2' })
    assert.equal(store.getTask(task.id)!.feedback, 'подробнее')
  })

  it('старт после clarify упал — запрос решён, задача в ready, координатору escalation с причиной', async () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const { task } = answerTask(store)
    const req = answerRequest(store, task.id)
    const out = await resolveHumanRequest(store, repo, req.id, { action: 'clarify', text: 'подробнее' }, () => {
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

  it('decision — выбор ветки: запрос решён, колбэк approved двигает граф (движок прогона), воркер не стартует', async () => {
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [
        { id: 'start', x: 0, y: 0, type: 'start' },
        { id: 'fork', x: 0, y: 0, type: 'decision', question: 'Нужен ли дизайн?', roleId: 'developer', options: [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }] },
        { id: 'end', x: 0, y: 0, type: 'end' }
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'fork' },
        { id: 'e2', from: 'fork', outcome: 'yes', to: 'end' },
        { id: 'e3', from: 'fork', outcome: 'no', to: 'end' }
      ]
    }
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель', undefined, wf)
    store.enterRunStage(run.id, { roleIds: ['developer'] })
    const req = store.requestRunDecision(run.id, { nodeId: 'fork', title: 'Нужен ли дизайн?', fallback: 'unsure', options: [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }] })
    const seen: HumanRequest[] = []
    const out = await resolveHumanRequest(store, repo, req.id, { action: 'answer', optionId: 'no', text: 'макет есть' }, noStart, (r) => seen.push(r))
    assert.equal(out.request.status, 'resolved')
    assert.deepEqual(seen.map((r) => [r.id, r.resolution?.optionId]), [[req.id, 'no']])
    assert.equal(out.worker, undefined)
  })
})

describe('мерж в репозиторий без коммитов', () => {
  it('mergeTaskBranch на unborn-корне бросает git.noCommits до коммита и удаления: ветка и её коммиты на месте', async () => {
    const empty = path.join(tmp, 'empty')
    execFileSync('git', ['init', '-q', '-b', 'main', empty])
    // Ветка воркера без базы — как было до фикса: `worktree add -b` в unborn-корне даёт сироту, воркер в ней коммитит.
    const worktree = path.join(tmp, 'wt')
    git(empty, 'worktree', 'add', '-q', '-b', 'orca/t1', worktree)
    writeFileSync(path.join(worktree, 'work.txt'), 'работа\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'работа воркера')
    writeFileSync(path.join(worktree, 'tail.txt'), 'хвост\n')
    const sha = git(empty, 'rev-parse', 'orca/t1')

    await assert.rejects(
      async () => await mergeTaskBranch(empty, { title: 'T', worktree, branch: 'orca/t1' }),
      (e: unknown) => e instanceof OrcaError && e.key === 'git.noCommits'
    )
    assert.equal(git(empty, 'rev-parse', 'orca/t1'), sha, 'ветка воркера не удалена и не сдвинута')
    assert.equal(existsSync(worktree), true)
    assert.equal(git(worktree, 'status', '--porcelain'), '?? tail.txt', 'хвосты не закоммичены')
  })

  it('пропавшая целевая ветка — git.mergeTargetMissing, ничего не удалено', async () => {
    const worktree = path.join(tmp, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'orca/t2', worktree)
    writeFileSync(path.join(worktree, 'work.txt'), 'работа\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'работа')
    await assert.rejects(
      async () => await mergeTaskBranch(repo, { title: 'T', worktree, branch: 'orca/t2' }, { cwd: repo, branch: 'feature/gone' }),
      (e: unknown) => e instanceof OrcaError && e.key === 'git.mergeTargetMissing'
    )
    assert.equal(branchExists('orca/t2'), true)
    assert.equal(existsSync(worktree), true)
  })
})
