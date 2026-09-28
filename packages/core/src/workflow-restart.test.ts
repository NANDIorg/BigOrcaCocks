// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Рестарт приложения при двух движках воркфлоу сразу: прогоны старого формата (без `Run.workflowScope`, граф по
// подзадачам версии 1) доживают по-старому, новые (`workflowScope: 'run'`, `Run.stage`) идут по графу глобальной
// задачи, и загрузка store не смешивает их. Контракт — docs/workflow.md («Миграция»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, type OrcaEvent } from './types.ts'
import { defaultWorkflow, legacyDefaultWorkflow, migrateWorkflow, type Workflow } from './workflow.ts'

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
const ROLES = [{ id: 'developer' }, { id: 'reviewer' }, { id: 'qa' }]
const ROLE_IDS = ROLES.map((r) => r.id)
const opts = { roleIds: ROLE_IDS }
const events = (s: TaskStore, type: OrcaEvent['type']): OrcaEvent[] => s.listEvents().filter((e) => e.type === type)

/** Снимок графа старого прогона: v1 с ролью на работе — как его сохраняло приложение до воркфлоу глобальной задачи. */
function legacyGraph(): Workflow {
  return legacyDefaultWorkflow(ROLES)
}

/** Старый прогон с координатором: подзадачи на разных этапах графа по подзадачам. */
function legacyBoard(p: Persistence) {
  const s = store(p)
  const run = s.createRun('старая цель', undefined, legacyGraph())
  s.setRunPty(run.id, 'pty_old', 'claude')
  // 1. На ревью-агенте: работа сдана, проверка создана и ждёт запуска.
  const onGate = s.createTask({ title: 'на ревью', runId: run.id })
  s.advanceStage(onGate.id, 'next')
  s.advanceStage(onGate.id, 'next')
  const gate = s.createTask({ title: 'Проверка', runId: run.id, roleId: 'reviewer' })
  s.updateTask(gate.id, { gateFor: { taskId: onGate.id, nodeId: 'review' } })
  s.moveTask(onGate.id, 'review')
  // 2. Мерж: этап merge выставлен, приложение упало, не дослав исход.
  const onMerge = s.createTask({ title: 'на мерже', runId: run.id })
  s.advanceStage(onMerge.id, 'next')
  s.advanceStage(onMerge.id, 'next')
  s.advanceStage(onMerge.id, 'accept', opts)
  s.moveTask(onMerge.id, 'review')
  // 3. Человек: конфликт мержа, approval ждёт решения.
  const onHuman = s.createTask({ title: 'конфликт', runId: run.id })
  s.advanceStage(onHuman.id, 'next')
  s.advanceStage(onHuman.id, 'next')
  s.advanceStage(onHuman.id, 'accept', opts)
  s.advanceStage(onHuman.id, 'conflict', opts)
  const approval = s.requestApproval(onHuman.id, { nodeId: 'conflict', title: 'Конфликт мержа' })
  // 4. В работе: воркер запущен, PTY не пережил перезапуск.
  const working = s.createTask({ title: 'в работе', runId: run.id })
  s.advanceStage(working.id, 'next')
  const dispatch = s.startDispatch(working.id, 'pty_w1')
  return { s, run, onGate, gate, onMerge, onHuman, approval, working, dispatch }
}

describe('рестарт: прогон старого формата (по подзадачам)', () => {
  it('подзадачи на гейте, мерже и «человеке» остаются на своих этапах; снимок графа v1 и отсутствие workflowScope сохранены', () => {
    const p = memory()
    const b = legacyBoard(p)
    const s2 = store(p)
    const run = s2.getRun(b.run.id)!
    assert.equal(run.workflowScope, undefined)
    assert.equal(run.stage, undefined, 'у прогона старого формата позиции нет — она у подзадач')
    assert.equal(run.workflow!.version, 1)
    assert.deepEqual(run.workflow, legacyGraph())
    assert.equal(s2.getTask(b.onGate.id)!.stage!.nodeId, 'review')
    assert.equal(s2.getTask(b.onMerge.id)!.stage!.nodeId, 'merge')
    assert.equal(s2.getTask(b.onHuman.id)!.stage!.nodeId, 'conflict')
    assert.deepEqual(s2.getTask(b.gate.id)!.gateFor, { taskId: b.onGate.id, nodeId: 'review' })
    assert.equal(s2.getTask(b.gate.id)!.stage, undefined, 'проверка своего этапа не получает')
    assert.deepEqual(s2.getTask(b.onGate.id)!.stageHistory!.map((e) => e.nodeId), ['work', 'review'], 'история этапов подзадачи не пересобирается')
    // Граф по-прежнему по подзадачам: переходы делает advanceStage, а не advanceRunStage.
    assert.equal(s2.advanceStage(b.onMerge.id, 'ok', opts).action.type, 'done')
    assert.equal(s2.advanceStage(b.onGate.id, 'reject', opts).action.type, 'start_worker')
    assert.throws(() => s2.advanceRunStage(b.run.id, 'next', opts), /старый формат|по подзадачам/)
  })

  it('approval «Конфликт мержа» переживает рестарт и решается как раньше', () => {
    const p = memory()
    const b = legacyBoard(p)
    const s2 = store(p)
    const pending = s2.pendingRequests(b.run.id).filter((r) => r.kind === 'approval')
    assert.deepEqual(pending.map((r) => [r.id, r.taskId, r.nodeId]), [[b.approval.id, b.onHuman.id, 'conflict']])
    s2.resolveRequest(b.approval.id, { action: 'accept' })
    assert.equal(s2.pendingRequests(b.run.id).some((r) => r.id === b.approval.id), false)
  })

  it('незакрытый dispatch закрывается как unknown, задача «В работе» — в ready и остаётся на этапе работы', () => {
    const p = memory()
    const b = legacyBoard(p)
    assert.equal(b.s.getTask(b.working.id)!.status, 'in_progress')
    const s2 = store(p)
    const d = s2.getDispatch(b.dispatch.id)!
    assert.equal(d.outcome, 'unknown')
    assert.notEqual(d.endedAt, undefined)
    const t = s2.getTask(b.working.id)!
    assert.equal(t.status, 'ready')
    assert.equal(t.stage!.nodeId, 'work')
    assert.equal(s2.enterWork(b.working.id, opts), undefined, 'повторный запуск воркера этап не меняет')
    assert.equal(s2.getTask(b.working.id)!.stage!.visits.work, 1)
    // Задачи в ревью и на «человеке» dispatch не открывали — их статус остаётся.
    assert.equal(s2.getTask(b.onGate.id)!.status, 'review')
  })

  it('задача старого прогона в review без этапа встаёт на ревью-гейт графа по подзадачам', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, legacyGraph())
    const t = s.createTask({ title: 'от кода до воркфлоу', runId: run.id })
    s.moveTask(t.id, 'review')
    const s2 = store(p)
    assert.equal(s2.getTask(t.id)!.stage!.nodeId, 'review')
  })

  it('run_done, отправленный до перезапуска, не повторяется; runs finish по-старому закрывает прогон', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, legacyGraph())
    s.setRunPty(run.id, 'pty_old', 'claude')
    const a = s.createTask({ title: 'A', runId: run.id })
    s.updateTask(a.id, { status: 'done' })
    assert.equal(events(s, 'run_done').length, 1)
    assert.notEqual(s.getRun(run.id)!.runDoneAt, undefined)

    const s2 = store(p)
    assert.equal(events(s2, 'run_done').length, 1, 'загрузка не шлёт run_done заново')
    assert.notEqual(s2.getRun(run.id)!.runDoneAt, undefined)
    assert.equal(s2.getRun(run.id)!.closedAt, undefined)
    const finished = s2.finishRun(run.id, 'итог')
    assert.notEqual(finished.closedAt, undefined)
    assert.equal(finished.summary?.text, 'итог')
    assert.equal(s2.getGlobalTask(run.id).status, 'review', 'карточка — на «Проверку»')
    assert.equal(events(s2, 'run_done').length, 1, 'run_done уже был — второго нет')
    assert.equal(store(p).getRun(run.id)!.closedAt, finished.closedAt, 'закрытие пережило ещё один рестарт')
  })

  it('координатор не пережил перезапуск после run_done: settleIdleRuns закрывает прогон без нового run_done', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, legacyGraph())
    s.setRunPty(run.id, 'pty_old', 'claude')
    s.updateTask(s.createTask({ title: 'A', runId: run.id }).id, { status: 'done' })
    const s2 = store(p)
    assert.deepEqual(s2.settleIdleRuns(() => false), [run.id])
    assert.equal(s2.getRun(run.id)!.status, 'review')
    assert.equal(events(s2, 'run_done').length, 1)
  })

  it('runs finish до завершения подзадач: понятная ошибка и после рестарта', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, legacyGraph())
    s.setRunPty(run.id, 'pty_old', 'claude')
    s.createTask({ title: 'A', runId: run.id })
    const s2 = store(p)
    assert.throws(() => s2.finishRun(run.id), /run not closed/)
  })

  it('прогон без снимка графа: подзадачи идут по графу типа, переведённому на v1 (мерж и конфликт возвращаются)', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('без снимка')
    const t = s.createTask({ title: 'A', runId: run.id })
    // Граф типа в библиотеке уже v2 (миграция типов): «Проверка» человеком перед концом, мержа нет.
    const typeGraph = migrateWorkflow(legacyDefaultWorkflow(ROLES), ROLES)
    const s2 = store(p)
    const wf = s2.runWorkflow(run.id, { workflow: typeGraph, roleIds: ROLE_IDS })
    assert.equal(wf.version, 1)
    assert.ok(wf.nodes.some((n) => n.type === 'merge') && wf.nodes.some((n) => n.id === 'conflict'))
    assert.equal(s2.advanceStage(t.id, 'next', { workflow: typeGraph, roleIds: ROLE_IDS }).action.type, 'start_worker')
    assert.equal(s2.getRun(run.id)!.workflowScope, undefined)
  })
})

describe('рестарт: старый и новый прогон в одном store', () => {
  /** Доска с обоими: старый прогон (граф по подзадачам) и новый (граф глобальной задачи, уже на этапе ревью). */
  function mixed(p: Persistence) {
    const s = store(p)
    const old = s.createRun('старая', undefined, legacyGraph())
    const oldTask = s.createTask({ title: 'старая подзадача', runId: old.id })
    s.advanceStage(oldTask.id, 'next')
    s.moveTask(oldTask.id, 'review')

    const fresh = s.createRun('новая', undefined, defaultWorkflow(ROLES))
    s.setRunPty(fresh.id, 'pty_new', 'claude')
    s.enterRunStage(fresh.id, { ...opts, commit: 'c1' })
    const a = s.createTask({ title: 'новая подзадача', runId: fresh.id })
    // Подзадача нового прогона сдана в review (её мержит приложение, по графу она не ходит) и одна в работе.
    s.moveTask(a.id, 'review')
    const b = s.createTask({ title: 'в работе', runId: fresh.id })
    s.startDispatch(b.id, 'pty_b')
    return { s, old, oldTask, fresh, a, b }
  }

  it('позиция нового прогона (stage, история, visits) переживает рестарт; у его подзадач этапа нет, у старых — есть', () => {
    const p = memory()
    const m = mixed(p)
    const stage = structuredClone(m.s.getRun(m.fresh.id)!.stage)
    const s2 = store(p)
    const fresh = s2.getRun(m.fresh.id)!
    assert.equal(fresh.workflowScope, 'run')
    assert.deepEqual(fresh.stage, stage)
    assert.equal(fresh.stageHistory!.at(-1)!.nodeId, fresh.stage!.nodeId)
    assert.deepEqual(s2.getTask(m.a.id)!.stageOf, { nodeId: 'work', visit: 1 })
    assert.equal(s2.getTask(m.a.id)!.stage, undefined, 'review-подзадача нового прогона не получает этап старого движка (migrateStages)')
    assert.equal(s2.getTask(m.oldTask.id)!.stage!.nodeId, 'work')
    assert.equal(s2.getRun(m.old.id)!.stage, undefined)
    assert.equal(s2.getRun(m.old.id)!.workflowScope, undefined)
  })

  it('мёртвый dispatch подзадачи нового прогона закрывается, а этап прогона и его stage_tasks_done не трогаются', () => {
    const p = memory()
    const m = mixed(p)
    const before = events(m.s, 'stage_tasks_done').length
    const s2 = store(p)
    assert.equal(s2.getTask(m.b.id)!.status, 'ready')
    assert.equal(s2.getRun(m.fresh.id)!.stage!.nodeId, 'work')
    assert.equal(events(s2, 'stage_tasks_done').length, before, 'события этапа не дублируются загрузкой')
    // Все подзадачи закрыты — только этап (`stage_tasks_done`), а не run_done: прогон закрывает граф.
    s2.updateTask(m.a.id, { status: 'done' })
    s2.updateTask(m.b.id, { status: 'done' })
    assert.equal(events(s2, 'run_done').length, 0)
    assert.equal(events(s2, 'stage_tasks_done').length, before + 1)
    assert.equal(s2.getRun(m.fresh.id)!.closedAt, undefined)
  })

  it('когда подзадачи обоих прогонов закрыты: run_done — только у старого; runs finish нового до конца графа — ошибка', () => {
    const p = memory()
    const m = mixed(p)
    const s2 = store(p)
    s2.setRunPty(m.old.id, 'pty_old', 'claude')
    s2.updateTask(m.oldTask.id, { status: 'done' })
    for (const id of [m.a.id, m.b.id]) s2.updateTask(id, { status: 'done' })
    const doneRuns = events(s2, 'run_done').map((e) => e.payload.runId)
    assert.deepEqual(doneRuns, [m.old.id])
    assert.throws(() => s2.finishRun(m.fresh.id), /воркфлоу ведёт граф/)
    assert.doesNotThrow(() => s2.finishRun(m.old.id))
  })

  it('новый прогон продолжает граф после рестарта: этап закрывается, ревью-гейт, ветка reject', () => {
    const p = memory()
    const m = mixed(p)
    m.s.updateTask(m.a.id, { status: 'done' })
    m.s.updateTask(m.b.id, { status: 'done' })
    m.s.finishStage(m.fresh.id, { ...opts, summary: 'этап' })
    const s2 = store(p)
    assert.equal(s2.getRun(m.fresh.id)!.stage!.nodeId, 'review')
    const back = s2.advanceRunStage(m.fresh.id, 'reject', { ...opts, feedback: 'нужно поправить' })
    assert.equal(back.action.type, 'start_stage')
    assert.equal(s2.getRun(m.fresh.id)!.stage!.nodeId, 'work')
    assert.deepEqual(s2.getRun(m.fresh.id)!.stageInput, { feedback: 'нужно поправить' })
    // Старый прогон в это время по-прежнему не имеет позиции.
    assert.equal(s2.getRun(m.old.id)!.stage, undefined)
  })
})
