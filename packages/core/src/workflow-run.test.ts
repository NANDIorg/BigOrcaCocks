// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Воркфлоу на уровне глобальной задачи: позиция на графе в `Run.stage`, этапы, события, approval прогона, конец графа.
// Контракт — docs/workflow.md («Воркфлоу глобальной задачи»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_HISTORY_LIMIT } from './status-history.ts'
import { TaskStore, EVENT_ANSWER_LIMIT, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, type OrcaEvent } from './types.ts'
import {
  defaultWorkflow, legacyDefaultWorkflow, pipelineWorkflow, toTaskScopeWorkflow, validateWorkflow, wfNodeTitle, type Workflow
} from './workflow.ts'
import { presetTaskType, runTypeInput } from './task-types.ts'

/** Хранилище в памяти: снапшот проходит через JSON, как файл на диске. */
function memory(): Persistence & { data: Partial<StoreSnapshot> | null } {
  const p = {
    data: null as Partial<StoreSnapshot> | null,
    load: () => p.data,
    save: (s: StoreSnapshot) => { p.data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
  return p
}

const store = (p?: Persistence) => new TaskStore(p, () => DEFAULT_COLUMNS)
const ROLES = ['developer', 'reviewer', 'qa', 'frontend', 'backend']
const opts = { roleIds: ROLES }

/** Прогон с дефолтным графом (работа → ревью агентом → «Проверка» человеком → конец), граф уже начат. */
function started(wf: Workflow = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])) {
  const s = store()
  const run = s.createRun('цель', undefined, wf)
  s.setRunPty(run.id, 'pty_c', 'claude')
  const entered = s.enterRunStage(run.id, { ...opts, commit: 'abc123' })
  return { s, run, entered }
}

const events = (s: TaskStore, type: OrcaEvent['type']): OrcaEvent[] => s.listEvents().filter((e) => e.type === type)
const finish = (s: TaskStore, taskId: string): void => { s.updateTask(taskId, { status: 'done' }) }

describe('прогон с воркфлоу глобальной задачи: workflowScope', () => {
  it('граф версии 2 (в том числе через тип) — scope run; без графа, с графом версии 1 и «Входящие» — старый движок', () => {
    const s = store()
    assert.equal(s.createRun('с v2', undefined, defaultWorkflow([])).workflowScope, 'run')
    assert.equal(s.createRun('с типом', undefined, runTypeInput(presetTaskType('general')!)).workflowScope, 'run')
    assert.equal(s.createGlobalTask({ title: 'через global', type: runTypeInput(presetTaskType('docs')!) }).workflowScope, 'run')
    assert.equal(s.createRun('с v1', undefined, legacyDefaultWorkflow([])).workflowScope, undefined)
    assert.equal(s.createRun('без графа').workflowScope, undefined)
    const orphan = s.createTask({ title: 'Во «Входящих»' })
    assert.equal(s.getRun(orphan.runId!)!.workflowScope, undefined)
  })

  it('смена типа до начала работы пересчитывает scope; в GlobalTask — scope, stage и история', () => {
    const s = store()
    const g = s.createGlobalTask({ title: 'Задача', type: runTypeInput(presetTaskType('general')!) })
    assert.equal(g.workflowScope, 'run')
    assert.equal(g.stage, undefined)
    const legacyType = { ...runTypeInput(presetTaskType('general')!), workflow: legacyDefaultWorkflow([]) }
    assert.equal(s.changeGlobalTaskType(g.id, legacyType).workflowScope, undefined)
    assert.equal(s.changeGlobalTaskType(g.id, runTypeInput(presetTaskType('backend')!)).workflowScope, 'run')
    s.enterRunStage(g.id)
    const after = s.getGlobalTask(g.id)
    assert.equal(after.stage?.nodeId, 'work')
    assert.equal(after.stageHistory?.[0].nodeId, 'work')
  })

  it('runWorkflow: прогон scope run — граф прогона или дефолтный v2; старый движок — граф подзадач (v2 типа переводится в v1)', () => {
    const s = store()
    const run = s.createRun('цель', undefined, defaultWorkflow([{ id: 'developer' }]))
    assert.equal(s.runWorkflow(run.id).version, 2)
    const typed = s.createGlobalTask({ title: 'тип без графа', type: { typeId: 'x', snapshot: { id: 'x', title: 'X', roles: [] } } })
    assert.equal(s.getRun(typed.id)!.workflowScope, 'run', 'тип без своего графа: граф даст запасной вариант')
    assert.deepEqual(s.runWorkflow(typed.id, ['developer']), defaultWorkflow([{ id: 'developer' }]))
    assert.equal(s.getRun(s.createGlobalTask({ title: 'без типа и графа' }).id)!.workflowScope, undefined)
    const inbox = s.createTask({ title: 'Входящая' })
    const wf = s.runWorkflow(inbox.runId, { roleIds: ['developer', 'reviewer'], workflow: defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }]) })
    assert.equal(wf.version, 1, 'подзадача из «Входящих» ходит по графу подзадач')
    assert.deepEqual(wf.nodes.map((n) => n.id), ['start', 'work', 'review', 'end', 'merge', 'conflict'])
  })
})

describe('enterRunStage / advanceRunStage', () => {
  it('вход: стартовая позиция, история с коммитом, stage_changed и stage_started; карточка «В работе»', () => {
    const { s, run, entered } = started()
    assert.deepEqual(entered.action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
    const r = s.getRun(run.id)!
    assert.deepEqual(r.stage, { nodeId: 'work', visits: { start: 1, work: 1 } })
    assert.equal(r.stageHistory?.length, 1)
    assert.deepEqual({ ...r.stageHistory![0], at: 0, by: 'x' }, { nodeId: 'work', title: 'Реализация', at: 0, outcome: 'next', visit: 1, commit: 'abc123', by: 'x' })
    assert.equal(s.columnKind(r.status!), 'in_progress')
    assert.ok(r.workflow, 'граф зафиксирован снимком, если у прогона его не было')
    const started1 = events(s, 'stage_started')
    assert.equal(started1.length, 1)
    assert.deepEqual(started1[0].payload, { runId: run.id, nodeId: 'work', title: 'Реализация', roleIds: [], visit: 1 })
    assert.equal(started1[0].taskId, undefined, 'событие прогона без taskId')
    const changed = events(s, 'stage_changed')[0].payload
    assert.deepEqual([changed.runId, changed.to, changed.nodeType], [run.id, 'work', 'work'])
  })

  it('повторный enterRunStage позицию не двигает и возвращает действие текущей ноды; события не дублируются', () => {
    const { s, run } = started()
    const again = s.enterRunStage(run.id, opts)
    assert.deepEqual(again.action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
    assert.equal(events(s, 'stage_started').length, 1)
    assert.equal(s.getRun(run.id)!.stageHistory!.length, 1)
  })

  it('старый прогон и «Входящие» по графу не ходят — ошибка с причиной', () => {
    const s = store()
    const old = s.createRun('старый', undefined, legacyDefaultWorkflow([]))
    assert.throws(() => s.enterRunStage(old.id), /воркфлоу подзадач/)
    assert.throws(() => s.advanceRunStage(old.id, 'next'), /воркфлоу подзадач/)
    const fresh = s.createRun('свежий', undefined, defaultWorkflow([]))
    assert.throws(() => s.advanceRunStage(fresh.id, 'next'), /ещё не начат/)
  })

  it('нельзя выйти из ноды по чужому исходу: blocked с причиной, позиция остаётся', () => {
    const { s, run } = started()
    const step = s.advanceRunStage(run.id, 'accept', opts)
    assert.equal(step.action.type, 'blocked')
    assert.equal(s.getRun(run.id)!.stage!.nodeId, 'work')
    const [blocked] = events(s, 'workflow_blocked')
    assert.deepEqual([blocked.payload.runId, blocked.payload.nodeId, blocked.taskId], [run.id, 'work', undefined])
    assert.match(String(blocked.payload.reason), /нет перехода для accept/)
  })

  it('роль этапа удалили после сохранения графа — blocked с причиной на входе', () => {
    const s = store()
    const run = s.createRun('цель', undefined, pipelineWorkflow([{ type: 'gate', id: 'review', roleId: 'reviewer' }], { roleIds: ['developer'] }))
    const { action } = s.enterRunStage(run.id, { roleIds: ['reviewer'] })
    assert.equal(action.type, 'blocked')
    assert.match(action.type === 'blocked' ? action.reason : '', /нет роли «developer» в проекте/)
    assert.equal(events(s, 'stage_started').length, 0)
    assert.equal(events(s, 'workflow_blocked')[0].payload.runId, run.id)
  })
})

describe('createTask в воркфлоу прогона: роль и этап', () => {
  const stageWithRoles = (roleIds: string[] | undefined) => started(pipelineWorkflow(
    [{ type: 'gate', id: 'review', roleId: 'reviewer' }], roleIds ? { roleIds } : {}
  ))

  it('этап без ролей: подойдёт любая рабочая роль типа, задача привязана к заходу (stageOf); роль на выбор вызывающего', () => {
    const { s, run } = stageWithRoles(undefined)
    assert.deepEqual(s.runStage(run.id)!.roleIds, undefined, 'этап не ограничивает роли')
    const t = s.createTask({ title: 'A', runId: run.id })
    assert.deepEqual(t.stageOf, { nodeId: 'work', visit: 1 })
    assert.equal(t.roleId, 'developer', 'роль не передана — как у обычной задачи')
    for (const roleId of ['developer', 'qa', 'frontend']) assert.equal(s.createTask({ title: roleId, runId: run.id, roleId }).roleId, roleId)
    assert.equal(s.stageDefaultRole(run.id), undefined, 'роли по умолчанию у этапа без ролей нет')
  })

  it('assertStageAcceptsTasks: на «Работе» отдаёт ноду, вне неё — ошибка про stage_started; граф не начат и старый формат — без проверки', () => {
    const { s, run } = stageWithRoles(undefined)
    assert.equal(s.assertStageAcceptsTasks(run.id)?.id, 'work')
    const t = s.createTask({ title: 'A', runId: run.id })
    finish(s, t.id)
    s.finishStage(run.id, opts)
    assert.throws(() => s.assertStageAcceptsTasks(run.id), /только на этапе «Работа».*«Проверка».*дождись stage_started/)
    assert.equal(s.assertStageAcceptsTasks(s.createRun('не начат', undefined, defaultWorkflow([])).id), undefined)
    assert.equal(s.assertStageAcceptsTasks(s.createRun('старый', undefined, legacyDefaultWorkflow([])).id), undefined)
    assert.equal(s.assertStageAcceptsTasks('run_nope'), undefined)
  })

  it('этап без ролей: служебные роли и роль gate графа не подходят', () => {
    const { s, run } = stageWithRoles(undefined)
    assert.throws(() => s.createTask({ title: 'X', runId: run.id, roleId: 'coordinator' }), /роль «coordinator» не разрешена на этапе «Реализация».*рабочие роли типа/)
    assert.throws(() => s.createTask({ title: 'X', runId: run.id, roleId: 'assistant' }), /не разрешена/)
    assert.throws(() => s.createTask({ title: 'X', runId: run.id, roleId: 'reviewer' }), /роль «reviewer» не разрешена/)
  })

  it('этап с несколькими ролями: только из списка, роль без --role не угадывается', () => {
    const { s, run } = stageWithRoles(['frontend', 'backend'])
    assert.deepEqual(events(s, 'stage_started')[0].payload.roleIds, ['frontend', 'backend'], 'stage_started несёт роли этапа')
    assert.equal(s.createTask({ title: 'F', runId: run.id, roleId: 'frontend' }).roleId, 'frontend')
    assert.equal(s.createTask({ title: 'B', runId: run.id, roleId: 'backend' }).roleId, 'backend')
    assert.throws(
      () => s.createTask({ title: 'C', runId: run.id, roleId: 'qa' }),
      /роль «qa» не разрешена на этапе «Реализация»: его ведут агенты ролей «frontend», «backend»/
    )
    assert.equal(s.stageDefaultRole(run.id), undefined)
    assert.deepEqual(s.runStage(run.id)!.roleIds, ['frontend', 'backend'])
  })

  it('этап с одной ролью: без --role берётся она, чужая — ошибка с понятным текстом', () => {
    const { s, run } = stageWithRoles(['developer'])
    const t = s.createTask({ title: 'A', runId: run.id })
    assert.equal(t.roleId, 'developer')
    assert.deepEqual(t.stageOf, { nodeId: 'work', visit: 1 })
    assert.equal(s.createTask({ title: 'B', runId: run.id, roleId: 'developer' }).roleId, 'developer')
    assert.equal(s.stageDefaultRole(run.id), 'developer')
    assert.throws(
      () => s.createTask({ title: 'C', runId: run.id, roleId: 'qa' }),
      /роль «qa» не разрешена на этапе «Реализация»: его ведут агенты ролей «developer»/
    )
  })

  it('stageDefaultRole: вне этапа «Работа», до входа в граф и у старого прогона — undefined', () => {
    const { s, run } = stageWithRoles(['developer'])
    finish(s, s.createTask({ title: 'A', runId: run.id }).id)
    s.finishStage(run.id, opts)
    assert.equal(s.getRun(run.id)!.stage!.nodeId, 'review')
    assert.equal(s.stageDefaultRole(run.id), undefined)
    const fresh = s.createRun('цель', undefined, defaultWorkflow([]))
    assert.equal(s.stageDefaultRole(fresh.id), undefined)
    assert.equal(s.stageDefaultRole(s.createRun('старый', undefined, legacyDefaultWorkflow([])).id), undefined)
    assert.equal(s.stageDefaultRole('run_none'), undefined)
  })

  it('вне этапа «Работа» — ошибка «дождись stage_started»; проверка ветки прогона (gateFor.runId) и вопрос этапа — можно', () => {
    const { s, run } = started()
    const t = s.createTask({ title: 'A', runId: run.id })
    finish(s, t.id)
    s.finishStage(run.id, opts)
    assert.equal(s.getRun(run.id)!.stage!.nodeId, 'review')
    assert.throws(() => s.createTask({ title: 'D', runId: run.id }), /только на этапе «Работа».*этапе «Ревью».*stage_started/)
    const gate = s.createTask({ title: 'Ревью: ветка', runId: run.id, roleId: 'reviewer', gateFor: { runId: run.id, nodeId: 'review' } })
    assert.deepEqual(gate.gateFor, { runId: run.id, nodeId: 'review' })
    assert.equal(gate.stageOf, undefined)
    assert.throws(() => s.createTask({ title: 'x', runId: run.id, gateFor: { nodeId: 'review' } }), /ровно одно/)
    assert.throws(() => s.createTask({ title: 'x', runId: run.id, gateFor: { runId: 'run_other', nodeId: 'review' } }), /в этой же глобальной задаче/)
    const inbox = s.createTask({ title: 'Входящая' })
    assert.throws(() => s.createTask({ title: 'y', runId: inbox.runId, gateFor: { runId: inbox.runId!, nodeId: 'review' } }), /воркфлоу прогона/)
  })

  it('до входа в граф ограничений нет: задача без этапа; у старого прогона stageOf запрещён', () => {
    const s = store()
    const run = s.createRun('цель', undefined, defaultWorkflow([]))
    const t = s.createTask({ title: 'Заготовка', runId: run.id, roleId: 'qa' })
    assert.deepEqual([t.roleId, t.stageOf], ['qa', undefined])
    const old = s.createRun('старый', undefined, legacyDefaultWorkflow([]))
    assert.throws(() => s.createTask({ title: 'x', runId: old.id, stageOf: { nodeId: 'work', visit: 1 } }), /старого формата/)
  })

  it('задача-вопрос этапа ask создаётся приложением с явным stageOf', () => {
    const wf = defaultWorkflow([{ id: 'developer' }])
    wf.nodes.push({ id: 'q', type: 'ask', roleId: 'analyst', instructions: 'спроси', x: 0, y: 0 })
    wf.edges = wf.edges.filter((e) => e.id !== 'e_start')
    wf.edges.push({ id: 'e_start', from: 'start', outcome: 'next', to: 'q' }, { id: 'e_q', from: 'q', outcome: 'next', to: 'work' })
    const s = store()
    const run = s.createRun('цель', undefined, wf)
    const { action } = s.enterRunStage(run.id, { roleIds: ['developer', 'analyst'] })
    assert.deepEqual(action, { type: 'create_ask', nodeId: 'q', roleId: 'analyst' })
    assert.equal(events(s, 'stage_started').length, 0, 'ask — не работа: координатору событие не шлётся')
    assert.throws(() => s.createTask({ title: 'Вопрос', runId: run.id, roleId: 'analyst' }), /только на этапе «Работа»/)
    const q = s.createTask({ title: 'Вопрос', runId: run.id, roleId: 'analyst', stageOf: { nodeId: 'q', visit: 1 } })
    assert.deepEqual(q.stageOf, { nodeId: 'q', visit: 1 })
    assert.throws(() => s.createTask({ title: 'x', runId: run.id, stageOf: { nodeId: 'ghost', visit: 1 } }), /нет ноды «ghost»/)
  })
})

describe('stage_tasks_done и stage finish', () => {
  it('все подзадачи заходов в done → один stage_tasks_done; новая или снятая с done задача снимает метку и гасит событие', () => {
    const { s, run } = started()
    const a = s.createTask({ title: 'A', runId: run.id })
    const b = s.createTask({ title: 'B', runId: run.id })
    finish(s, a.id)
    assert.equal(events(s, 'stage_tasks_done').length, 0, 'вторая задача ещё не закрыта')
    finish(s, b.id)
    assert.equal(events(s, 'stage_tasks_done').length, 1)
    assert.deepEqual(events(s, 'stage_tasks_done')[0].payload, { runId: run.id, nodeId: 'work' })
    assert.notEqual(s.getRun(run.id)!.stageTasksDoneAt, undefined)
    assert.equal(events(s, 'run_done').length, 0, 'старое автозакрытие для прогона с воркфлоу не работает')
    assert.equal(s.getRun(run.id)!.closedAt, undefined)
    // Координатор решил добавить задачу: метка снята, непрочитанное событие погашено, новое придёт по завершении.
    const c = s.createTask({ title: 'C', runId: run.id })
    assert.equal(s.getRun(run.id)!.stageTasksDoneAt, undefined)
    assert.equal(s.consumeEvents(['stage_tasks_done'], 'coord', run.id).length, 0)
    finish(s, c.id)
    assert.equal(events(s, 'stage_tasks_done').length, 2)
    s.updateTask(a.id, { status: 'ready' })
    assert.equal(s.getRun(run.id)!.stageTasksDoneAt, undefined)
  })

  it('finishStage: нет подзадач и не закрыты — ошибки; вне «Работы» — ошибка; успех — сводка, действие следующей ноды', () => {
    const { s, run } = started()
    assert.throws(() => s.finishStage(run.id, opts), /нет подзадач/)
    const a = s.createTask({ title: 'A', runId: run.id })
    assert.throws(() => s.finishStage(run.id, opts), new RegExp(`не закрыты подзадачи \\(${a.id}\\)`))
    finish(s, a.id)
    const { action } = s.finishStage(run.id, { ...opts, summary: '  Сделал A.  ' })
    assert.deepEqual(action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    const r = s.getRun(run.id)!
    assert.equal(r.stage!.nodeId, 'review')
    assert.equal(r.stageHistory!.find((h) => h.nodeId === 'work')!.summary, 'Сделал A.')
    assert.equal(r.summary?.text, 'Сделал A.', 'сводка — в «Что сделал» карточки')
    assert.equal(s.getGlobalTask(run.id).summary?.text, 'Сделал A.')
    assert.equal(r.stageTasksDoneAt, undefined)
    assert.throws(() => s.finishStage(run.id, opts), /сейчас не на этапе «Работа» \(этап «Ревью»\)/)
    assert.equal(s.columnKind(r.status!), 'in_progress', 'на гейте карточка остаётся «В работе»')
  })

  it('finishStage без сводки прежнюю Run.summary не стирает', () => {
    const { s, run } = started()
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    s.finishStage(run.id, { ...opts, summary: 'первая' })
    s.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'нет' })
    const b = s.createTask({ title: 'B', runId: run.id })
    finish(s, b.id)
    s.finishStage(run.id, opts)
    assert.equal(s.getRun(run.id)!.summary?.text, 'первая')
  })

  it('settleIdleStages: координатор мёртв — этап закрывается без сводки; живой — ждём; без закрытых задач — нет', () => {
    const { s, run } = started()
    assert.deepEqual(s.settleIdleStages(() => false), [])
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    assert.deepEqual(s.settleIdleStages(() => true), [], 'координатор жив — он сам решит')
    const settled = s.settleIdleStages((pty) => pty !== 'pty_c', () => opts)
    assert.deepEqual(settled, [{ runId: run.id, action: { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' } }])
    assert.equal(s.getRun(run.id)!.stage!.nodeId, 'review')
    assert.deepEqual(s.settleIdleStages(() => false), [], 'повторно не закрывается')
  })
})

describe('reject: возврат в работу с замечаниями', () => {
  it('reject гейта → «Работа» второго захода: stage_started с feedback, Run.returns, задачи прошлого захода не в счёт', () => {
    const { s, run } = started()
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    s.finishStage(run.id, { ...opts, summary: 'сделано' })
    const { action } = s.advanceRunStage(run.id, 'reject', { ...opts, feedback: '  Нет тестов  ', commit: 'def456' })
    assert.deepEqual(action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
    const r = s.getRun(run.id)!
    assert.equal(r.stage!.visits.work, 2)
    assert.equal(r.returns?.length, 1)
    assert.equal(r.returns![0].text, 'Нет тестов')
    assert.deepEqual(r.stageInput, { feedback: 'Нет тестов' })
    assert.equal(r.stageHistory!.at(-1)!.commit, 'def456')
    assert.equal(r.stageHistory!.at(-1)!.visit, 2)
    assert.equal(r.stageHistory!.at(-1)!.outcome, 'reject')
    const second = events(s, 'stage_started').at(-1)!.payload
    assert.deepEqual([second.visit, second.feedback], [2, 'Нет тестов'])
    // Старая задача (заход 1) закрыта, но новый заход пуст: stage_tasks_done не приходит, finish — «нет подзадач».
    assert.equal(s.getRun(run.id)!.stageTasksDoneAt, undefined)
    assert.throws(() => s.finishStage(run.id, opts), /нет подзадач/)
    const fix = s.createTask({ title: 'Правки', runId: run.id })
    assert.deepEqual(fix.stageOf, { nodeId: 'work', visit: 2 })
    finish(s, fix.id)
    assert.equal(events(s, 'stage_tasks_done').length, 2, 'каждый заход закрывается своим событием')
  })

  it('длинный feedback в событии обрезан с признаком, целиком — в runStage', () => {
    const { s, run } = started()
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    s.finishStage(run.id, opts)
    const long = 'я'.repeat(EVENT_ANSWER_LIMIT + 50)
    s.advanceRunStage(run.id, 'reject', { ...opts, feedback: long })
    const p = events(s, 'stage_started').at(-1)!.payload
    assert.equal((p.feedback as string).length, EVENT_ANSWER_LIMIT)
    assert.equal(p.feedbackTruncated, true)
    assert.equal(s.runStage(run.id, opts)!.feedback, long)
  })

  it('runStage: этап, роль, инструкции, показ, подзадачи захода; нет позиции — undefined', () => {
    const wf = defaultWorkflow([{ id: 'developer' }])
    Object.assign(wf.nodes.find((n) => n.id === 'work')!, { instructions: ' Сделай ', showcase: { what: 'макеты', required: true } })
    const s = store()
    const run = s.createRun('цель', undefined, wf)
    assert.equal(s.runStage(run.id), undefined)
    s.enterRunStage(run.id)
    const t = s.createTask({ title: 'A', runId: run.id })
    assert.deepEqual(s.runStage(run.id), {
      runId: run.id, nodeId: 'work', type: 'work', title: 'Реализация', visit: 1, instructions: 'Сделай',
      showcase: { what: 'макеты', required: true }, tasks: [t.id]
    })
    assert.equal(s.runStage(s.createRun('старый', undefined, legacyDefaultWorkflow([])).id), undefined)
  })

  it('обязательный показ этапа наследуют подзадачи: done без показа — ошибка (taskWorkStage по stageOf)', () => {
    const wf = defaultWorkflow([{ id: 'developer' }])
    Object.assign(wf.nodes.find((n) => n.id === 'work')!, { title: 'Дизайн', showcase: { what: 'варианты макета', required: true } })
    const s = store()
    const run = s.createRun('цель', undefined, wf)
    s.enterRunStage(run.id)
    const t = s.createTask({ title: 'A', runId: run.id })
    const d = s.startDispatch(t.id, 'pty')
    assert.equal(s.taskWorkStage(t.id)!.title, 'Дизайн')
    assert.equal(s.taskStageNode(t.id)?.type, 'work')
    assert.throws(() => s.finishDispatch(d.id, 'готово'), /этап «Дизайн» требует показ человеку/)
    s.finishDispatch(d.id, 'готово', [], undefined, { showcase: { text: '# Варианты', files: [] } })
    assert.equal(s.getTask(t.id)!.status, 'review')
  })
})

describe('approval прогона: нода human', () => {
  /** Прогон на «Проверке человеком»: работа закрыта, ревью принято. */
  function atHuman() {
    const h = started()
    const a = h.s.createTask({ title: 'A', runId: h.run.id })
    finish(h.s, a.id)
    h.s.finishStage(h.run.id, { ...opts, summary: 'готово' })
    const { action } = h.s.advanceRunStage(h.run.id, 'accept', opts)
    assert.deepEqual(action, { type: 'request_human', nodeId: 'check' })
    return h
  }

  it('карточка встаёт на «Проверку»; requestRunApproval создаёт запрос без задачи, повтор не дублирует; карточка «Нужен ответ»', () => {
    const { s, run } = atHuman()
    assert.equal(s.columnKind(s.getRun(run.id)!.status!), 'review')
    const req = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка человеком', body: 'Что сделано' })
    assert.deepEqual([req.runId, req.taskId, req.kind, req.status, req.nodeId], [run.id, undefined, 'approval', 'pending', 'check'])
    assert.equal(s.requestRunApproval(run.id, { nodeId: 'check', title: 'ещё' }).id, req.id)
    assert.equal(s.pendingRequests(run.id).length, 1)
    const created = events(s, 'request_created').at(-1)!
    assert.deepEqual([created.payload.runId, created.payload.requestId, created.taskId], [run.id, req.id, undefined])
    assert.equal(s.getGlobalTask(run.id).waiting, 1)
    assert.equal(s.getGlobalTask(run.id).status, 'review', 'на «Проверке» карточка в needs_input не поднимается')
  })

  it('решение человека: accept/reject с текстом — request_resolved по runId, а переход делает исполнитель', () => {
    const { s, run } = atHuman()
    const req = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.resolveRequest(req.id, { action: 'reject', text: '  Поправь кнопку  ' })
    const resolved = events(s, 'request_resolved').at(-1)!
    assert.deepEqual(
      [resolved.taskId, resolved.payload.runId, resolved.payload.action, resolved.payload.nodeId, resolved.payload.decision],
      [undefined, run.id, 'reject', 'check', 'Поправь кнопку']
    )
    assert.equal(s.getRequest(req.id)!.resolution?.text, 'Поправь кнопку')
    assert.equal(s.getRun(run.id)!.stage!.nodeId, 'check', 'store сам граф не двигает')
    assert.throws(() => s.resolveRequest(req.id, { action: 'accept' }), /уже решено/)
    assert.throws(() => s.resolveRequest(s.requestRunApproval(run.id, { nodeId: 'check', title: 'ещё раз' }).id, { action: 'clarify', text: 'x' }), /недопустимо/)
  })

  it('«Подтвердить» и «Вернуть в работу» на карточке решают ждущий approval; без запроса — понятная ошибка', () => {
    const { s, run } = atHuman()
    assert.throws(() => s.acceptGlobalTask(run.id), /нет запроса на проверку/)
    assert.throws(() => s.returnGlobalTask(run.id, 'доработай'), /нет запроса на проверку/)
    assert.throws(() => s.returnGlobalTask(run.id, ' '), /напиши, что доделать/)
    const req = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.returnGlobalTask(run.id, 'доработай')
    assert.deepEqual([s.getRequest(req.id)!.status, s.getRequest(req.id)!.resolution], ['resolved', { action: 'reject', text: 'доработай' }])
    const second = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.acceptGlobalTask(run.id)
    assert.equal(s.getRequest(second.id)!.resolution?.action, 'accept')
  })

  it('«Подтвердить» с решением: текст (обрезанный) — в resolution и request_resolved.decision; пустой — как без решения', () => {
    const { s, run } = atHuman()
    const first = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.acceptGlobalTask(run.id, '  Вариант B  ')
    assert.deepEqual(s.getRequest(first.id)!.resolution, { action: 'accept', text: 'Вариант B' })
    assert.equal(events(s, 'request_resolved').at(-1)!.payload.decision, 'Вариант B')
    const second = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.acceptGlobalTask(run.id, '   ')
    assert.deepEqual(s.getRequest(second.id)!.resolution, { action: 'accept' })
  })

  it('accept человека → конец графа: прогон закрыт, «Сделано», run_done с nodeId; runs finish после этого — сигнал, до — ошибка', () => {
    const { s, run } = atHuman()
    assert.throws(() => s.finishRun(run.id), /воркфлоу ведёт граф.*stage finish/)
    const { action } = s.advanceRunStage(run.id, 'accept', opts)
    assert.deepEqual(action, { type: 'done', nodeId: 'end', merged: false })
    const r = s.getRun(run.id)!
    assert.notEqual(r.closedAt, undefined)
    assert.equal(s.columnKind(r.status!), 'done')
    assert.equal(r.stage!.nodeId, 'end')
    const [done] = events(s, 'run_done')
    assert.deepEqual([done.payload.runId, done.payload.nodeId], [run.id, 'end'])
    assert.equal(events(s, 'run_done').length, 1, 'run_done один: конец графа, а не «все подзадачи закрыты»')
    assert.throws(() => s.advanceRunStage(run.id, 'accept', opts), /уже дошёл до конца/)
    assert.equal(s.finishRun(run.id, 'итог').finishedAt !== undefined, true, 'runs finish после run_done — синоним «закончил»')
    assert.equal(s.getRun(run.id)!.summary?.text, 'итог')
    assert.equal(events(s, 'run_done').length, 1)
  })

  it('конец графа отменяет ждущие запросы прогона; approval при закрытом прогоне не рождается сам', () => {
    const { s, run } = atHuman()
    const req = s.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка' })
    s.advanceRunStage(run.id, 'accept', opts)
    assert.equal(s.getRequest(req.id)!.status, 'cancelled')
  })
})

describe('граф без человека и ноды merge/git/условия в прогоне', () => {
  it('граф без human: гейт → конец; прогон закрывается сам, карточка в «Сделано»', () => {
    const wf = pipelineWorkflow([{ type: 'gate', id: 'review', roleId: 'reviewer' }], { roleIds: ['developer'] })
    wf.edges.find((e) => e.id === 'e_check_accept')!.to = 'end'
    const { s, run } = started(wf)
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    s.finishStage(run.id, opts)
    assert.equal(s.advanceRunStage(run.id, 'accept', opts).action.type, 'request_human')
    // Ветка accept гейта ведёт в человека; переделаем: гейт → конец.
    const direct = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
    direct.edges.find((e) => e.id === 'e_review_accept')!.to = 'end'
    const t = started(direct)
    const b = t.s.createTask({ title: 'B', runId: t.run.id })
    finish(t.s, b.id)
    t.s.finishStage(t.run.id, opts)
    assert.equal(t.s.advanceRunStage(t.run.id, 'accept', opts).action.type, 'done')
    assert.equal(t.s.columnKind(t.s.getRun(t.run.id)!.status!), 'done')
    assert.ok(validateWorkflow(direct, { roles: [{ id: 'developer', title: 'д', agent: 'claude' }, { id: 'reviewer', title: 'р', agent: 'claude' }] })
      .warnings.some((w) => w.code === 'noHumanBeforeEnd'))
  })

  it('нода git и merge прогона — действия для main; колонка ноды переносит карточку', () => {
    const wf = defaultWorkflow([{ id: 'developer' }])
    wf.nodes.push(
      { id: 'save', type: 'git', operation: 'commit', message: 'wip', column: 'review', x: 0, y: 0 },
      { id: 'merge', type: 'merge', x: 0, y: 0 }
    )
    wf.edges = wf.edges.filter((e) => e.id !== 'e_work')
    wf.edges.push(
      { id: 'e_work', from: 'work', outcome: 'next', to: 'save' },
      { id: 'e_save_ok', from: 'save', outcome: 'ok', to: 'merge' },
      { id: 'e_save_error', from: 'save', outcome: 'error', to: 'check' },
      { id: 'e_merge_ok', from: 'merge', outcome: 'ok', to: 'check' },
      { id: 'e_merge_conflict', from: 'merge', outcome: 'conflict', to: 'check' }
    )
    assert.deepEqual(validateWorkflow(wf, { roles: [{ id: 'developer', title: 'д', agent: 'claude' }] }).errors, [])
    const s = store()
    const run = s.createRun('цель', undefined, wf)
    s.enterRunStage(run.id)
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    const g = s.finishStage(run.id)
    assert.deepEqual(g.action, { type: 'git', nodeId: 'save', operation: 'commit', message: 'wip' })
    assert.equal(s.columnKind(s.getRun(run.id)!.status!), 'review', 'column ноды применяется, если это колонка глобальной доски')
    const m = s.advanceRunStage(run.id, 'ok')
    assert.deepEqual(m.action, { type: 'merge', nodeId: 'merge' })
    assert.equal(s.columnKind(s.getRun(run.id)!.status!), 'in_progress')
    s.blockRunStage(run.id, 'слияние в защищённую ветку develop запрещено')
    const blocked = events(s, 'workflow_blocked').at(-1)!
    assert.deepEqual([blocked.payload.runId, blocked.payload.nodeId, blocked.taskId], [run.id, 'merge', undefined])
  })

  it('condition attempts считается по Run.stage.visits: третий отказ уходит к человеку', () => {
    const wf = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
    wf.nodes.push({ id: 'limit', type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 3 }, x: 0, y: 0 })
    wf.edges.find((e) => e.id === 'e_review_reject')!.to = 'limit'
    wf.edges.push({ id: 'e_l_yes', from: 'limit', outcome: 'yes', to: 'check' }, { id: 'e_l_no', from: 'limit', outcome: 'no', to: 'work' })
    const { s, run } = started(wf)
    for (let i = 1; i <= 2; i++) {
      const t = s.createTask({ title: `T${i}`, runId: run.id })
      finish(s, t.id)
      s.finishStage(run.id, opts)
      assert.equal(s.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'нет' }).action.type, 'start_stage', `отказ ${i}`)
    }
    const last = s.createTask({ title: 'T3', runId: run.id })
    finish(s, last.id)
    s.finishStage(run.id, opts)
    assert.equal(s.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'опять' }).action.type, 'request_human')
    assert.equal(s.getRun(run.id)!.stage!.visits.limit, 3)
    assert.equal(s.getRun(run.id)!.returns!.length, 3)
  })
})

describe('старый движок подзадач не задет', () => {
  it('подзадача прогона на «Работе» ходит по пути ноды (store.test.ts, «путь подзадачи»); проверка ветки прогона и задача этапа ask — нет', () => {
    const { s, run } = started()
    const t = s.createTask({ title: 'A', runId: run.id })
    assert.equal(s.getTask(t.id)!.stage, undefined, 'создание задачи в путь не заводит')
    finish(s, t.id)
    s.finishStage(run.id, opts)
    const gate = s.createTask({ title: 'Ревью', runId: run.id, roleId: 'reviewer', gateFor: { runId: run.id, nodeId: 'review' } })
    assert.throws(() => s.advanceStage(gate.id, 'next'), /проверка глобальной задачи/)
    assert.equal(s.getTask(gate.id)!.gateFor?.runId, run.id)
    // worker_done проверки ветки прогона: gateFor в payload — id прогона.
    const d = s.startDispatch(gate.id, 'pty_g')
    s.finishDispatch(d.id, 'принято')
    assert.equal(events(s, 'worker_done').at(-1)!.payload.gateFor, run.id)
  })

  it('прогон старого формата: run_done и runs finish как раньше, миграция задач в ревью не трогает подзадачи прогона с воркфлоу', () => {
    const s = store()
    const old = s.createRun('старый', undefined, legacyDefaultWorkflow([]))
    s.setRunPty(old.id, 'pty', 'claude')
    const t = s.createTask({ title: 'A', runId: old.id })
    finish(s, t.id)
    assert.equal(events(s, 'run_done').length, 1)
    assert.notEqual(s.finishRun(old.id).closedAt, undefined)

    const p = memory()
    const s1 = store(p)
    const fresh = s1.createRun('новый', undefined, defaultWorkflow([]))
    const task = s1.createTask({ title: 'B', runId: fresh.id })
    const d = s1.startDispatch(task.id, 'pty2')
    s1.finishDispatch(d.id, 'ok')
    assert.equal(s1.getTask(task.id)!.status, 'review')
    const s2 = store(p)
    assert.equal(s2.getTask(task.id)!.stage, undefined, 'задача в ревью прогона с воркфлоу не получает этап старого движка')
  })
})

describe('рестарт приложения посреди графа', () => {
  it('позиция, история, stageInput, метка stage_tasks_done и approval переживают перезагрузку; граф продолжается', () => {
    const p = memory()
    const s1 = store(p)
    const run = s1.createRun('цель', undefined, defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }]))
    s1.setRunPty(run.id, 'pty_c', 'claude')
    s1.enterRunStage(run.id, { ...opts, commit: 'c1' })
    const a = s1.createTask({ title: 'A', runId: run.id })
    finish(s1, a.id)
    s1.finishStage(run.id, { ...opts, summary: 'итог этапа' })
    s1.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'замечание' })
    const b = s1.createTask({ title: 'B', runId: run.id })
    finish(s1, b.id)

    const s2 = store(p)
    const r = s2.getRun(run.id)!
    assert.equal(r.workflowScope, 'run')
    assert.deepEqual(r.stage!.visits, { start: 1, work: 2, review: 1 })
    assert.deepEqual(r.stageInput, { feedback: 'замечание' })
    assert.equal(r.stageHistory!.length, 3, 'работа → ревью → работа')
    assert.equal(r.stageHistory![0].summary, 'итог этапа')
    assert.equal(r.stageHistory![0].commit, 'c1')
    assert.notEqual(r.stageTasksDoneAt, undefined, 'метка не пересчитывается заново: stage_tasks_done не дублируется')
    assert.equal(events(s2, 'stage_tasks_done').length, 2)
    assert.deepEqual(s2.getTask(b.id)!.stageOf, { nodeId: 'work', visit: 2 })
    assert.deepEqual(s2.finishStage(run.id, opts).action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    assert.equal(s2.getGlobalTask(run.id).stage?.nodeId, 'review')
  })

  it('история этапов прогона обрезается до STATUS_HISTORY_LIMIT', () => {
    const { s, run } = started(pipelineWorkflow([], { roleIds: ['developer'] }))
    for (let i = 0; i < STATUS_HISTORY_LIMIT; i += 1) {
      s.advanceRunStage(run.id, 'next', opts)
      s.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'нет' })
    }
    assert.equal(s.getRun(run.id)!.stageHistory!.length, STATUS_HISTORY_LIMIT)
  })
})

describe('toTaskScopeWorkflow: граф типа для подзадач старого движка', () => {
  it('дефолт v2 → работа без роли → ревью → мерж → конец с конфликтом; финальная «Проверка» человеком снимается', () => {
    const wf = toTaskScopeWorkflow(defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }]))
    assert.equal(wf.version, 1)
    assert.deepEqual(wf.nodes.map((n) => n.id), ['start', 'work', 'review', 'end', 'merge', 'conflict'])
    assert.equal((wf.nodes.find((n) => n.id === 'work') as { roleId?: string }).roleId, undefined)
    const to = (id: string): string | undefined => wf.edges.find((e) => e.id === id)?.to
    assert.equal(to('e_review_accept'), 'merge')
    assert.equal(to('e_review_reject'), 'work')
    assert.equal(to('e_merge_ok'), 'end')
    assert.equal(to('e_conflict_reject'), 'work')
    assert.equal(wfNodeTitle(wf.nodes.find((n) => n.id === 'conflict')!), 'Конфликт мержа')
  })

  it('человек, который не финальная «Проверка», остаётся; граф со своим merge и граф версии 1 — без добавок; исходный не мутируется', () => {
    const eyes = pipelineWorkflow([{ type: 'human', id: 'eyes', title: 'Глазами' }], { roleId: 'developer' })
    const snapshot = structuredClone(eyes)
    const wf = toTaskScopeWorkflow(eyes)
    assert.deepEqual(eyes, snapshot)
    assert.equal(wf.nodes.find((n) => n.id === 'eyes')?.type, 'human')
    assert.equal(wf.edges.find((e) => e.id === 'e_eyes_accept')!.to, 'merge')
    const withMerge = structuredClone(eyes)
    withMerge.nodes.push({ id: 'merge', type: 'merge', x: 0, y: 0 })
    assert.equal(toTaskScopeWorkflow(withMerge).nodes.filter((n) => n.type === 'merge').length, 1)
    const v1 = legacyDefaultWorkflow([])
    assert.equal(toTaskScopeWorkflow(v1), v1)
  })
})
