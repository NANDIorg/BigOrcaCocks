// Запуск: pnpm --filter @orca-board/desktop test. Картинки к замечаниям при возврате в работу: запись файлов в cwd читателя,
// откат при ошибке, вырезание чужих путей из решения, маршрут «воркер / координатор» и путь до промптов агентов.
// Настоящий TaskStore и временные папки; PTY и electron не участвуют.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, workerTaskPrompt, validateImageAttachments, presetTaskType, runTypeInput, type ImageAttachmentInput } from '@orca-board/core'
import { OrcaError } from './i18n'
import { resumeObjective } from './coordinator-resume'
import {
  ATTACHMENTS_DIR, clearStartImages, coordinatorImagesPlace, discardReturnImages, hasImageInput, imagesReferenced, pruneAttachments,
  rejectWithImages, resolveWithImages, returnRunWithImages, saveReturnImages, stripResolutionImages, withReturnImages, workerImagesPlace,
  writeAttachments
} from './attachments'

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (extra = 0): ImageAttachmentInput => ({ mime: 'image/png', data: Uint8Array.from([...PNG_HEAD, 1, 2, 3, extra]) })
const jpg: ImageAttachmentInput = { mime: 'image/jpeg', data: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]) }

let tmp: string
let repo: string
let store: TaskStore

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-attach-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo })
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const files = (dir: string): string[] => readdirSync(dir).sort()
const returnDirs = (root: string): string[] => (existsSync(root) ? readdirSync(root).filter((n) => n.startsWith('ret_')) : [])

/**
 * Глобальная задача с worktree ветки (папка есть на диске: `ensureRunBranch` ничего не создаёт) и подзадачей на ревью.
 * `scope: 'run'` — с воркфлоу прогона (approval прогона, проверка ветки); граф уже на этапе «Работа».
 */
function setup(opts: { answerFor?: 'human'; scope?: 'run' } = {}) {
  const run = opts.scope === 'run'
    ? store.createGlobalTask({ title: 'G', type: runTypeInput(presetTaskType('general')!) })
    : store.createGlobalTask({ title: 'G' })
  store.setRunPty(run.id, 'pty_c')
  if (opts.scope === 'run') store.enterRunStage(run.id)
  const runTree = mkdtempSync(path.join(tmp, 'run-tree-'))
  store.setRunGit(run.id, { branch: 'feature/g', base: 'master', worktree: runTree })
  const task = store.createTask({ title: 'T', runId: run.id, ...(opts.answerFor ? { answerFor: opts.answerFor } : {}) })
  store.createTask({ title: 'other', runId: run.id })
  const taskTree = mkdtempSync(path.join(tmp, 'task-tree-'))
  store.updateTask(task.id, { worktree: taskTree })
  const d = store.startDispatch(task.id, 'pty_w')
  store.finishDispatch(d.id, 'сделал', [], opts.answerFor ? '# Ответ' : undefined)
  return { run, runTree, task, taskTree }
}

describe('saveReturnImages', () => {
  it('пишет image-N.ext в уникальную ret_* папку внутри .orca-attachments владельца; корень с .gitignore «*»', () => {
    const cwd = path.join(tmp, 'wt')
    mkdirSync(cwd)
    const a = saveReturnImages(cwd, 't1', '', validateImageAttachments([png(), jpg]))
    const b = saveReturnImages(cwd, 't1', '', validateImageAttachments([png(1)]))
    assert.deepEqual(a.map((p) => path.basename(p)), ['image-1.png', 'image-2.jpg'])
    assert.ok(a.every((p) => path.isAbsolute(p) && p.startsWith(path.join(cwd, ATTACHMENTS_DIR, 't1', 'ret_'))))
    assert.notEqual(path.dirname(a[0]), path.dirname(b[0]), 'два возврата — две папки, image-1 не перезаписывается')
    assert.deepEqual(readFileSync(a[0]), Buffer.from([...PNG_HEAD, 1, 2, 3, 0]))
    assert.equal(readFileSync(path.join(cwd, ATTACHMENTS_DIR, '.gitignore'), 'utf8'), '*\n')
  })

  it('подпапка `returns` — для координатора; git status рабочей папки чистый (картинки не попадут в коммит)', () => {
    const [p] = saveReturnImages(repo, 'run_1', 'returns', validateImageAttachments([png()]))
    assert.ok(p.startsWith(path.join(repo, ATTACHMENTS_DIR, 'run_1', 'returns', 'ret_')))
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '')
  })

  it('не удалось записать — OrcaError, чужого не остаётся', () => {
    const cwd = path.join(tmp, 'file-not-dir')
    writeFileSync(cwd, 'x')
    assert.throws(() => saveReturnImages(cwd, 't1', '', validateImageAttachments([png()])), (e) => e instanceof OrcaError && e.key === 'attachments.saveFailed')
  })

  it('discardReturnImages удаляет только папку ret_* из .orca-attachments', () => {
    const cwd = path.join(tmp, 'wt2')
    mkdirSync(cwd)
    const paths = saveReturnImages(cwd, 't1', '', validateImageAttachments([png()]))
    const stranger = path.join(tmp, 'stranger', 'ret_x')
    mkdirSync(stranger, { recursive: true })
    discardReturnImages([path.join(stranger, 'image-1.png')])
    assert.ok(existsSync(stranger), 'чужая ret_ вне .orca-attachments не тронута')
    discardReturnImages(paths)
    assert.equal(returnDirs(path.join(cwd, ATTACHMENTS_DIR, 't1')).length, 0)
  })
})

describe('изображения старта координатора и возвраты рядом', () => {
  it('clearStartImages стирает image-N в корне папки прогона, а returns/ оставляет; whole — папку целиком', () => {
    const cwd = path.join(tmp, 'coord')
    mkdirSync(cwd)
    writeAttachments(path.join(cwd, ATTACHMENTS_DIR), 'run_1', validateImageAttachments([png(), jpg]))
    const [ret] = saveReturnImages(cwd, 'run_1', 'returns', validateImageAttachments([png(2)]))
    const dir = path.join(cwd, ATTACHMENTS_DIR, 'run_1')
    assert.deepEqual(files(dir), ['image-1.png', 'image-2.jpg', 'returns'])
    clearStartImages(path.join(cwd, ATTACHMENTS_DIR), 'run_1')
    assert.deepEqual(files(dir), ['returns'], 'resume координатора не сносит возвраты')
    assert.ok(existsSync(ret))
    clearStartImages(path.join(cwd, ATTACHMENTS_DIR), 'run_1', true)
    assert.equal(existsSync(dir), false)
  })

  it('writeAttachments: сбой посреди записи не трогает возвраты рядом', () => {
    const cwd = path.join(tmp, 'coord2')
    mkdirSync(cwd)
    const root = path.join(cwd, ATTACHMENTS_DIR)
    const [ret] = saveReturnImages(cwd, 'run_1', 'returns', validateImageAttachments([png()]))
    writeAttachments(root, 'run_1', validateImageAttachments([jpg, png()]))
    // image-2.png уже есть: флаг `wx` падает на втором файле, первый (image-1.png) откатывается.
    assert.throws(() => writeAttachments(root, 'run_1', validateImageAttachments([png(), png()])), (e) => e instanceof OrcaError)
    assert.ok(existsSync(ret))
    assert.deepEqual(files(path.join(root, 'run_1')), ['image-1.jpg', 'image-2.png', 'returns'])
  })

  it('pruneAttachments удаляет папки закрытых прогонов с мёртвым координатором (и их возвраты), открытые не трогает', () => {
    const cwd = path.join(tmp, 'coord3')
    mkdirSync(cwd)
    const root = attachmentsRootOf(cwd)
    const open = store.createRun('открытый')
    const closed = store.createRun('закрытый')
    store.closeRun(closed.id)
    for (const id of [open.id, closed.id]) saveReturnImages(cwd, id, 'returns', validateImageAttachments([png()]))
    pruneAttachments(store, root, () => false)
    assert.ok(existsSync(path.join(root, open.id)))
    assert.equal(existsSync(path.join(root, closed.id)), false)
  })
})

function attachmentsRootOf(cwd: string): string {
  saveReturnImages(cwd, '_probe', '', validateImageAttachments([png()]))
  rmSync(path.join(cwd, ATTACHMENTS_DIR, '_probe'), { recursive: true })
  return path.join(cwd, ATTACHMENTS_DIR)
}

describe('withReturnImages', () => {
  const place = (): ReturnType<typeof workerImagesPlace> => ({ cwd: tmp, ownerId: 'o1', subdir: '' })
  const dirs = (): string[] => returnDirs(path.join(tmp, ATTACHMENTS_DIR, 'o1'))

  it('без картинок — apply([]), файлы не создаются, место не вычисляется', () => {
    let placed = false
    const out = withReturnImages(store, () => { placed = true; return place() }, undefined, 'текст', (paths) => paths.length)
    assert.equal(out, 0)
    assert.equal(placed, false)
    assert.equal(existsSync(path.join(tmp, ATTACHMENTS_DIR)), false)
    assert.equal(withReturnImages(store, place, [], 'текст', (paths) => paths.length), 0)
  })

  it('картинки без текста, не массив, не картинка, слишком много — понятные ошибки до записи файлов', () => {
    const key = (input: unknown, text: string | undefined) =>
      (() => withReturnImages(store, place, input, text, () => 1))
    assert.throws(key([png()], '  '), (e) => e instanceof OrcaError && e.key === 'attachments.needText')
    assert.throws(key([png()], undefined), (e) => e instanceof OrcaError && e.key === 'attachments.needText')
    assert.throws(key('картинка', 'т'), (e) => e instanceof OrcaError && e.key === 'attachments.invalid')
    assert.throws(key([{ mime: 'image/png', data: Uint8Array.from([1, 2, 3]) }], 'т'), (e) => e instanceof OrcaError && e.key === 'attachments.invalid')
    assert.throws(key(Array.from({ length: 9 }, () => png()), 'т'), /не больше 8/)
    assert.equal(existsSync(path.join(tmp, ATTACHMENTS_DIR)), false, 'ничего не записано')
  })

  it('apply упал, store не сослался на файлы — папка возврата удалена; сослался — файлы остаются', () => {
    assert.throws(() => withReturnImages(store, place, [png()], 'т', () => { throw new Error('store отказал') }), /store отказал/)
    assert.equal(dirs().length, 0)

    const task = store.createTask({ title: 'T' })
    assert.throws(() => withReturnImages(store, place, [png()], 'т', (paths) => {
      store.rejectReview(task.id, 'т', paths)
      throw new Error('запуск воркера упал')
    }), /запуск воркера упал/)
    assert.equal(dirs().length, 1, 'замечание уже сослалось на файлы — удалять их нельзя')
    assert.ok(imagesReferenced(store, store.getTask(task.id)!.feedbackImages!))
  })
})

describe('workerImagesPlace / coordinatorImagesPlace', () => {
  it('воркер: worktree задачи; нет worktree на диске — attachments.noWorktree', () => {
    const { task, taskTree } = setup()
    assert.deepEqual(workerImagesPlace(store.getTask(task.id)), { cwd: taskTree, ownerId: task.id, subdir: '' })
    rmSync(taskTree, { recursive: true })
    assert.throws(() => workerImagesPlace(store.getTask(task.id)), (e) => e instanceof OrcaError && e.key === 'attachments.noWorktree')
    assert.throws(() => workerImagesPlace(undefined), (e) => e instanceof OrcaError && e.key === 'attachments.noWorktree')
  })

  it('координатор: worktree ветки глобальной задачи; прогон без ветки (работал в корне) — корень репозитория', () => {
    const { run, runTree } = setup()
    assert.deepEqual(coordinatorImagesPlace(store, repo, run.id), { cwd: runTree, ownerId: run.id, subdir: 'returns' })
    const legacy = store.createGlobalTask({ title: 'старая' })
    const t = store.createTask({ title: 'x', runId: legacy.id })
    store.startDispatch(t.id, 'pty_x')
    assert.equal(coordinatorImagesPlace(store, repo, legacy.id).cwd, repo, 'воркеры уже работали в корне — ветку не заводим')
  })
})

describe('resolveWithImages: «Уточнить» и «Вернуть» запроса', () => {
  it('«Уточнить» ответа: файлы в worktree воркера, в решении — пути; воркер увидит их в промпте', () => {
    const { task, taskTree } = setup({ answerFor: 'human' })
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'глубже, см. скриншот' }, [png(), jpg], (r) => store.resolveRequest(req.id, r))
    const images = store.getTask(task.id)!.feedbackImages!
    assert.equal(images.length, 2)
    assert.ok(images.every((p) => p.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_'))))
    assert.deepEqual(store.getRequest(req.id)!.resolution?.images, images)
    const prompt = workerTaskPrompt(store.getTask(task.id)!, 'прошлый ответ')
    for (const p of images) assert.ok(prompt.includes(`\`${p}\``), p)
    assert.ok(images.every((p) => existsSync(p)))
  })

  it('пути из resolution.images, присланные renderer-ом или сокетом, вырезаются — с картинками и без них', () => {
    const { task } = setup({ answerFor: 'human' })
    const forged = ['/etc/passwd']
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'подробнее', images: forged }, undefined, (r) => store.resolveRequest(req.id, r))
    assert.equal(store.getTask(task.id)!.feedbackImages, undefined)
    assert.equal(store.getRequest(req.id)!.resolution?.images, undefined)

    const again = setup({ answerFor: 'human' })
    const req2 = store.pendingRequests().find((r) => r.taskId === again.task.id)!
    resolveWithImages(store, repo, req2.id, { action: 'clarify', text: 'ещё', images: forged }, [png()], (r) => store.resolveRequest(req2.id, r))
    const got = store.getTask(again.task.id)!.feedbackImages!
    assert.equal(got.length, 1)
    assert.ok(!got.includes(forged[0]))
    assert.deepEqual(stripResolutionImages({ action: 'accept' as const, images: forged }), { action: 'accept' })
  })

  it('«Вернуть» approval прогона (без задачи) — файлы в cwd координатора, подпапка returns; «Вернуть» approval задачи — worktree воркера', () => {
    const { run, runTree, task, taskTree } = setup({ scope: 'run' })
    const runReq = store.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    resolveWithImages(store, repo, runReq.id, { action: 'reject', text: 'не так' }, [png()], (r) => store.resolveRequest(runReq.id, r))
    const [c] = store.getRequest(runReq.id)!.resolution!.images!
    assert.ok(c.startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')), c)

    const taskReq = store.requestApproval(task.id, { nodeId: 'review', title: 'Ревью' })
    resolveWithImages(store, repo, taskReq.id, { action: 'reject', text: 'поправь' }, [jpg], (r) => store.resolveRequest(taskReq.id, r))
    const [w] = store.getTask(task.id)!.feedbackImages!
    assert.ok(w.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_')), w)
  })

  it('картинки к «Принять»/«Ответить» — ошибка, запрос остаётся ждать; нет worktree — ошибка до записи в store', () => {
    const { run, task, taskTree } = setup({ answerFor: 'human' })
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    assert.throws(
      () => resolveWithImages(store, repo, req.id, { action: 'accept', text: 'ок' }, [png()], (r) => store.resolveRequest(req.id, r)),
      (e) => e instanceof OrcaError && e.key === 'attachments.notForAction'
    )
    rmSync(taskTree, { recursive: true })
    assert.throws(
      () => resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'подробнее' }, [png()], (r) => store.resolveRequest(req.id, r)),
      (e) => e instanceof OrcaError && e.key === 'attachments.noWorktree'
    )
    assert.equal(store.getRequest(req.id)!.status, 'pending', 'текст остаётся в форме, запрос не решён')
    assert.equal(store.getTask(task.id)!.feedback, undefined)
    assert.ok(store.getRun(run.id))
  })

  it('решённый или несуществующий запрос: обычная ошибка store, файлы не пишутся', () => {
    const { taskTree } = setup({ answerFor: 'human' })
    assert.throws(
      () => resolveWithImages(store, repo, 'req_нет', { action: 'clarify', text: 'т' }, [png()], (r) => store.resolveRequest('req_нет', r)),
      /request not found/
    )
    assert.equal(existsSync(path.join(taskTree, ATTACHMENTS_DIR)), false)
  })
})

describe('rejectWithImages: «Вернуть» задачи из ревью', () => {
  it('обычная задача: воркер, worktree задачи; пути — в feedbackImages и в промпте воркера', () => {
    const { task, taskTree } = setup()
    rejectWithImages(store, repo, task.id, [png()], 'кнопка не там', (paths) => store.rejectReview(task.id, 'кнопка не там', paths))
    const [p] = store.getTask(task.id)!.feedbackImages!
    assert.ok(p.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_')))
    assert.ok(workerTaskPrompt(store.getTask(task.id)!).includes(`\`${p}\``))
  })

  it('проверка ветки глобальной задачи (gate): читает координатор — cwd прогона, подпапка returns', () => {
    const { run, runTree } = setup({ scope: 'run' })
    const gate = store.createTask({ title: 'Проверка ветки', runId: run.id, gateFor: { runId: run.id, nodeId: 'review' } })
    let got: string[] = []
    rejectWithImages(store, repo, gate.id, [png()], 'замечание', (paths) => { got = paths })
    assert.equal(got.length, 1)
    assert.ok(got[0].startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')), got[0])
  })

  it('без картинок — apply([]) и никаких файлов', () => {
    const { task, taskTree } = setup()
    rejectWithImages(store, repo, task.id, undefined, 'просто текст', (paths) => store.rejectReview(task.id, 'просто текст', paths))
    assert.equal(store.getTask(task.id)!.feedbackImages, undefined)
    assert.equal(existsSync(path.join(taskTree, ATTACHMENTS_DIR)), false)
  })
})

describe('returnRunWithImages: «Вернуть в работу» глобальной задачи', () => {
  it('старый формат: пути в Run.returns и в цели повторного запуска координатора', () => {
    const run = store.createRun('Сделать логин')
    store.setRunPty(run.id, 'pty_c', 'claude')
    const runTree = path.join(tmp, 'legacy-tree')
    mkdirSync(runTree)
    store.setRunGit(run.id, { branch: 'feature/l', base: 'master', worktree: runTree })
    const t = store.createTask({ title: 'A', runId: run.id })
    store.moveTask(t.id, 'in_progress')
    store.moveTask(t.id, 'done')
    store.finishRun(run.id, 'готово')

    returnRunWithImages(store, repo, run.id, [png(), jpg], 'Поправь по скриншотам', (paths) => store.returnGlobalTask(run.id, 'Поправь по скриншотам', paths))
    const returned = store.getRun(run.id)!.returns!.at(-1)!
    assert.equal(returned.images!.length, 2)
    assert.ok(returned.images!.every((p) => p.startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')) && existsSync(p)))
    const { objective } = resumeObjective(store, run.id, () => false)
    for (const p of returned.images!) assert.ok(objective.includes(`\`${p}\``), p)
    assert.match(objective, /Воркеры этих файлов не видят/)
  })

  it('пустой текст — ошибка store, файлы удалены (ссылок на них нет)', () => {
    const run = store.createRun('цель')
    const runTree = path.join(tmp, 'empty-tree')
    mkdirSync(runTree)
    store.setRunGit(run.id, { branch: 'feature/e', base: 'master', worktree: runTree })
    assert.throws(() => returnRunWithImages(store, repo, run.id, [png()], ' ', () => 1), (e) => e instanceof OrcaError && e.key === 'attachments.needText')
    assert.equal(existsSync(path.join(runTree, ATTACHMENTS_DIR, run.id)), false)
    assert.throws(() => returnRunWithImages(store, repo, run.id, [png()], 'т', (paths) => store.returnGlobalTask(run.id, ' ', paths)), /напиши, что доделать/)
    assert.equal(returnDirs(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns')).length, 0)
  })
})

describe('hasImageInput', () => {
  it('undefined, null и пустой массив — «не присылали»; остальное, даже мусор, — присылали (его отвергнет валидация)', () => {
    assert.deepEqual([undefined, null, []].map(hasImageInput), [false, false, false])
    assert.deepEqual([[png()], 'x', {}, 0].map(hasImageInput), [true, true, true, true])
  })
})
