// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES } from './types.ts'
import type { BoardColumn } from './types.ts'
import {
  WORKFLOW_VERSION, WF_PORTS, defaultWorkflow, gateTaskSpec, gateTaskTitle, migrateWorkflow, nextStage, pipelineWorkflow,
  startStage, stageAction, validateWorkflow
} from './workflow.ts'
import type { WfEdge, WfNode, WfValidation, Workflow } from './workflow.ts'

const COLUMNS: Pick<BoardColumn, 'id'>[] = [{ id: 'backlog' }, { id: 'review' }, { id: 'qa' }]
const ctx = { roles: DEFAULT_ROLES, columns: COLUMNS }
const noReviewer = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')

/** Копия дефолтного графа, которую тест правит на месте. */
const base = (): Workflow => structuredClone(defaultWorkflow(DEFAULT_ROLES))
const node = (wf: Workflow, id: string): WfNode => wf.nodes.find((n) => n.id === id)!
const edge = (wf: Workflow, id: string): WfEdge => wf.edges.find((e) => e.id === id)!
const messages = (list: WfValidation['errors']): string => list.map((i) => i.message).join('\n')

/** Есть ошибка с таким фрагментом (и, если задано, с этим nodeId/edgeId). */
function hasError(wf: Workflow, fragment: string | RegExp, target: { nodeId?: string; edgeId?: string } = {}, c = ctx): void {
  const { errors } = validateWorkflow(wf, c)
  const hit = errors.find((e) =>
    (typeof fragment === 'string' ? e.message.includes(fragment) : fragment.test(e.message)) &&
    (target.nodeId === undefined || e.nodeId === target.nodeId) &&
    (target.edgeId === undefined || e.edgeId === target.edgeId))
  assert.ok(hit, `нет ошибки «${String(fragment)}» ${JSON.stringify(target)}; есть:\n${messages(errors)}`)
}
function hasWarning(wf: Workflow, fragment: string, nodeId?: string, c: Parameters<typeof validateWorkflow>[1] = ctx): void {
  const { warnings } = validateWorkflow(wf, c)
  assert.ok(warnings.some((w) => w.message.includes(fragment) && (nodeId === undefined || w.nodeId === nodeId)),
    `нет предупреждения «${fragment}»; есть:\n${messages(warnings)}`)
}

/** Граф с лимитом повторов: отказ → условие attempts(work) ≥ 3 → человек, иначе снова работа. */
function withAttemptsLimit(): Workflow {
  const wf = base()
  wf.nodes.push(
    { id: 'limit', type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 3 }, x: 440, y: 180 },
    { id: 'escalate', type: 'human', title: 'Разбор отказов', x: 440, y: 360 }
  )
  edge(wf, 'e_review_reject').to = 'limit'
  edge(wf, 'e_conflict_reject').to = 'limit'
  wf.edges.push(
    { id: 'e_limit_yes', from: 'limit', outcome: 'yes', to: 'escalate' },
    { id: 'e_limit_no', from: 'limit', outcome: 'no', to: 'work' },
    { id: 'e_esc_accept', from: 'escalate', outcome: 'accept', to: 'merge' },
    { id: 'e_esc_reject', from: 'escalate', outcome: 'reject', to: 'end_rejected' }
  )
  wf.nodes.push({ id: 'end_rejected', type: 'end', x: 660, y: 360 })
  return wf
}

describe('defaultWorkflow', () => {
  it('с reviewer: работа → гейт reviewer → мерж → конец; отказ — в работу; конфликт — человеку', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    assert.equal(wf.version, WORKFLOW_VERSION)
    const review = node(wf, 'review')
    assert.equal(review.type, 'gate')
    assert.equal(review.type === 'gate' && review.roleId, 'reviewer')
    assert.equal(edge(wf, 'e_review_accept').to, 'merge')
    assert.equal(edge(wf, 'e_review_reject').to, 'work')
    assert.equal(node(wf, edge(wf, 'e_merge_conflict').to).type, 'human')
    const { errors, warnings } = validateWorkflow(wf, ctx)
    assert.deepEqual(errors, [])
    // В дефолте лимита повторов нет — это единственное предупреждение.
    assert.deepEqual(warnings.map((w) => w.nodeId), ['work'])
  })

  it('без reviewer: ревью делает человек, граф валиден для проекта без этой роли', () => {
    const wf = defaultWorkflow(noReviewer)
    assert.equal(node(wf, 'review').type, 'human')
    assert.deepEqual(validateWorkflow(wf, { roles: noReviewer, columns: COLUMNS }).errors, [])
  })

  it('у каждой ноды есть переход на каждый порт', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    for (const n of wf.nodes) {
      assert.deepEqual(wf.edges.filter((e) => e.from === n.id).map((e) => e.outcome).sort(), [...WF_PORTS[n.type]].sort(), n.id)
    }
  })
})

describe('migrateWorkflow', () => {
  it('текущая и будущая версия — без изменений, старая — поднимается до текущей', () => {
    const wf = base()
    assert.equal(migrateWorkflow(wf), wf)
    const future = { ...wf, version: WORKFLOW_VERSION + 1 }
    assert.equal(migrateWorkflow(future), future)
    assert.equal(migrateWorkflow({ ...wf, version: 0 }).version, WORKFLOW_VERSION)
  })
})

describe('validateWorkflow: ошибки', () => {
  it('п.1: версия известна', () => {
    hasError({ ...base(), version: WORKFLOW_VERSION + 1 }, 'обновите приложение')
    hasError({ ...base(), version: 0 }, 'неизвестная версия')
  })

  it('п.1: id нод и рёбер непустые и уникальные, рёбра ссылаются на существующие ноды', () => {
    const empty = base()
    empty.nodes.push({ id: ' ', type: 'end', x: 0, y: 0 })
    hasError(empty, 'пустой id')

    const dupNode = base()
    dupNode.nodes.push({ id: 'work', type: 'end', x: 0, y: 0 })
    hasError(dupNode, 'уже занят другой нодой', { nodeId: 'work' })

    const emptyEdge = base()
    emptyEdge.edges.push({ id: '', from: 'end', outcome: 'next', to: 'work' })
    hasError(emptyEdge, 'пустой id')

    const dupEdge = base()
    dupEdge.edges.push({ ...edge(dupEdge, 'e_start') })
    hasError(dupEdge, 'уже занят другим переходом', { edgeId: 'e_start' })

    const dangling = base()
    edge(dangling, 'e_merge_ok').to = 'nowhere'
    hasError(dangling, 'несуществующую ноду «nowhere»', { nodeId: 'merge', edgeId: 'e_merge_ok' })
    const noSource = base()
    noSource.edges.push({ id: 'e_x', from: 'ghost', outcome: 'next', to: 'work' })
    hasError(noSource, 'нет ноды-источника «ghost»', { edgeId: 'e_x' })
  })

  it('п.2: ровно один старт, в него ничего не входит, есть конец', () => {
    const none = base()
    none.nodes = none.nodes.filter((n) => n.type !== 'start')
    none.edges = none.edges.filter((e) => e.from !== 'start')
    hasError(none, 'нет ноды «Старт»')

    const two = base()
    two.nodes.push({ id: 'start2', type: 'start', x: 0, y: 100 })
    two.edges.push({ id: 'e_start2', from: 'start2', outcome: 'next', to: 'work' })
    hasError(two, 'должна быть одна', { nodeId: 'start2' })

    const into = base()
    edge(into, 'e_conflict_reject').to = 'start'
    hasError(into, 'в старт не может вести переход', { nodeId: 'start', edgeId: 'e_conflict_reject' })

    const noEnd = base()
    noEnd.nodes = noEnd.nodes.filter((n) => n.type !== 'end')
    edge(noEnd, 'e_merge_ok').to = 'work'
    hasError(noEnd, 'нет ноды «Конец»')
  })

  it('п.3: переход на каждый порт, не больше одного, без чужих исходов и выходов из конца', () => {
    const missing = base()
    missing.edges = missing.edges.filter((e) => e.id !== 'e_review_reject')
    hasError(missing, 'нода «Ревью»: нет перехода для reject', { nodeId: 'review' })

    const double = base()
    double.edges.push({ id: 'e_dup', from: 'review', outcome: 'accept', to: 'end' })
    hasError(double, 'больше одного перехода для accept', { nodeId: 'review', edgeId: 'e_dup' })

    const foreign = base()
    foreign.edges.push({ id: 'e_bad', from: 'work', outcome: 'accept', to: 'merge' })
    hasError(foreign, 'лишний переход «accept»', { nodeId: 'work', edgeId: 'e_bad' })

    const fromEnd = base()
    fromEnd.edges.push({ id: 'e_end', from: 'end', outcome: 'next', to: 'work' })
    hasError(fromEnd, 'из конца переходов быть не может', { nodeId: 'end', edgeId: 'e_end' })

    const cond = withAttemptsLimit()
    cond.edges = cond.edges.filter((e) => e.id !== 'e_limit_no')
    hasError(cond, 'нет перехода для no', { nodeId: 'limit' })
  })

  it('п.4: из каждой достижимой ноды есть путь к концу', () => {
    const wf = base()
    // Отказ при конфликте ведёт в работу, которая сдаётся сама в себя: конца не достичь.
    wf.nodes.push({ id: 'trap', type: 'work', title: 'Тупик', x: 0, y: 300 })
    wf.edges.push({ id: 'e_trap', from: 'trap', outcome: 'next', to: 'trap' })
    edge(wf, 'e_conflict_reject').to = 'trap'
    hasError(wf, 'нет пути к концу', { nodeId: 'trap' })
  })

  it('п.5: цикл из одних условий', () => {
    const wf = base()
    wf.nodes.push(
      { id: 'c1', type: 'condition', test: { kind: 'role', roleIds: ['developer'] }, x: 0, y: 300 },
      { id: 'c2', type: 'condition', test: { kind: 'role', roleIds: ['qa'] }, x: 200, y: 300 }
    )
    edge(wf, 'e_review_reject').to = 'c1'
    wf.edges.push(
      { id: 'e_c1_yes', from: 'c1', outcome: 'yes', to: 'work' },
      { id: 'e_c1_no', from: 'c1', outcome: 'no', to: 'c2' },
      { id: 'e_c2_yes', from: 'c2', outcome: 'yes', to: 'work' },
      { id: 'e_c2_no', from: 'c2', outcome: 'no', to: 'c1' }
    )
    hasError(wf, 'цикл из одних условий', { nodeId: 'c1' })
    hasError(wf, 'цикл из одних условий', { nodeId: 'c2' })
  })

  it('п.6: роль гейта есть и не служебная, ссылки условий и колонки существуют', () => {
    const unknownRole = base()
    const review = node(unknownRole, 'review')
    if (review.type === 'gate') review.roleId = 'security'
    hasError(unknownRole, 'нет роли «security»', { nodeId: 'review' })

    const service = base()
    const r2 = node(service, 'review')
    if (r2.type === 'gate') r2.roleId = 'coordinator'
    hasError(service, 'служебная', { nodeId: 'review' })

    const noRole = base()
    const r3 = node(noRole, 'review')
    if (r3.type === 'gate') r3.roleId = ''
    hasError(noRole, 'не выбрана роль', { nodeId: 'review' })

    const attempts = withAttemptsLimit()
    const limit = node(attempts, 'limit')
    if (limit.type === 'condition') limit.test = { kind: 'attempts', node: 'ghost', atLeast: 0 }
    hasError(attempts, 'несуществующую ноду «ghost»', { nodeId: 'limit' })
    hasError(attempts, 'не меньше 1', { nodeId: 'limit' })

    const role = withAttemptsLimit()
    const cond = node(role, 'limit')
    if (cond.type === 'condition') cond.test = { kind: 'role', roleIds: ['ghost'] }
    hasError(role, 'роль «ghost», которой нет', { nodeId: 'limit' })
    if (cond.type === 'condition') cond.test = { kind: 'role', roleIds: [] }
    hasError(role, 'не выбрана ни одна роль', { nodeId: 'limit' })
    if (cond.type === 'condition') cond.test = { kind: 'files', glob: '*.md' }
    hasError(role, 'по файлам ветки пока не поддерживается', { nodeId: 'limit' })

    const column = base()
    node(column, 'review').column = 'nope'
    hasError(column, 'нет колонки «nope»', { nodeId: 'review' })
    node(column, 'review').column = 'qa'
    assert.deepEqual(validateWorkflow(column, ctx).errors, [])
  })

  it('п.6: без колонок доски (граф типа задачи) колонки нод не проверяются', () => {
    const wf = base()
    node(wf, 'review').column = 'nope'
    assert.deepEqual(validateWorkflow(wf, { roles: DEFAULT_ROLES }).errors, [])
  })

  it('п.7: от старта достижима работа', () => {
    const wf = base()
    wf.nodes = wf.nodes.filter((n) => n.id !== 'work')
    wf.edges = wf.edges.filter((e) => e.from !== 'work')
    edge(wf, 'e_start').to = 'review'
    edge(wf, 'e_review_reject').to = 'end'
    edge(wf, 'e_conflict_reject').to = 'end'
    hasError(wf, 'ни одна нода «Работа»', { nodeId: 'start' })
  })
})

describe('validateWorkflow: предупреждения', () => {
  it('агент роли гейта выключен — предупреждение, не ошибка', () => {
    const c = { ...ctx, enabledAgents: ['codex'] }
    const { errors } = validateWorkflow(base(), c)
    assert.deepEqual(errors, [])
    hasWarning(base(), 'выключен в проекте', 'review', c)
    const on = validateWorkflow(base(), { ...ctx, enabledAgents: ['claude'] })
    assert.ok(!on.warnings.some((w) => w.message.includes('выключен')))
  })

  it('нода недостижима от старта', () => {
    const wf = base()
    wf.nodes.push({ id: 'orphan', type: 'end', x: 0, y: 500 })
    hasWarning(wf, 'недостижима от старта', 'orphan')
  })

  it('цикл через работу без лимита повторов; с лимитом attempts — нет', () => {
    hasWarning(base(), 'отказы могут повторяться бесконечно', 'work')
    const limited = validateWorkflow(withAttemptsLimit(), ctx)
    assert.deepEqual(limited.errors, [])
    assert.ok(!limited.warnings.some((w) => w.message.includes('бесконечно')), messages(limited.warnings))
  })

  it('возврат в работу только через решение человека — не бесконечный цикл', () => {
    // Дефолт без reviewer: ревью и конфликт мержа — человек, его «Вернуть» ведёт в работу.
    const human = validateWorkflow(defaultWorkflow([]), { ...ctx, roles: ctx.roles.filter((r) => r.id !== 'reviewer') })
    assert.ok(!human.warnings.some((w) => w.message.includes('бесконечно')), messages(human.warnings))
    // Лимит на отказе проверки, а «Вернуть» человека после лимита — снова в работу (как пресет редактора).
    const wf = withAttemptsLimit()
    edge(wf, 'e_esc_reject').to = 'work'
    assert.ok(!validateWorkflow(wf, ctx).warnings.some((w) => w.message.includes('бесконечно')))
  })

  it('accept ведёт в конец без мержа', () => {
    const wf = base()
    edge(wf, 'e_review_accept').to = 'end'
    hasWarning(wf, 'не будет слита', 'review')
  })

  it('больше одного мержа на пути', () => {
    const wf = base()
    wf.nodes.push({ id: 'merge2', type: 'merge', x: 880, y: 180 })
    edge(wf, 'e_merge_ok').to = 'merge2'
    wf.edges.push(
      { id: 'e_m2_ok', from: 'merge2', outcome: 'ok', to: 'end' },
      { id: 'e_m2_conflict', from: 'merge2', outcome: 'conflict', to: 'conflict' }
    )
    hasWarning(wf, 'снова ведёт в мерж', 'merge')
  })
})

describe('nextStage', () => {
  const dev = { roleId: 'developer' }

  it('старт → работа; сдача → гейт; accept → мерж; ok → конец', () => {
    const wf = base()
    const s0 = startStage(wf, dev)
    assert.deepEqual(s0.action, { type: 'start_worker', nodeId: 'work' })
    assert.equal(s0.stage.visits.work, 1)
    const s1 = nextStage(wf, s0.stage, 'next', dev)
    assert.deepEqual(s1.action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    const s2 = nextStage(wf, s1.stage, 'accept', dev)
    assert.deepEqual(s2.action, { type: 'merge', nodeId: 'merge' })
    const s3 = nextStage(wf, s2.stage, 'ok', dev)
    assert.deepEqual(s3.action, { type: 'done', nodeId: 'end', merged: true })
  })

  it('reject → обратно в работу, счётчик заходов растёт; входной stage не мутируется', () => {
    const wf = base()
    const gate = { nodeId: 'review', visits: { work: 1, review: 1 } }
    const step = nextStage(wf, gate, 'reject', dev)
    assert.deepEqual(step.action, { type: 'start_worker', nodeId: 'work' })
    assert.equal(step.stage.visits.work, 2)
    assert.equal(gate.visits.work, 1)
  })

  it('без reviewer: после работы — запрос человеку', () => {
    const wf = defaultWorkflow(noReviewer)
    const step = nextStage(wf, { nodeId: 'work', visits: { work: 1 } }, 'next', dev)
    assert.deepEqual(step.action, { type: 'request_human', nodeId: 'review' })
  })

  it('конфликт мержа → человек; accept человека → снова мерж', () => {
    const wf = base()
    const c = nextStage(wf, { nodeId: 'merge', visits: {} }, 'conflict', dev)
    assert.deepEqual(c.action, { type: 'request_human', nodeId: 'conflict' })
    assert.deepEqual(nextStage(wf, c.stage, 'accept', dev).action, { type: 'merge', nodeId: 'merge' })
  })

  it('attempts: два отказа — снова работа, третий — к человеку', () => {
    const wf = withAttemptsLimit()
    let step = startStage(wf, dev)
    for (let i = 1; i <= 2; i++) {
      step = nextStage(wf, step.stage, 'next', dev)
      step = nextStage(wf, step.stage, 'reject', dev)
      assert.deepEqual(step.action, { type: 'start_worker', nodeId: 'work' }, `отказ ${i}`)
      assert.equal(step.stage.visits.limit, i)
    }
    step = nextStage(wf, step.stage, 'next', dev)
    step = nextStage(wf, step.stage, 'reject', dev)
    assert.deepEqual(step.action, { type: 'request_human', nodeId: 'escalate' })
    assert.deepEqual(nextStage(wf, step.stage, 'reject', dev).action, { type: 'done', nodeId: 'end_rejected', merged: false })
  })

  it('role: задачи QA идут мимо ревью сразу в мерж', () => {
    const wf = base()
    wf.nodes.push({ id: 'byRole', type: 'condition', test: { kind: 'role', roleIds: ['qa'] }, x: 330, y: 180 })
    edge(wf, 'e_work').to = 'byRole'
    wf.edges.push(
      { id: 'e_role_yes', from: 'byRole', outcome: 'yes', to: 'merge' },
      { id: 'e_role_no', from: 'byRole', outcome: 'no', to: 'review' }
    )
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
    const at = { nodeId: 'work', visits: { work: 1 } }
    assert.deepEqual(nextStage(wf, at, 'next', { roleId: 'qa' }).action, { type: 'merge', nodeId: 'merge' })
    assert.deepEqual(nextStage(wf, at, 'next', dev).action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
  })

  it('цикл из условий в сохранённом графе — blocked, а не зависание', () => {
    const wf = base()
    wf.nodes.push({ id: 'loop', type: 'condition', test: { kind: 'role', roleIds: ['qa'] }, x: 0, y: 0 })
    edge(wf, 'e_review_reject').to = 'loop'
    wf.edges.push(
      { id: 'e_loop_yes', from: 'loop', outcome: 'yes', to: 'work' },
      { id: 'e_loop_no', from: 'loop', outcome: 'no', to: 'loop' }
    )
    const at = { nodeId: 'review', visits: {} }
    const step = nextStage(wf, at, 'reject', dev)
    assert.equal(step.action.type, 'blocked')
    assert.match(step.action.type === 'blocked' ? step.action.reason : '', /цикл из одних условий/)
    assert.equal(step.stage, at)
  })

  it('нет перехода или ноды — blocked, задача остаётся на месте', () => {
    const wf = base()
    const at = { nodeId: 'work', visits: { work: 1 } }
    const noEdge = nextStage(wf, at, 'accept', dev)
    assert.deepEqual(noEdge.action, { type: 'blocked', nodeId: 'work', reason: 'нода «Работа»: нет перехода для accept' })
    assert.equal(noEdge.stage, at)
    assert.equal(nextStage(wf, { nodeId: 'gone', visits: {} }, 'next', dev).action.type, 'blocked')
  })

  it('роль гейта удалили после сохранения графа — blocked на гейте', () => {
    const wf = base()
    const step = nextStage(wf, { nodeId: 'work', visits: { work: 1 } }, 'next', { roleId: 'developer', roleIds: ['developer'] })
    assert.equal(step.stage.nodeId, 'review')
    assert.equal(step.action.type, 'blocked')
    // Роль вернули — действие для текущего этапа снова создаёт гейт.
    assert.deepEqual(stageAction(wf, step.stage, { roleId: 'developer', roleIds: ['developer', 'reviewer'] }),
      { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
  })
})

describe('gateTaskSpec', () => {
  const task = { id: 'task_1', title: 'Кнопка', spec: 'Добавить кнопку «Сохранить».', branch: 'orca/task_1' }
  const gate = { id: 'review', type: 'gate' as const, roleId: 'reviewer', title: 'Ревью', x: 0, y: 0 }

  it('общий шаблон: ветка, review accept/reject, done и критерии задачи; без специфики репозитория', () => {
    const spec = gateTaskSpec(task, gate)
    for (const s of ['orca/task_1', 'orca-board review info --task task_1', 'orca-board review accept --task task_1',
      'orca-board review reject --task task_1 --feedback', 'orca-board done --summary', 'Добавить кнопку «Сохранить».']) {
      assert.ok(spec.includes(s), s)
    }
    assert.ok(!/pnpm|npm |typecheck|master/.test(spec), spec)
    assert.ok(!spec.includes('Как проверять'))
    assert.equal(gateTaskTitle(task, gate), 'Ревью: Кнопка')
  })

  it('проектная часть — из node.instructions', () => {
    const spec = gateTaskSpec({ ...task, branch: undefined }, { ...gate, instructions: '  Прогони pnpm test.  ' })
    assert.ok(spec.includes('orca/task_1'))
    assert.ok(spec.endsWith('## Как проверять\n\nПрогони pnpm test.'))
  })
})

describe('pipelineWorkflow', () => {
  it('без проверок: работа сразу в мерж, граф валиден', () => {
    const wf = pipelineWorkflow([])
    assert.equal(wf.edges.find((e) => e.id === 'e_work')!.to, 'merge')
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
  })

  it('проверка onlyForRoles: условие по роли перед ней, остальные роли её пропускают', () => {
    const wf = pipelineWorkflow([
      { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
      { type: 'human', id: 'eyes', title: 'Глазами', onlyForRoles: ['qa'] }
    ])
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
    assert.deepEqual(node(wf, 'eyes_if'), { id: 'eyes_if', type: 'condition', title: 'Глазами?', test: { kind: 'role', roleIds: ['qa'] }, x: 660, y: 0 })
    assert.equal(edge(wf, 'e_review_accept').to, 'eyes_if')
    assert.equal(edge(wf, 'e_eyes_if_yes').to, 'eyes')
    assert.equal(edge(wf, 'e_eyes_if_no').to, 'merge')
    assert.equal(edge(wf, 'e_eyes_accept').to, 'merge')
    assert.equal(edge(wf, 'e_eyes_reject').to, 'work')
  })
})
