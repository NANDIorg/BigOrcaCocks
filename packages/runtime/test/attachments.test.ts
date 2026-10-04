// Запуск: pnpm --filter @orca-board/runtime test. Картинки к замечаниям при возврате в работу: запись файлов в cwd читателя,
// откат при ошибке, вырезание чужих путей из решения, маршрут «воркер / координатор» и путь до промптов агентов.
// Настоящий TaskStore и временные папки; PTY и electron не участвуют.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_OBJECTIVE, coordinatorPrompt, getAgent, agentSystemPrompt, presetTaskTypes, resolveTaskType, workerTaskPrompt, validateAttachments, presetTaskType, runTypeInput, type ImageAttachmentInput } from '@orca-board/core'
import { HostError as OrcaError, resources } from './execution-test-host.ts'
const { resumeObjective } = resources()
import { ARGV_LINE_MARGIN, CMD_LINE_LIMIT, CREATE_PROCESS_LIMIT, argvCommandLine, win32Launch } from '../src/win32-launch.ts'
const {
  ATTACHMENTS_DIR, attachmentCapabilities, clearStartImages, coordinatorImagesPlace, coordinatorObjective, discardReturnImages, hasImageInput, imagesReferenced, pruneAttachments,
  rejectWithImages, resolveWithImages, returnRunWithImages, saveReturnImages, stripResolutionImages, withReturnImages, workerImagesPlace,
  writeAttachments
} = resources()

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (extra = 0): ImageAttachmentInput => ({ mime: 'image/png', data: Uint8Array.from([...PNG_HEAD, 1, 2, 3, extra]) })
const jpg: ImageAttachmentInput = { mime: 'image/jpeg', data: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]) }
/** Файл не-картинка с именем, как его присылает новый renderer (`File.name`). */
const file = (name: string, text = 'data', mime = 'application/octet-stream'): ImageAttachmentInput => ({ mime, name, data: new TextEncoder().encode(text) })

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
    const a = saveReturnImages(cwd, 't1', '', validateAttachments([png(), jpg]))
    const b = saveReturnImages(cwd, 't1', '', validateAttachments([png(1)]))
    assert.deepEqual(a.map((p) => path.basename(p)), ['image-1.png', 'image-2.jpg'])
    assert.ok(a.every((p) => path.isAbsolute(p) && p.startsWith(path.join(cwd, ATTACHMENTS_DIR, 't1', 'ret_'))))
    assert.notEqual(path.dirname(a[0]), path.dirname(b[0]), 'два возврата — две папки, image-1 не перезаписывается')
    assert.deepEqual(readFileSync(a[0]), Buffer.from([...PNG_HEAD, 1, 2, 3, 0]))
    assert.equal(readFileSync(path.join(cwd, ATTACHMENTS_DIR, '.gitignore'), 'utf8'), '*\n')
  })

  it('подпапка `returns` — для координатора; git status рабочей папки чистый (картинки не попадут в коммит)', () => {
    const [p] = saveReturnImages(repo, 'run_1', 'returns', validateAttachments([png()]))
    assert.ok(p.startsWith(path.join(repo, ATTACHMENTS_DIR, 'run_1', 'returns', 'ret_')))
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '')
  })

  it('не удалось записать — OrcaError, чужого не остаётся', () => {
    const cwd = path.join(tmp, 'file-not-dir')
    writeFileSync(cwd, 'x')
    assert.throws(() => saveReturnImages(cwd, 't1', '', validateAttachments([png()])), (e) => e instanceof OrcaError && e.key === 'attachments.saveFailed')
  })

  it('discardReturnImages удаляет только папку ret_* из .orca-attachments', () => {
    const cwd = path.join(tmp, 'wt2')
    mkdirSync(cwd)
    const paths = saveReturnImages(cwd, 't1', '', validateAttachments([png()]))
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
    writeAttachments(path.join(cwd, ATTACHMENTS_DIR), 'run_1', validateAttachments([png(), jpg]))
    const [ret] = saveReturnImages(cwd, 'run_1', 'returns', validateAttachments([png(2)]))
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
    const [ret] = saveReturnImages(cwd, 'run_1', 'returns', validateAttachments([png()]))
    writeAttachments(root, 'run_1', validateAttachments([jpg, png()]))
    // image-2.png уже есть: флаг `wx` падает на втором файле, первый (image-1.png) откатывается.
    assert.throws(() => writeAttachments(root, 'run_1', validateAttachments([png(), png()])), (e) => e instanceof OrcaError)
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
    for (const id of [open.id, closed.id]) saveReturnImages(cwd, id, 'returns', validateAttachments([png()]))
    pruneAttachments(store, root, () => false)
    assert.ok(existsSync(path.join(root, open.id)))
    assert.equal(existsSync(path.join(root, closed.id)), false)
  })
})

function attachmentsRootOf(cwd: string): string {
  saveReturnImages(cwd, '_probe', '', validateAttachments([png()]))
  rmSync(path.join(cwd, ATTACHMENTS_DIR, '_probe'), { recursive: true })
  return path.join(cwd, ATTACHMENTS_DIR)
}

describe('withReturnImages', () => {
  const place = (): ReturnType<typeof workerImagesPlace> => ({ cwd: tmp, ownerId: 'o1', subdir: '' })
  const dirs = (): string[] => returnDirs(path.join(tmp, ATTACHMENTS_DIR, 'o1'))

  it('без картинок — apply([]), файлы не создаются, место не вычисляется', async () => {
    let placed = false
    const out = await withReturnImages(store, () => { placed = true; return place() }, undefined, 'текст', (paths) => paths.length)
    assert.equal(out, 0)
    assert.equal(placed, false)
    assert.equal(existsSync(path.join(tmp, ATTACHMENTS_DIR)), false)
    assert.equal(await withReturnImages(store, place, [], 'текст', (paths) => paths.length), 0)
  })

  it('вложения без текста, не массив, пустой файл, слишком много — понятные ошибки до записи файлов', async () => {
    const key = (input: unknown, text: string | undefined) =>
      (async () => await withReturnImages(store, place, input, text, () => 1))
    await assert.rejects(async () => await (key([png()], '  '))(), (e) => e instanceof OrcaError && e.key === 'attachments.needText')
    await assert.rejects(async () => await (key([png()], undefined))(), (e) => e instanceof OrcaError && e.key === 'attachments.needText')
    await assert.rejects(async () => await (key('картинка', 'т'))(), (e) => e instanceof OrcaError && e.key === 'attachments.invalid')
    await assert.rejects(async () => await (key([{ mime: 'text/plain', data: new Uint8Array(0), name: 'empty.txt' }], 'т'))(), (e) => e instanceof OrcaError && e.key === 'attachments.invalid')
    await assert.rejects(async () => await (key([{ mime: 'application/pdf', data: new Uint8Array(ATTACHMENT_LIMITS.maxBytes + 1) }], 'т'))(), /больше 25 МБ/)
    await assert.rejects(async () => await (key(Array.from({ length: 9 }, () => png()), 'т'))(), /не больше 8/)
    assert.equal(existsSync(path.join(tmp, ATTACHMENTS_DIR)), false, 'ничего не записано')
  })

  it('apply упал, store не сослался на файлы — папка возврата удалена; сослался — файлы остаются', async () => {
    await assert.rejects(async () => await withReturnImages(store, place, [png()], 'т', () => { throw new Error('store отказал') }), /store отказал/)
    assert.equal(dirs().length, 0)

    const task = store.createTask({ title: 'T' })
    await assert.rejects(async () => await withReturnImages(store, place, [png()], 'т', (paths) => {
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

  it('координатор: worktree ветки глобальной задачи; прогон без ветки (работал в корне) — корень репозитория', async () => {
    const { run, runTree } = setup()
    assert.deepEqual(await coordinatorImagesPlace(store, repo, run.id), { cwd: runTree, ownerId: run.id, subdir: 'returns' })
    const legacy = store.createGlobalTask({ title: 'старая' })
    const t = store.createTask({ title: 'x', runId: legacy.id })
    store.startDispatch(t.id, 'pty_x')
    assert.equal((await coordinatorImagesPlace(store, repo, legacy.id)).cwd, repo, 'воркеры уже работали в корне — ветку не заводим')
  })
})

describe('resolveWithImages: «Уточнить» и «Вернуть» запроса', () => {
  it('«Уточнить» ответа: файлы в worktree воркера, в решении — пути; воркер увидит их в промпте', async () => {
    const { task, taskTree } = setup({ answerFor: 'human' })
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    await resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'глубже, см. скриншот' }, [png(), jpg], (r) => store.resolveRequest(req.id, r))
    const images = store.getTask(task.id)!.feedbackImages!
    assert.equal(images.length, 2)
    assert.ok(images.every((p) => p.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_'))))
    assert.deepEqual(store.getRequest(req.id)!.resolution?.images, images)
    const prompt = workerTaskPrompt(store.getTask(task.id)!, 'прошлый ответ')
    for (const p of images) assert.ok(prompt.includes(`\`${p}\``), p)
    assert.ok(images.every((p) => existsSync(p)))
  })

  it('пути из resolution.images, присланные renderer-ом или сокетом, вырезаются — с картинками и без них', async () => {
    const { task } = setup({ answerFor: 'human' })
    const forged = ['/etc/passwd']
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    await resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'подробнее', images: forged }, undefined, (r) => store.resolveRequest(req.id, r))
    assert.equal(store.getTask(task.id)!.feedbackImages, undefined)
    assert.equal(store.getRequest(req.id)!.resolution?.images, undefined)

    const again = setup({ answerFor: 'human' })
    const req2 = store.pendingRequests().find((r) => r.taskId === again.task.id)!
    await resolveWithImages(store, repo, req2.id, { action: 'clarify', text: 'ещё', images: forged }, [png()], (r) => store.resolveRequest(req2.id, r))
    const got = store.getTask(again.task.id)!.feedbackImages!
    assert.equal(got.length, 1)
    assert.ok(!got.includes(forged[0]))
    assert.deepEqual(stripResolutionImages({ action: 'accept' as const, images: forged }), { action: 'accept' })
  })

  it('«Вернуть» approval прогона (без задачи) — файлы в cwd координатора, подпапка returns; «Вернуть» approval задачи — worktree воркера', async () => {
    const { run, runTree, task, taskTree } = setup({ scope: 'run' })
    const runReq = store.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    await resolveWithImages(store, repo, runReq.id, { action: 'reject', text: 'не так' }, [png()], (r) => store.resolveRequest(runReq.id, r))
    const [c] = store.getRequest(runReq.id)!.resolution!.images!
    assert.ok(c.startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')), c)

    const taskReq = store.requestApproval(task.id, { nodeId: 'review', title: 'Ревью' })
    await resolveWithImages(store, repo, taskReq.id, { action: 'reject', text: 'поправь' }, [jpg], (r) => store.resolveRequest(taskReq.id, r))
    const [w] = store.getTask(task.id)!.feedbackImages!
    assert.ok(w.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_')), w)
  })

  it('картинки к «Принять»/«Ответить» — ошибка, запрос остаётся ждать; нет worktree — ошибка до записи в store', async () => {
    const { run, task, taskTree } = setup({ answerFor: 'human' })
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    await assert.rejects(
      async () => await resolveWithImages(store, repo, req.id, { action: 'accept', text: 'ок' }, [png()], (r) => store.resolveRequest(req.id, r)),
      (e) => e instanceof OrcaError && e.key === 'attachments.notForAction'
    )
    rmSync(taskTree, { recursive: true })
    await assert.rejects(
      async () => await resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'подробнее' }, [png()], (r) => store.resolveRequest(req.id, r)),
      (e) => e instanceof OrcaError && e.key === 'attachments.noWorktree'
    )
    assert.equal(store.getRequest(req.id)!.status, 'pending', 'текст остаётся в форме, запрос не решён')
    assert.equal(store.getTask(task.id)!.feedback, undefined)
    assert.ok(store.getRun(run.id))
  })

  it('решённый или несуществующий запрос: обычная ошибка store, файлы не пишутся', async () => {
    const { taskTree } = setup({ answerFor: 'human' })
    await assert.rejects(
      async () => await resolveWithImages(store, repo, 'req_нет', { action: 'clarify', text: 'т' }, [png()], (r) => store.resolveRequest('req_нет', r)),
      /request not found/
    )
    assert.equal(existsSync(path.join(taskTree, ATTACHMENTS_DIR)), false)
  })
})

describe('rejectWithImages: «Вернуть» задачи из ревью', () => {
  it('обычная задача: воркер, worktree задачи; пути — в feedbackImages и в промпте воркера', async () => {
    const { task, taskTree } = setup()
    await rejectWithImages(store, repo, task.id, [png()], 'кнопка не там', (paths) => store.rejectReview(task.id, 'кнопка не там', paths))
    const [p] = store.getTask(task.id)!.feedbackImages!
    assert.ok(p.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_')))
    assert.ok(workerTaskPrompt(store.getTask(task.id)!).includes(`\`${p}\``))
  })

  it('проверка ветки глобальной задачи (gate): читает координатор — cwd прогона, подпапка returns', async () => {
    const { run, runTree } = setup({ scope: 'run' })
    const gate = store.createTask({ title: 'Проверка ветки', runId: run.id, gateFor: { runId: run.id, nodeId: 'review' } })
    let got: string[] = []
    await rejectWithImages(store, repo, gate.id, [png()], 'замечание', (paths) => { got = paths })
    assert.equal(got.length, 1)
    assert.ok(got[0].startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')), got[0])
  })

  it('без картинок — apply([]) и никаких файлов', async () => {
    const { task, taskTree } = setup()
    await rejectWithImages(store, repo, task.id, undefined, 'просто текст', (paths) => store.rejectReview(task.id, 'просто текст', paths))
    assert.equal(store.getTask(task.id)!.feedbackImages, undefined)
    assert.equal(existsSync(path.join(taskTree, ATTACHMENTS_DIR)), false)
  })
})

describe('returnRunWithImages: «Вернуть в работу» глобальной задачи', () => {
  it('старый формат: пути в Run.returns и в цели повторного запуска координатора', async () => {
    const run = store.createRun('Сделать логин')
    store.setRunPty(run.id, 'pty_c', 'claude')
    const runTree = path.join(tmp, 'legacy-tree')
    mkdirSync(runTree)
    store.setRunGit(run.id, { branch: 'feature/l', base: 'master', worktree: runTree })
    const t = store.createTask({ title: 'A', runId: run.id })
    store.moveTask(t.id, 'in_progress')
    store.moveTask(t.id, 'done')
    store.finishRun(run.id, 'готово')

    await returnRunWithImages(store, repo, run.id, [png(), jpg], 'Поправь по скриншотам', (paths) => store.returnGlobalTask(run.id, 'Поправь по скриншотам', paths))
    const returned = store.getRun(run.id)!.returns!.at(-1)!
    assert.equal(returned.images!.length, 2)
    assert.ok(returned.images!.every((p) => p.startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')) && existsSync(p)))
    const { objective } = resumeObjective(store, run.id, () => false)
    for (const p of returned.images!) assert.ok(objective.includes(`\`${p}\``), p)
    assert.match(objective, /Воркеры этих файлов не видят/)
  })

  it('пустой текст — ошибка store, файлы удалены (ссылок на них нет)', async () => {
    const run = store.createRun('цель')
    const runTree = path.join(tmp, 'empty-tree')
    mkdirSync(runTree)
    store.setRunGit(run.id, { branch: 'feature/e', base: 'master', worktree: runTree })
    await assert.rejects(async () => await returnRunWithImages(store, repo, run.id, [png()], ' ', () => 1), (e) => e instanceof OrcaError && e.key === 'attachments.needText')
    assert.equal(existsSync(path.join(runTree, ATTACHMENTS_DIR, run.id)), false)
    await assert.rejects(async () => await returnRunWithImages(store, repo, run.id, [png()], 'т', (paths) => store.returnGlobalTask(run.id, ' ', paths)), /напиши, что доделать/)
    assert.equal(returnDirs(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns')).length, 0)
  })
})

describe('hasImageInput', () => {
  it('undefined, null и пустой массив — «не присылали»; остальное, даже мусор, — присылали (его отвергнет валидация)', () => {
    assert.deepEqual([undefined, null, []].map(hasImageInput), [false, false, false])
    assert.deepEqual([[png()], 'x', {}, 0].map(hasImageInput), [true, true, true, true])
  })
})

describe('вложения любых файлов', () => {
  it('имена на диске: картинки image-N.ext, файлы file-N-<slug>.ext; одноимённые файлы не сталкиваются, путь из имени не проходит', () => {
    const cwd = path.join(tmp, 'files')
    mkdirSync(cwd)
    const paths = saveReturnImages(cwd, 't1', '', validateAttachments([
      png(), file('spec v2.pdf', '%PDF-1.4', 'application/pdf'), file('error.log'), file('dir/error.log', 'другой'),
      file('../../etc/passwd'), file('.env', 'SECRET=1'), file('Отчёт Q3.xlsx'), file('noext')
    ]))
    assert.deepEqual(paths.map((p) => path.basename(p)), [
      'image-1.png', 'file-2-spec_v2.pdf', 'file-3-error.log', 'file-4-error.log', 'file-5-passwd', 'file-6-env', 'file-7-Otchet_Q3.xlsx', 'file-8-noext'
    ])
    const dir = path.dirname(paths[0])
    assert.ok(paths.every((p) => path.dirname(p) === dir), 'всё в одной ret_* папке, наружу не вышло')
    assert.equal(readFileSync(paths[2], 'utf8'), 'data')
    assert.equal(readFileSync(paths[3], 'utf8'), 'другой')
  })

  it('clearStartImages удаляет image-* и file-* в корне папки прогона, returns/ (и файлы в нём) не трогает', () => {
    const cwd = path.join(tmp, 'coord-files')
    mkdirSync(cwd)
    const root = path.join(cwd, ATTACHMENTS_DIR)
    const [ret] = saveReturnImages(cwd, 'run_1', 'returns', validateAttachments([file('fix.patch')]))
    writeAttachments(root, 'run_1', validateAttachments([file('a.txt'), png(), file('Makefile')]))
    writeFileSync(path.join(root, 'run_1', 'notes.md'), 'чужое')
    const dir = path.join(root, 'run_1')
    assert.deepEqual(files(dir), ['file-1-a.txt', 'file-3-Makefile', 'image-2.png', 'notes.md', 'returns'])
    clearStartImages(root, 'run_1')
    assert.deepEqual(files(dir), ['notes.md', 'returns'])
    assert.ok(existsSync(ret) && path.basename(ret) === 'file-1-fix.patch')
  })

  it('откат при падении apply: папка возврата с файлами удаляется', async () => {
    const place = (): ReturnType<typeof workerImagesPlace> => ({ cwd: tmp, ownerId: 'o2', subdir: '' })
    await assert.rejects(async () => await withReturnImages(store, place, [file('log.txt'), png()], 'т', (paths) => {
      assert.ok(paths.every((p) => existsSync(p)))
      throw new Error('store отказал')
    }), /store отказал/)
    assert.equal(returnDirs(path.join(tmp, ATTACHMENTS_DIR, 'o2')).length, 0)
  })

  it('весь путь: файл из IPC → .orca-attachments координатора → Run.stageInput.images → промпт координатора', async () => {
    const run = store.createGlobalTask({ title: 'G', type: runTypeInput(presetTaskType('general')!) })
    const runTree = mkdtempSync(path.join(tmp, 'run-tree-'))
    store.setRunGit(run.id, { branch: 'feature/g', base: 'master', worktree: runTree })
    const pdf = file('spec.pdf', '%PDF-1.7 текст', 'application/pdf')
    await returnRunWithImages(store, repo, run.id, [pdf, png()], 'см. спеку', (paths) => store.enterRunStage(run.id, { feedback: 'см. спеку', images: paths }))
    const images = store.getRun(run.id)!.stageInput!.images!
    assert.deepEqual(images.map((p) => path.basename(p)), ['file-1-spec.pdf', 'image-2.png'])
    assert.ok(images.every((p) => p.startsWith(path.join(runTree, ATTACHMENTS_DIR, run.id, 'returns', 'ret_')) && existsSync(p)))
    assert.equal(readFileSync(images[0], 'utf8'), '%PDF-1.7 текст')
  })

  it('пути из resolution.images вырезаются и для файлов; «Уточнить» с файлом — путь в промпте воркера', async () => {
    const { task, taskTree } = setup({ answerFor: 'human' })
    const req = store.pendingRequests().find((r) => r.kind === 'answer')!
    await resolveWithImages(store, repo, req.id, { action: 'clarify', text: 'лог', images: ['/etc/passwd'] }, [file('trace.log')], (r) => store.resolveRequest(req.id, r))
    const [p] = store.getTask(task.id)!.feedbackImages!
    assert.ok(p.startsWith(path.join(taskTree, ATTACHMENTS_DIR, task.id, 'ret_')) && p.endsWith('file-1-trace.log'), p)
    assert.ok(workerTaskPrompt(store.getTask(task.id)!, 'ответ').includes(`\`${p}\``))
  })
})

describe('цель координатора и рукопожатие', () => {
  it('coordinatorObjective: текст — как есть; пустая цель + только файл — цель по умолчанию; ничего — coordinator.noObjective', () => {
    const one = validateAttachments([file('task.md', '# задача')])
    assert.equal(coordinatorObjective('  Сделать логин  ', one), 'Сделать логин')
    assert.equal(coordinatorObjective('   ', one), DEFAULT_ATTACHMENT_OBJECTIVE)
    assert.equal(coordinatorObjective(undefined, validateAttachments([png()])), DEFAULT_ATTACHMENT_OBJECTIVE)
    assert.throws(() => coordinatorObjective('', []), (e) => e instanceof OrcaError && e.key === 'coordinator.noObjective')
    assert.throws(() => coordinatorObjective(42, []), (e) => e instanceof OrcaError && e.key === 'coordinator.noObjective')
  })

  it('attachments:capabilities — files: true и лимиты ATTACHMENT_LIMITS (копия, не сама константа)', () => {
    const caps = attachmentCapabilities()
    assert.deepEqual(caps, { files: true, limits: { ...ATTACHMENT_LIMITS } })
    assert.notEqual(caps.limits, ATTACHMENT_LIMITS)
  })
})

describe('Windows: стартовый промпт координатора с 8 файлами', () => {
  // Длинный, но реальный cwd координатора: профиль, папка проектов и worktree ветки глобальной задачи.
  const cwd = 'C:\\Users\\very.long.user.name.2026\\Documents\\projects\\some-long-repository-name\\.orca-worktrees\\run_mqx1y2z3abcd'
  const paths = Array.from({ length: ATTACHMENT_LIMITS.maxCount }, (_, i) =>
    `${cwd}\\${ATTACHMENTS_DIR}\\run_mqx1y2z3abcd\\file-${i + 1}-${'x'.repeat(40)}.${'e'.repeat(10)}`)
  const prompt = coordinatorPrompt(DEFAULT_ATTACHMENT_OBJECTIVE, paths)
  const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')

  /**
   * argv claude координатора, как в `startCoordinator` (worker.ts): настоящий skill, правила типа и роль coordinator
   * из пресета, директива языка, модель/effort роли и session id. Берётся самый длинный пресет и язык — худший случай.
   */
  function longestCoordinatorArgs(): string[] {
    const all = presetTaskTypes().flatMap((t) => {
      const r = resolveTaskType(t)
      const role = r.roles.find((x) => x.id === 'coordinator')!
      return (['ru', 'en'] as const).map((language) =>
        getAgent('claude')!.invoke(agentSystemPrompt(skill, { projectRules: r.agentRules, role, language }), prompt, {
          permissionMode: 'auto', shell: 'cmd.exe', model: role.model, effort: role.effort, sessionId: '00000000-0000-4000-8000-000000000000'
        }).args)
    })
    return all.reduce((a, b) => (b.join(' ').length > a.join(' ').length ? b : a))
  }

  it('8 путей максимальной длины и реальный system prompt: через npm-шим влезают в CreateProcess с запасом ≥ 2 КБ', () => {
    assert.ok(paths[0].length >= 170, `путь ${paths[0].length} знаков`)
    const cli = path.join(tmp, 'cli.js')
    writeFileSync(cli, '')
    const shim = path.join(tmp, 'claude.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n')
    const node = 'C:\\Users\\very.long.user.name.2026\\AppData\\Local\\Programs\\Orca Board\\Orca Board.exe'
    const args = longestCoordinatorArgs()
    // Без подмены реальный argv в лимит не влезает: system prompt координатора ~30 тыс. знаков.
    assert.ok(argvCommandLine(node, [cli, ...args]).length > CREATE_PROCESS_LIMIT - ARGV_LINE_MARGIN)
    const sys = path.join(tmp, 'system-prompts', '00000000-0000-4000-8000-000000000000.md')
    mkdirSync(path.dirname(sys))
    const launch = win32Launch(shim, args, { electronNode: node, systemPromptFile: () => sys })
    assert.deepEqual(launch.tempFiles, [sys])
    const line = argvCommandLine(launch.command, launch.args as string[])
    assert.ok(CREATE_PROCESS_LIMIT - line.length >= 2048, `строка ${line.length} из ${CREATE_PROCESS_LIMIT}`)
    assert.equal(readFileSync(sys, 'utf8'), args[args.length - 2])
    assert.equal((launch.args as string[]).at(-1), prompt)
  })

  it('через нераспознанный шим (cmd.exe) — тоже: system prompt в файле, строка в CMD_LINE_LIMIT', () => {
    const shim = path.join(tmp, 'claude.cmd')
    writeFileSync(shim, '@echo off\r\n')
    const launch = win32Launch(shim, longestCoordinatorArgs(), { systemPromptFile: () => path.join(tmp, 'sys.md') })
    assert.equal(launch.command, 'cmd.exe')
    assert.ok(typeof launch.args === 'string' && launch.args.length <= CMD_LINE_LIMIT + '/d /s /c ""'.length, `строка ${String(launch.args.length)} из ${CMD_LINE_LIMIT}`)
    assert.deepEqual(launch.tempFiles, [path.join(tmp, 'sys.md')])
  })
})
