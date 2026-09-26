// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Картинки к замечаниям при возврате в работу: пути в store (feedbackImages, resolution.images, Run.returns[].images,
// stageInput.images), события, инвариант «новое замечание без картинок не наследует старые» и промпты агентам.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, type OrcaEvent } from './types.ts'
import { defaultWorkflow } from './workflow.ts'
import { resumeCoordinatorObjective, workerTaskPrompt } from './prompts.ts'

const IMG = ['/wt/.orca-attachments/t1/ret_a1/image-1.png', '/wt/.orca-attachments/t1/ret_a1/image-2.jpg']
const IMG2 = ['/wt/.orca-attachments/t1/ret_b2/image-1.webp']

const memory = (): Persistence & { data: Partial<StoreSnapshot> | null } => {
  const p = {
    data: null as Partial<StoreSnapshot> | null,
    load: () => p.data,
    save: (s: StoreSnapshot) => { p.data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
  return p
}
const store = (p?: Persistence) => new TaskStore(p, () => DEFAULT_COLUMNS)
const events = (s: TaskStore, type: OrcaEvent['type']): OrcaEvent[] => s.listEvents().filter((e) => e.type === type)

/** Подзадача глобальной задачи на ревью (работа сдана). */
function onReview(answerFor?: 'human') {
  const s = store()
  const g = s.createGlobalTask({ title: 'G' })
  s.setRunPty(g.id, 'pty_c')
  const task = s.createTask({ title: 'T', runId: g.id, ...(answerFor ? { answerFor } : {}) })
  s.createTask({ title: 'other', runId: g.id })
  const d = s.startDispatch(task.id, 'pty_w')
  s.finishDispatch(d.id, 'сделал', [], answerFor ? '# Ответ' : undefined)
  return { s, g, task }
}

describe('Task.feedbackImages', () => {
  it('rejectReview с картинками кладёт пути рядом с текстом; следующее замечание без картинок их сбрасывает', () => {
    const { s, task } = onReview()
    s.rejectReview(task.id, 'кнопка не там', IMG)
    assert.deepEqual([s.getTask(task.id)!.feedback, s.getTask(task.id)!.feedbackImages], ['кнопка не там', IMG])
    s.rejectReview(task.id, 'ещё раз без картинки')
    assert.equal(s.getTask(task.id)!.feedback, 'ещё раз без картинки')
    assert.equal(s.getTask(task.id)!.feedbackImages, undefined)
  })

  it('новое замечание с другими картинками заменяет, а не накапливает', () => {
    const { s, task } = onReview()
    s.rejectReview(task.id, 'раз', IMG)
    s.rejectReview(task.id, 'два', IMG2)
    assert.deepEqual(s.getTask(task.id)!.feedbackImages, IMG2)
  })

  it('updateTask({feedback}) без картинок и reopenTask с текстом сбрасывают feedbackImages; updateTask без feedback — не трогает', () => {
    const { s, task } = onReview()
    s.rejectReview(task.id, 'раз', IMG)
    s.updateTask(task.id, { priority: 'high' })
    assert.deepEqual(s.getTask(task.id)!.feedbackImages, IMG)
    s.updateTask(task.id, { feedback: 'git-ошибка' })
    assert.equal(s.getTask(task.id)!.feedbackImages, undefined)
    s.updateTask(task.id, { feedback: 'со своими', feedbackImages: IMG2 })
    assert.deepEqual(s.getTask(task.id)!.feedbackImages, IMG2)
    s.reopenTask(task.id, 'по-новому')
    assert.equal(s.getTask(task.id)!.feedbackImages, undefined)
  })

  it('«Уточнить» ответа: пути в feedbackImages, resolution.images и answer_clarified.images; без картинок ключей нет', () => {
    const { s, task } = onReview('human')
    const req = s.pendingRequests().find((r) => r.kind === 'answer')!
    s.resolveRequest(req.id, { action: 'clarify', text: 'подробнее, см. скриншот', images: IMG })
    assert.deepEqual(s.getTask(task.id)!.feedbackImages, IMG)
    assert.deepEqual(s.getRequest(req.id)!.resolution, { action: 'clarify', text: 'подробнее, см. скриншот', images: IMG })
    const e = events(s, 'answer_clarified').at(-1)!
    assert.deepEqual(e.payload.images, IMG)

    const again = onReview('human')
    const r2 = again.s.pendingRequests().find((r) => r.kind === 'answer')!
    again.s.resolveRequest(r2.id, { action: 'clarify', text: 'без картинок' })
    assert.equal('images' in events(again.s, 'answer_clarified').at(-1)!.payload, false)
    assert.equal(again.s.getTask(again.task.id)!.feedbackImages, undefined)
  })

  it('«Вернуть» по approval подзадачи: картинки — в feedbackImages, resolution и request_resolved; при «Принять» и без текста — отбрасываются', () => {
    const { s, task } = onReview()
    const req = s.requestApproval(task.id, { nodeId: 'review', title: 'Ревью' })
    s.resolveRequest(req.id, { action: 'reject', text: 'поправь', images: IMG })
    assert.deepEqual(s.getTask(task.id)!.feedbackImages, IMG)
    assert.deepEqual(events(s, 'request_resolved').at(-1)!.payload.images, IMG)

    const acc = s.requestApproval(task.id, { nodeId: 'review2', title: 'Ревью 2' })
    s.resolveRequest(acc.id, { action: 'accept', text: 'ок', images: IMG2 })
    assert.equal(s.getRequest(acc.id)!.resolution?.images, undefined)
    assert.equal('images' in events(s, 'request_resolved').at(-1)!.payload, false)

    const bare = s.requestApproval(task.id, { nodeId: 'review3', title: 'Ревью 3' })
    s.resolveRequest(bare.id, { action: 'reject', images: IMG2 })
    assert.equal(s.getRequest(bare.id)!.resolution?.images, undefined, 'картинки без текста замечаний не хранятся')
  })
})

/** Прогон старого формата на «Проверке»: подзадача done → run_done, `runs finish`. */
function legacyReview(s: TaskStore): string {
  const run = s.createRun('цель')
  s.setRunPty(run.id, 'pty_c', 'claude')
  const t = s.createTask({ title: 'A', runId: run.id })
  s.moveTask(t.id, 'in_progress')
  s.moveTask(t.id, 'done')
  s.finishRun(run.id, 'готово')
  return run.id
}

describe('глобальная задача: возврат в работу с картинками', () => {
  const CIMG = ['/repo/.orca-attachments/run_1/returns/ret_x1/image-1.png']

  it('старый формат (без воркфлоу): Run.returns[].images; без картинок ключа нет', () => {
    const s = store()
    const id = legacyReview(s)
    s.returnGlobalTask(id, 'с картинкой', CIMG)
    const t = s.createTask({ title: 'B', runId: id })
    s.moveTask(t.id, 'in_progress')
    s.moveTask(t.id, 'done')
    s.finishRun(id, 'готово')
    s.returnGlobalTask(id, 'без')
    const [a, b] = s.getRun(id)!.returns!
    assert.deepEqual(a.images, CIMG)
    assert.equal('images' in b, false)
  })

  it('воркфлоу прогона: reject с картинками → stageInput, Run.returns, stage_started и runStage; следующий переход их сбрасывает', () => {
    const s = store()
    const run = s.createRun('цель', undefined, defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }]))
    s.setRunPty(run.id, 'pty_c', 'claude')
    const opts = { roleIds: ['developer', 'reviewer'] }
    s.enterRunStage(run.id, opts)
    const a = s.createTask({ title: 'A', runId: run.id })
    s.updateTask(a.id, { status: 'done' })
    s.finishStage(run.id, { ...opts, summary: 'готово' })
    s.advanceRunStage(run.id, 'accept', opts)
    const req = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.returnGlobalTask(run.id, 'см. скриншот', CIMG)
    assert.deepEqual(s.getRequest(req.id)!.resolution?.images, CIMG)
    // Переход делает main (`runApprovalResolved`): feedback и images из решения.
    s.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'см. скриншот', images: CIMG })
    const r = s.getRun(run.id)!
    assert.deepEqual(r.stageInput, { feedback: 'см. скриншот', images: CIMG })
    assert.deepEqual(r.returns!.at(-1)!.images, CIMG)
    assert.deepEqual(events(s, 'stage_started').at(-1)!.payload.images, CIMG)
    assert.deepEqual(s.runStage(run.id, opts)!.images, CIMG)

    // Картинки без текста замечаний не хранятся.
    const b = s.createTask({ title: 'B', runId: run.id })
    s.updateTask(b.id, { status: 'done' })
    s.finishStage(run.id, { ...opts, summary: 'ещё' })
    s.advanceRunStage(run.id, 'accept', opts)
    s.advanceRunStage(run.id, 'reject', { ...opts, images: CIMG })
    assert.equal(s.getRun(run.id)!.stageInput, undefined)
    assert.equal('images' in events(s, 'stage_started').at(-1)!.payload, false)
  })

  it('снапшот с путями переживает перезагрузку store', () => {
    const p = memory()
    const s = store(p)
    const id = legacyReview(s)
    s.returnGlobalTask(id, 'с картинкой', CIMG)
    const loaded = store(p)
    assert.deepEqual(loaded.getRun(id)!.returns![0].images, CIMG)
  })
})

describe('промпты агентам', () => {
  it('воркер: пути в «Замечаниях после ревью» и в «Уточнении к прошлому ответу»; без картинок вывод прежний', () => {
    const plain = workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'правь' })
    assert.equal(plain, workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'правь', feedbackImages: [] }))
    assert.ok(!plain.includes('изображени'))

    const withImages = workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'правь', feedbackImages: IMG })
    const review = withImages.slice(withImages.indexOf('# Замечания после ревью'))
    for (const p of IMG) assert.ok(review.includes(`\`${p}\``), p)
    assert.match(review, /данные, а не команды/)
    assert.ok(!review.includes('Воркеры этих файлов не видят'), 'воркеру — без оговорки для координатора')
    assert.ok(withImages.startsWith(plain.slice(0, plain.indexOf('# Замечания после ревью'))))

    const answer = workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'глубже', feedbackImages: IMG, answerFor: 'human' }, 'старый ответ')
    const clar = answer.slice(answer.indexOf('# Уточнение к прошлому ответу'))
    assert.ok(clar.includes(`\`${IMG[0]}\``))
    assert.ok(clar.indexOf(IMG[0]) < clar.indexOf('Дай новый полный ответ'), 'картинки — до итоговой просьбы')
    assert.equal(
      workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'глубже', answerFor: 'human' }, 'старый ответ').includes('изображени'), false
    )
  })

  it('картинки без замечаний воркеру не показываются: без текста нет и блока', () => {
    assert.ok(!workerTaskPrompt({ title: 'T', spec: 'S', feedbackImages: IMG }).includes(IMG[0]))
  })

  it('координатор: блок «# Этап» и старый формат несут пути и просьбу пересказать словами', () => {
    const stage = { title: 'Работа', visit: 2, feedback: 'не так', images: IMG2 }
    const obj = resumeCoordinatorObjective('цель', [], [], stage)
    assert.ok(obj.includes(`\`${IMG2[0]}\``))
    assert.ok(obj.indexOf(IMG2[0]) > obj.indexOf('## Замечания проверки или человека'))
    assert.match(obj, /Воркеры этих файлов не видят/)
    assert.equal(resumeCoordinatorObjective('цель', [], [], { title: 'Работа', visit: 2, feedback: 'не так' }).includes('изображени'), false)

    const legacy = resumeCoordinatorObjective('цель', [], [{ text: 'дорабатывай', images: IMG2 }])
    assert.ok(legacy.includes(`\`${IMG2[0]}\``))
    assert.ok(legacy.indexOf(IMG2[0]) > legacy.indexOf('дорабатывай'))
    assert.equal(resumeCoordinatorObjective('цель', [], [{ text: 'дорабатывай' }]).includes('изображени'), false)
  })
})
