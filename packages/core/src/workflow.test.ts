// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES } from './types.ts'
import type { BoardColumn } from './types.ts'
import {
  WORKFLOW_VERSION, WORKFLOW_VERSION_TASK_SCOPE, WF_PORTS, defaultWorkflow, defaultWorkRole, legacyDefaultWorkflow, legacyPipelineWorkflow, gateTaskSpec, gateTaskTitle, migrateWorkflow, migrateWorkflowReport, nextStage, nextRunStage, startRunStage, wfNodeTitle, pipelineWorkflow,
  startStage, stageAction, runStageAction, validateWorkflow, stableJson, wfWorkStage, wfWorkRoleIds, describeWorkflow, WF_ISSUE_TEXTS,
  WF_GIT_OPERATIONS, WF_GIT_FIELD_USE, wfGitSlug, wfGitVars, renderGitTemplate, isValidGitBranchName, isValidGitRemoteName
} from './workflow.ts'
import type { WfEdge, WfNode, WfValidation, Workflow } from './workflow.ts'

const COLUMNS: Pick<BoardColumn, 'id'>[] = [{ id: 'backlog' }, { id: 'review' }, { id: 'qa' }]
const ctx = { roles: DEFAULT_ROLES, columns: COLUMNS }
const noReviewer = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')

/**
 * Граф, который тест правит на месте: v2 с нодой `merge` (слияние ветки глобальной задачи в базовую) и конфликтом мержа
 * у человека — полный набор портов для проверок валидации и переходов. Дефолтный граф прогона (`defaultWorkflow`) без merge.
 */
const base = (): Workflow => {
  const wf = structuredClone(legacyDefaultWorkflow(DEFAULT_ROLES))
  wf.version = WORKFLOW_VERSION
  ;(node(wf, 'work') as { roleIds?: string[] }).roleIds = ['developer']
  return wf
}
const node = (wf: Workflow, id: string): WfNode => wf.nodes.find((n) => n.id === id)!
/** Роли ноды «Работа» как в графе (без нормализации `wfWorkRoleIds`). */
const workRoles = (wf: Workflow, id = 'work'): string[] | undefined => (node(wf, id) as { roleIds?: string[] }).roleIds
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
  it('с reviewer: старт → «Реализация» → ревью агентом → «Проверка» человеком → конец; отказ — в работу', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    assert.equal(wf.version, WORKFLOW_VERSION)
    const work = node(wf, 'work')
    assert.equal(work.type, 'work')
    assert.equal(workRoles(wf), undefined, '«Реализация» без роли: роли подзадач выбирает координатор')
    assert.equal(wfNodeTitle(work), 'Реализация')
    const review = node(wf, 'review')
    assert.equal(review.type === 'gate' && review.roleId, 'reviewer')
    assert.equal(edge(wf, 'e_work').to, 'review')
    assert.equal(edge(wf, 'e_review_accept').to, 'check')
    assert.equal(edge(wf, 'e_review_reject').to, 'work')
    assert.equal(node(wf, 'check').type, 'human')
    assert.equal(edge(wf, 'e_check_accept').to, 'end')
    assert.equal(edge(wf, 'e_check_reject').to, 'work')
    assert.ok(!wf.nodes.some((n) => n.type === 'merge'), 'слияния в базовую ветку в дефолте нет')
    const { errors, warnings } = validateWorkflow(wf, ctx)
    assert.deepEqual(errors, [])
    // Лимита повторов нет, но «Вернуть» человека — решение, а не автоматический круг; отказ ревью обрывает человек не сразу.
    assert.deepEqual(warnings.map((w) => w.code), ['endlessLoop'])
    assert.deepEqual(warnings.map((w) => w.nodeId), ['work'])
  })

  it('без reviewer проверка одна — человек; работа без роли при любом наборе ролей', () => {
    const wf = defaultWorkflow(noReviewer)
    assert.deepEqual(wf.nodes.map((n) => n.id), ['start', 'work', 'check', 'end'])
    assert.deepEqual(validateWorkflow(wf, { roles: noReviewer, columns: COLUMNS }).errors, [])
    const custom = defaultWorkflow([{ id: 'coordinator' }, { id: 'writer' }, { id: 'reviewer' }])
    assert.equal(workRoles(custom), undefined)
    assert.equal(defaultWorkRole([{ id: 'reviewer' }]), 'reviewer')
    assert.equal(defaultWorkRole([]), 'developer')
  })

  it('у каждой ноды есть переход на каждый порт', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    for (const n of wf.nodes) {
      assert.deepEqual(wf.edges.filter((e) => e.from === n.id).map((e) => e.outcome).sort(), [...WF_PORTS[n.type]].sort(), n.id)
    }
  })
})

describe('legacyDefaultWorkflow: граф по подзадачам (версия 1) для старых прогонов', () => {
  it('работа → ревью → мерж → конец; без reviewer ревью человеком; версия 1, роли работы нет', () => {
    const wf = legacyDefaultWorkflow(DEFAULT_ROLES)
    assert.equal(wf.version, WORKFLOW_VERSION_TASK_SCOPE)
    assert.equal(edge(wf, 'e_review_accept').to, 'merge')
    assert.equal(node(wf, edge(wf, 'e_merge_conflict').to).type, 'human')
    assert.equal((node(wf, 'work') as { roleId?: string }).roleId, undefined)
    assert.equal(legacyDefaultWorkflow(noReviewer).nodes.find((n) => n.id === 'review')!.type, 'human')
    assert.deepEqual(validateWorkflow(wf, ctx).errors.map((e) => e.code), ['versionOld'])
  })
})

describe('migrateWorkflow', () => {
  it('текущая и будущая версия — без изменений, старая — поднимается до текущей', () => {
    const wf = base()
    assert.equal(migrateWorkflow(wf), wf)
    const future = { ...wf, version: WORKFLOW_VERSION + 1 }
    assert.equal(migrateWorkflow(future), future)
    assert.equal(migrateWorkflow({ ...wf, version: 0 }).version, WORKFLOW_VERSION)
    assert.deepEqual(migrateWorkflowReport(wf).notes, [])
  })

  it('v1 → v2: merge снимается, ребро идёт в конец, «Конфликт мержа» снимается, работа остаётся без роли; предупреждения человеку', () => {
    const v1 = legacyDefaultWorkflow(DEFAULT_ROLES)
    const snapshot = structuredClone(v1)
    const { workflow: wf, notes } = migrateWorkflowReport(v1, DEFAULT_ROLES)
    assert.deepEqual(v1, snapshot, 'исходный граф не мутируется')
    assert.equal(wf.version, WORKFLOW_VERSION)
    assert.deepEqual(wf.nodes.map((n) => n.id), ['start', 'work', 'review', 'end'])
    assert.equal(edge(wf, 'e_review_accept').to, 'end')
    assert.equal(edge(wf, 'e_review_reject').to, 'work')
    assert.ok(!wf.edges.some((e) => e.from === 'merge' || e.to === 'merge' || e.from === 'conflict' || e.to === 'conflict'))
    assert.equal(workRoles(wf), undefined)
    assert.deepEqual(notes.map((n) => n.code), ['mergeRemoved', 'nodeOrphaned', 'noHumanBeforeEnd'], 'про роль работы предупреждения нет')
    assert.match(notes[0].message, /снята: подзадачи теперь сливаются в ветку глобальной задачи автоматически/)
    // Итог — валидный граф; человека перед концом нет — предупреждение, а не ошибка.
    const v = validateWorkflow(wf, ctx)
    assert.deepEqual(v.errors, [])
    assert.ok(v.warnings.some((w) => w.code === 'noHumanBeforeEnd'))
  })

  it('v1 → v2: условие по роли снимается с переходом по «Да», git create_branch/checkout снимаются, commit/push остаются', () => {
    const v1 = legacyPipelineWorkflow([
      { type: 'gate', id: 'review', roleId: 'reviewer' },
      { type: 'human', id: 'eyes', title: 'Глазами', onlyForRoles: ['qa'] }
    ])
    // git create_branch между стартом и работой, commit после ревью.
    v1.nodes.push(
      { id: 'branch', type: 'git', operation: 'create_branch', branch: 'feature/{slug}', x: 0, y: 0 },
      { id: 'save', type: 'git', operation: 'commit', message: 'wip', x: 0, y: 0 }
    )
    edge(v1, 'e_start').to = 'branch'
    v1.edges.push(
      { id: 'e_branch_ok', from: 'branch', outcome: 'ok', to: 'work' },
      { id: 'e_branch_error', from: 'branch', outcome: 'error', to: 'conflict' },
      { id: 'e_save_ok', from: 'save', outcome: 'ok', to: 'end' },
      { id: 'e_save_error', from: 'save', outcome: 'error', to: 'end' }
    )
    edge(v1, 'e_eyes_accept').to = 'save'
    const { workflow: wf, notes } = migrateWorkflowReport(v1, DEFAULT_ROLES)
    assert.ok(!wf.nodes.some((n) => n.id === 'eyes_if' || n.id === 'branch' || n.id === 'merge'))
    assert.equal(node(wf, 'save').type, 'git')
    assert.equal(edge(wf, 'e_start').to, 'work')
    assert.equal(edge(wf, 'e_review_accept').to, 'eyes', 'через снятое условие — по «Да»')
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
    const codes = notes.map((n) => n.code)
    for (const c of ['roleConditionRemoved', 'gitNodeRemoved', 'mergeRemoved']) assert.ok(codes.includes(c as never), c)
    assert.ok(!codes.includes('noHumanBeforeEnd'), 'человек перед концом есть')
  })

  it('v1 → v2: роль работы переходит в roleIds, работа без роли остаётся без роли; вопрос без роли — роль по умолчанию, без roles — developer', () => {
    const v1 = legacyDefaultWorkflow(DEFAULT_ROLES)
    v1.nodes.push({ id: 'w2', type: 'work', roleId: 'qa', x: 0, y: 0 }, { id: 'w3', type: 'work', roleId: '  ', x: 0, y: 0 }, { id: 'q', type: 'ask', instructions: 'спроси', roleId: 'analyst', x: 0, y: 0 }, { id: 'q2', type: 'ask', instructions: 'ещё', x: 0, y: 0 })
    const migrated = migrateWorkflowReport(v1, [{ id: 'writer' }, { id: 'reviewer' }]).workflow
    assert.equal(workRoles(migrated), undefined)
    assert.deepEqual(workRoles(migrated, 'w2'), ['qa'])
    assert.ok(!('roleId' in node(migrated, 'w2')), 'одиночное поле убрано')
    assert.equal(workRoles(migrated, 'w3'), undefined, 'пустая роль — как её отсутствие')
    assert.equal((node(migrated, 'q') as { roleId?: string }).roleId, 'analyst')
    assert.equal((node(migrated, 'q2') as { roleId?: string }).roleId, 'writer')
    assert.ok(!migrateWorkflowReport(v1, DEFAULT_ROLES).notes.some((n) => n.nodeId === 'w2' || n.nodeId === 'work'), 'миграция роли работы не предупреждает')
  })

  it('v1 → v2: цикл из снимаемых нод и merge без ok не роняют миграцию', () => {
    const v1 = legacyDefaultWorkflow(DEFAULT_ROLES)
    v1.edges = v1.edges.filter((e) => e.id !== 'e_merge_ok')
    assert.equal(edge(migrateWorkflow(v1, DEFAULT_ROLES), 'e_review_accept').to, 'end', 'нет ok — к первому концу')
    const loop = legacyDefaultWorkflow(DEFAULT_ROLES)
    edge(loop, 'e_merge_ok').to = 'merge'
    assert.equal(edge(migrateWorkflow(loop, DEFAULT_ROLES), 'e_review_accept').to, 'end')
  })

  it('v1 → v2: условие attempts, считавшее снятую ноду, помечено предупреждением', () => {
    const v1 = legacyDefaultWorkflow(DEFAULT_ROLES)
    v1.nodes.push({ id: 'limit', type: 'condition', test: { kind: 'attempts', node: 'merge', atLeast: 2 }, x: 0, y: 0 })
    edge(v1, 'e_review_reject').to = 'limit'
    v1.edges.push({ id: 'e_l_yes', from: 'limit', outcome: 'yes', to: 'end' }, { id: 'e_l_no', from: 'limit', outcome: 'no', to: 'work' })
    const { notes } = migrateWorkflowReport(v1, DEFAULT_ROLES)
    assert.ok(notes.some((n) => n.code === 'attemptsTargetRemoved' && n.nodeId === 'limit'))
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

  it('п.6: роли «Работы» необязательны; заданные — существующие рабочие роли типа; roleIds — список строк', () => {
    const ok = base()
    assert.deepEqual(validateWorkflow(ok, ctx).errors, [])
    const set = (roleIds: unknown): Workflow => {
      const wf = base()
      Object.assign(node(wf, 'work'), { roleIds })
      return wf
    }
    for (const none of [undefined, []]) assert.deepEqual(validateWorkflow(set(none), ctx).errors, [], 'нет ролей — допустимо')
    assert.deepEqual(validateWorkflow(set(['developer', 'qa']), ctx).errors, [], 'несколько ролей')
    hasError(set(['developer', 'ghost']), 'нет роли «ghost»', { nodeId: 'work' })
    hasError(set(['coordinator']), 'служебная', { nodeId: 'work' })
    hasError(set('developer'), 'должны быть списком id ролей', { nodeId: 'work' })
    hasError(set(['developer', 7]), 'должны быть списком id ролей', { nodeId: 'work' })
    const off = validateWorkflow(set(['developer']), { ...ctx, enabledAgents: ['other-agent'] })
    assert.ok(off.warnings.some((w) => w.code === 'roleAgentOff' && w.nodeId === 'work'), 'выключенный агент роли этапа — предупреждение')
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

    // У глобальной задачи роли нет: условие по роли — ошибка при любых roleIds.
    const role = withAttemptsLimit()
    const cond = node(role, 'limit')
    if (cond.type === 'condition') cond.test = { kind: 'role', roleIds: ['developer'] }
    hasError(role, 'условие по роли не работает в воркфлоу глобальной задачи', { nodeId: 'limit' })
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

  it('путь к концу без ноды «Человек» — предупреждение; с человеком перед концом — нет', () => {
    const wf = base()
    edge(wf, 'e_review_accept').to = 'end'
    hasWarning(wf, 'без ноды «Человек»', 'end')
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [], 'граф без человека разрешён')
    assert.ok(!validateWorkflow(defaultWorkflow(DEFAULT_ROLES), ctx).warnings.some((w) => w.code === 'noHumanBeforeEnd'))
  })

  it('«Вопрос человеку» без роли — ошибка, «Работа» без роли — нет; условие по роли и git create_branch/checkout — ошибка', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [], 'работа без роли допустима')
    const ask = defaultWorkflow(DEFAULT_ROLES)
    ask.nodes.push({ id: 'q', type: 'ask', instructions: 'о чём спросить', x: 0, y: 0 })
    ask.edges = ask.edges.filter((e) => e.id !== 'e_start')
    ask.edges.push({ id: 'e_start', from: 'start', outcome: 'next', to: 'q' }, { id: 'e_q', from: 'q', outcome: 'next', to: 'work' })
    hasError(ask, 'вопросы человеку задаёт агент этой роли', { nodeId: 'q' })
    const git = defaultWorkflow(DEFAULT_ROLES)
    git.nodes.push({ id: 'g', type: 'git', operation: 'create_branch', branch: 'feature/{slug}', x: 0, y: 0 })
    git.edges = git.edges.filter((e) => e.id !== 'e_start')
    git.edges.push(
      { id: 'e_start', from: 'start', outcome: 'next', to: 'g' },
      { id: 'e_g_ok', from: 'g', outcome: 'ok', to: 'work' },
      { id: 'e_g_error', from: 'g', outcome: 'error', to: 'work' }
    )
    hasError(git, 'операция create_branch недоступна в воркфлоу глобальной задачи', { nodeId: 'g' })
    git.nodes = git.nodes.map((n) => (n.id === 'g' && n.type === 'git' ? { ...n, operation: 'commit', branch: undefined, message: 'сохранить' } : n))
    assert.deepEqual(validateWorkflow(git, ctx).errors, [], 'commit и push доступны')
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
    assert.deepEqual(s0.action, { type: 'start_worker', nodeId: 'work', roleId: 'developer' })
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
    assert.deepEqual(step.action, { type: 'start_worker', nodeId: 'work', roleId: 'developer' })
    assert.equal(step.stage.visits.work, 2)
    assert.equal(gate.visits.work, 1)
  })

  it('без reviewer: после работы — запрос человеку', () => {
    const wf = defaultWorkflow(noReviewer)
    const step = nextStage(wf, { nodeId: 'work', visits: { work: 1 } }, 'next', dev)
    assert.deepEqual(step.action, { type: 'request_human', nodeId: 'check' })
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
      assert.deepEqual(step.action, { type: 'start_worker', nodeId: 'work', roleId: 'developer' }, `отказ ${i}`)
      assert.equal(step.stage.visits.limit, i)
    }
    step = nextStage(wf, step.stage, 'next', dev)
    step = nextStage(wf, step.stage, 'reject', dev)
    assert.deepEqual(step.action, { type: 'request_human', nodeId: 'escalate' })
    assert.deepEqual(nextStage(wf, step.stage, 'reject', dev).action, { type: 'done', nodeId: 'end_rejected', merged: false })
  })

  it('role (движок подзадач): задачи QA идут мимо ревью сразу в мерж', () => {
    const wf = base()
    wf.nodes.push({ id: 'byRole', type: 'condition', test: { kind: 'role', roleIds: ['qa'] }, x: 330, y: 180 })
    edge(wf, 'e_work').to = 'byRole'
    wf.edges.push(
      { id: 'e_role_yes', from: 'byRole', outcome: 'yes', to: 'merge' },
      { id: 'e_role_no', from: 'byRole', outcome: 'no', to: 'review' }
    )
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
  it('без проверок: работа → «Проверка» человеком → конец, граф валиден', () => {
    const wf = pipelineWorkflow([], { roleIds: ['developer'] })
    assert.deepEqual(workRoles(wf), ['developer'])
    assert.equal(edge(wf, 'e_work').to, 'check')
    assert.equal(edge(wf, 'e_check_accept').to, 'end')
    assert.equal(edge(wf, 'e_check_reject').to, 'work')
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
  })

  it('последняя проверка — человек: финальную «Проверку» не добавляем; отказ любой проверки — в последнюю работу', () => {
    const wf = pipelineWorkflow([
      { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
      { type: 'human', id: 'eyes', title: 'Глазами' }
    ], { roleIds: ['developer'] })
    assert.ok(!wf.nodes.some((n) => n.id === 'check'))
    assert.equal(edge(wf, 'e_review_accept').to, 'eyes')
    assert.equal(edge(wf, 'e_eyes_accept').to, 'end')
    assert.equal(edge(wf, 'e_eyes_reject').to, 'work')
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
  })

  it('несколько «Работ» по порядку: отказ возвращает в последнюю, роли у каждой свои', () => {
    const wf = pipelineWorkflow([{ type: 'gate', id: 'review', roleId: 'reviewer' }], {
      work: [{ id: 'backend', roleIds: ['developer'], title: 'Бэкенд' }, { id: 'work', roleIds: ['qa', 'developer'], title: 'Тесты' }]
    })
    assert.equal(edge(wf, 'e_start').to, 'backend')
    assert.equal(edge(wf, 'e_backend').to, 'work')
    assert.equal(edge(wf, 'e_review_reject').to, 'work')
    assert.deepEqual(workRoles(wf, 'work'), ['qa', 'developer'])
    assert.deepEqual(validateWorkflow(wf, ctx).errors, [])
  })

  it('без опций — одна «Реализация» без роли; пустой roleIds роль не задаёт', () => {
    assert.equal(workRoles(pipelineWorkflow([])), undefined)
    assert.equal(workRoles(pipelineWorkflow([], { roleIds: [] })), undefined)
  })
})

describe('legacyPipelineWorkflow', () => {
  it('без проверок: работа сразу в мерж (версия 1)', () => {
    const wf = legacyPipelineWorkflow([])
    assert.equal(wf.version, WORKFLOW_VERSION_TASK_SCOPE)
    assert.equal(wf.edges.find((e) => e.id === 'e_work')!.to, 'merge')
  })

  it('проверка onlyForRoles: условие по роли перед ней, остальные роли её пропускают', () => {
    const wf = legacyPipelineWorkflow([
      { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
      { type: 'human', id: 'eyes', title: 'Глазами', onlyForRoles: ['qa'] }
    ])
    assert.deepEqual(node(wf, 'eyes_if'), { id: 'eyes_if', type: 'condition', title: 'Глазами?', test: { kind: 'role', roleIds: ['qa'] }, x: 660, y: 0 })
    assert.equal(edge(wf, 'e_review_accept').to, 'eyes_if')
    assert.equal(edge(wf, 'e_eyes_if_yes').to, 'eyes')
    assert.equal(edge(wf, 'e_eyes_if_no').to, 'merge')
    assert.equal(edge(wf, 'e_eyes_accept').to, 'merge')
    assert.equal(edge(wf, 'e_eyes_reject').to, 'work')
  })
})

describe('переходы глобальной задачи (scope: run)', () => {
  const wf = defaultWorkflow(DEFAULT_ROLES)

  it('старт → start_stage без ролей (любые рабочие); работа → гейт; accept гейта → запрос человеку; accept человека → конец', () => {
    const s0 = startRunStage(wf)
    assert.deepEqual(s0.action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
    assert.equal(s0.stage.visits.work, 1)
    const s1 = nextRunStage(wf, s0.stage, 'next')
    assert.deepEqual(s1.action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    const s2 = nextRunStage(wf, s1.stage, 'accept')
    assert.deepEqual(s2.action, { type: 'request_human', nodeId: 'check' })
    const s3 = nextRunStage(wf, s2.stage, 'accept')
    assert.deepEqual(s3.action, { type: 'done', nodeId: 'end', merged: false })
  })

  it('reject возвращает в работу: заходы растут, стадия входа не мутируется', () => {
    const at = { nodeId: 'check', visits: { work: 1, review: 1, check: 1 } }
    const step = nextRunStage(wf, at, 'reject')
    assert.deepEqual(step.action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
    assert.equal(step.stage.visits.work, 2)
    assert.equal(at.visits.work, 1)
  })

  it('condition attempts считает по visits прогона: два отказа — снова работа, третий — к человеку', () => {
    const limited = structuredClone(wf)
    limited.nodes.push(
      { id: 'limit', type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 3 }, x: 0, y: 0 },
      { id: 'escalate', type: 'human', title: 'Разбор отказов', x: 0, y: 0 }
    )
    edge(limited, 'e_review_reject').to = 'limit'
    limited.edges.push(
      { id: 'e_limit_yes', from: 'limit', outcome: 'yes', to: 'escalate' },
      { id: 'e_limit_no', from: 'limit', outcome: 'no', to: 'work' },
      { id: 'e_esc_accept', from: 'escalate', outcome: 'accept', to: 'end' },
      { id: 'e_esc_reject', from: 'escalate', outcome: 'reject', to: 'work' }
    )
    assert.deepEqual(validateWorkflow(limited, ctx).errors, [])
    let step = startRunStage(limited)
    for (let i = 1; i <= 2; i++) {
      step = nextRunStage(limited, step.stage, 'next')
      step = nextRunStage(limited, step.stage, 'reject')
      assert.equal(step.action.type, 'start_stage', `отказ ${i}`)
    }
    step = nextRunStage(limited, step.stage, 'next')
    step = nextRunStage(limited, step.stage, 'reject')
    assert.deepEqual(step.action, { type: 'request_human', nodeId: 'escalate' })
  })

  it('condition role в прогоне — blocked (роли у глобальной задачи нет), в подзадачах — считается', () => {
    const w = defaultWorkflow(noReviewer)
    w.nodes.push({ id: 'byRole', type: 'condition', test: { kind: 'role', roleIds: ['developer'] }, x: 0, y: 0 })
    edge(w, 'e_work').to = 'byRole'
    w.edges.push({ id: 'y', from: 'byRole', outcome: 'yes', to: 'end' }, { id: 'n', from: 'byRole', outcome: 'no', to: 'check' })
    const at = { nodeId: 'work', visits: { work: 1 } }
    const run = nextRunStage(w, at, 'next')
    assert.equal(run.action.type, 'blocked')
    assert.match(run.action.type === 'blocked' ? run.action.reason : '', /условие по роли не работает/)
    assert.equal(run.stage, at)
    assert.deepEqual(nextStage(w, at, 'next', { roleId: 'developer' }).action, { type: 'done', nodeId: 'end', merged: false })
  })

  it('ask → create_ask; роль этапа удалили после сохранения графа — blocked с причиной', () => {
    const w = structuredClone(wf)
    w.nodes.push({ id: 'q', type: 'ask', roleId: 'analyst', instructions: 'спроси', x: 0, y: 0 })
    edge(w, 'e_start').to = 'q'
    w.edges.push({ id: 'e_q', from: 'q', outcome: 'next', to: 'work' })
    assert.deepEqual(startRunStage(w).action, { type: 'create_ask', nodeId: 'q', roleId: 'analyst' })
    const gone = startRunStage(w, { roleIds: ['developer', 'reviewer'] })
    assert.equal(gone.action.type, 'blocked')
    assert.match(gone.action.type === 'blocked' ? gone.action.reason : '', /нет роли «analyst»/)
  })

  it('work с ролями: start_stage несёт roleIds; удалённая роль — blocked; без ролей blocked не бывает', () => {
    const w = structuredClone(wf)
    ;(node(w, 'work') as { roleIds?: string[] }).roleIds = ['frontend', 'backend']
    assert.deepEqual(startRunStage(w).action, { type: 'start_stage', nodeId: 'work', roleIds: ['frontend', 'backend'] })
    assert.deepEqual(startRunStage(w, { roleIds: ['frontend', 'backend', 'reviewer'] }).action, { type: 'start_stage', nodeId: 'work', roleIds: ['frontend', 'backend'] })
    const gone = startRunStage(w, { roleIds: ['frontend', 'reviewer'] })
    assert.equal(gone.action.type, 'blocked')
    assert.match(gone.action.type === 'blocked' ? gone.action.reason : '', /нет роли «backend» в проекте/)
    const goneAll = startRunStage(w, { roleIds: ['reviewer'] })
    assert.match(goneAll.action.type === 'blocked' ? goneAll.action.reason : '', /нет ролей «frontend», «backend» в проекте/)
    // Без ролей у ноды проверять нечего: проект без единой рабочей роли не мешает.
    assert.deepEqual(startRunStage(wf, { roleIds: [] }).action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
  })

  it('прежний roleId у work читается как список из одной роли; дубли и пустые роли отбрасываются', () => {
    const w = structuredClone(wf)
    Object.assign(node(w, 'work'), { roleId: 'developer' })
    assert.deepEqual(runStageAction(w, { nodeId: 'work', visits: {} }), { type: 'start_stage', nodeId: 'work', roleIds: ['developer'] })
    assert.deepEqual(validateWorkflow(w, ctx).errors, [])
    assert.deepEqual(wfWorkRoleIds({ roleIds: ['a', ' a ', '', 'b'], roleId: 'zzz' }), ['a', 'b'], 'roleIds важнее roleId')
    assert.deepEqual(wfWorkRoleIds({ roleId: 'a' }), ['a'])
    assert.deepEqual(wfWorkRoleIds({}), [])
    assert.deepEqual(wfWorkRoleIds({ roleIds: 'a' }), [], 'не массив — ролей нет')
  })

  it('runStageAction повторяет эффект текущей ноды', () => {
    assert.deepEqual(runStageAction(wf, { nodeId: 'work', visits: { work: 2 } }), { type: 'start_stage', nodeId: 'work', roleIds: [] })
    assert.deepEqual(runStageAction(wf, { nodeId: 'check', visits: {} }), { type: 'request_human', nodeId: 'check' })
  })
})

describe('stableJson', () => {
  it('порядок ключей не влияет, undefined-поля пропускаются, порядок массива — влияет', () => {
    assert.equal(stableJson({ b: 1, a: { d: [1, 2], c: undefined } }), stableJson({ a: { d: [1, 2] }, b: 1 }))
    assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }))
    assert.equal(stableJson({ b: 'x', a: null }), '{"a":null,"b":"x"}')
  })
})

describe('показ человеку на «Работе»', () => {
  /** Дефолт без reviewer (ревью — человек) с показом на работе. */
  const withShowcase = (showcase: unknown, instructions?: unknown): Workflow => {
    const wf = structuredClone(defaultWorkflow([]))
    Object.assign(node(wf, 'work'), { showcase, ...(instructions !== undefined ? { instructions } : {}) })
    return wf
  }
  const c = { ...ctx, roles: noReviewer }

  it('wfWorkStage: тексты обрезаны, пустой показ — нет показа, required только true', () => {
    const wf = withShowcase({ what: '  макеты  ', required: true }, '  сделай  ')
    assert.deepEqual(wfWorkStage(wf, 'work'), { nodeId: 'work', type: 'work', title: 'Реализация', instructions: 'сделай', showcase: { what: 'макеты', required: true } })
    assert.deepEqual(wfWorkStage(withShowcase({ what: ' ' }), 'work'), { nodeId: 'work', type: 'work', title: 'Реализация' })
    assert.deepEqual(wfWorkStage(withShowcase({ what: 'x', required: false }), 'work')!.showcase, { what: 'x' })
    assert.equal(wfWorkStage(wf, 'review'), undefined)
    assert.equal(wfWorkStage(wf, 'nope'), undefined)
  })

  it('старый граф без полей валиден и без предупреждения о показе', () => {
    const { errors, warnings } = validateWorkflow(defaultWorkflow([]), c)
    assert.deepEqual(errors, [])
    assert.ok(!warnings.some((w) => w.message.includes('показ')))
    assert.deepEqual(validateWorkflow(withShowcase({ what: 'макеты', required: true }, 'сделай'), c).errors, [])
  })

  it('ошибки: пустой what, не объект, required не boolean, instructions не строка', () => {
    hasError(withShowcase({ what: '  ' }), 'не задано, что показать человеку', { nodeId: 'work' }, c)
    hasError(withShowcase('макеты'), 'не задано, что показать человеку', { nodeId: 'work' }, c)
    hasError(withShowcase({ what: 'x', required: 'да' }), 'показ обязателен', { nodeId: 'work' }, c)
    hasError(withShowcase(undefined, 42), 'должно быть строкой', { nodeId: 'work' }, c)
  })

  it('предупреждение: после работы с показом нет человека до конца; гейт по пути не мешает', () => {
    const gated = structuredClone(defaultWorkflow(DEFAULT_ROLES))
    Object.assign(node(gated, 'work'), { showcase: { what: 'макеты' } })
    edge(gated, 'e_review_accept').to = 'end'
    hasWarning(gated, 'показ никто не увидит', 'work')
    const withHuman = structuredClone(pipelineWorkflow([
      { type: 'gate', id: 'review', roleId: 'reviewer' }, { type: 'human', id: 'eyes' }
    ], { roleIds: ['developer'] }))
    Object.assign(node(withHuman, 'work'), { showcase: { what: 'макеты' } })
    assert.ok(!validateWorkflow(withHuman, ctx).warnings.some((w) => w.message.includes('показ')))
  })

  it('describeWorkflow отдаёт instructions и showcase у работы', () => {
    const work = describeWorkflow(withShowcase({ what: 'макеты', required: true }, 'сделай')).find((x) => x.id === 'work')!
    assert.equal(work.instructions, 'сделай')
    assert.deepEqual(work.showcase, { what: 'макеты', required: true })
    assert.equal(describeWorkflow(defaultWorkflow([])).find((x) => x.id === 'work')!.showcase, undefined)
  })
})

describe('этап «Вопрос человеку» (ask)', () => {
  /** Дефолт без reviewer: старт → ask → работа → человек → конец. */
  const withAsk = (patch: Record<string, unknown> = {}): Workflow => {
    const wf = structuredClone(defaultWorkflow(noReviewer))
    const first = wf.edges.find((e) => e.from === 'start')!
    const target = first.to
    first.to = 'ask'
    wf.nodes.push({ id: 'ask', type: 'ask', roleId: 'developer', instructions: 'Уточни, какой формат отчёта нужен', x: 100, y: 100, ...patch } as WfNode)
    wf.edges.push({ id: 'e_ask_next', from: 'ask', outcome: 'next', to: target })
    return wf
  }
  const c = { ...ctx, roles: noReviewer }

  it('порт один — next, название по умолчанию «Вопрос человеку»', () => {
    assert.deepEqual(WF_PORTS.ask, ['next'])
    assert.equal(describeWorkflow(withAsk()).find((s) => s.id === 'ask')!.title, 'Вопрос человеку')
  })

  it('корректный граф проходит валидацию без ошибок и предупреждений об ask', () => {
    const { errors, warnings } = validateWorkflow(withAsk(), c)
    assert.deepEqual(errors, [])
    assert.ok(!warnings.some((w) => w.nodeId === 'ask'))
  })

  it('пустые и нестроковые instructions — ошибка «не задано, о чём спросить»', () => {
    for (const bad of [undefined, '', '   ', 5]) hasError(withAsk({ instructions: bad }), 'не задано, о чём спросить', { nodeId: 'ask' }, c)
  })

  it('роль: несуществующая и служебная — ошибки, выключенный агент — предупреждение, пусто — ошибка', () => {
    hasError(withAsk({ roleId: 'nope' }), 'нет роли «nope»', { nodeId: 'ask' }, c)
    hasError(withAsk({ roleId: 'coordinator' }), 'служебная', { nodeId: 'ask' }, c)
    const role = DEFAULT_ROLES.find((r) => r.id === 'developer')!
    hasWarning(withAsk({ roleId: 'developer' }), 'выключен', 'ask', { ...c, enabledAgents: ['other-agent'] })
    assert.notEqual(role, undefined)
    assert.deepEqual(validateWorkflow(withAsk({ roleId: 'developer' }), c).errors, [])
    hasError(withAsk({ roleId: undefined }), 'вопросы человеку задаёт агент этой роли', { nodeId: 'ask' }, c)
  })

  it('без исходящего next и с чужим портом — ошибки', () => {
    const noNext = withAsk()
    noNext.edges = noNext.edges.filter((e) => e.id !== 'e_ask_next')
    hasError(noNext, 'нет перехода для next', { nodeId: 'ask' }, c)
    const foreign = withAsk()
    edge(foreign, 'e_ask_next').outcome = 'accept'
    hasError(foreign, 'лишний переход «accept»', { nodeId: 'ask' }, c)
  })

  it('недостижимая ask — общее предупреждение о недостижимости', () => {
    const wf = withAsk()
    wf.edges.find((e) => e.from === 'start')!.to = 'ask'
    wf.edges.find((e) => e.from === 'ask')!.to = 'work'
    wf.nodes.push({ id: 'ask2', type: 'ask', instructions: 'x', x: 0, y: 0 })
    wf.edges.push({ id: 'e_ask2', from: 'ask2', outcome: 'next', to: 'work' })
    hasWarning(wf, 'недостижима от старта', 'ask2', c)
  })

  it('stageAction: start_worker с ролью ноды, без роли — без roleId; в воркфлоу прогона — create_ask', () => {
    const stage = { nodeId: 'ask', visits: {} }
    assert.deepEqual(stageAction(withAsk({ roleId: undefined }), stage, { roleId: 'developer' }), { type: 'start_worker', nodeId: 'ask' })
    assert.deepEqual(runStageAction(withAsk(), stage), { type: 'create_ask', nodeId: 'ask', roleId: 'developer' })
    assert.deepEqual(stageAction(withAsk({ roleId: 'analyst' }), stage, { roleId: 'developer' }), { type: 'start_worker', nodeId: 'ask', roleId: 'analyst' })
  })

  it('nextStage: start → ask, ask → работа, visits растут', () => {
    const wf = withAsk()
    const first = startStage(wf, { roleId: 'developer' })
    assert.equal(first.stage.nodeId, 'ask')
    assert.equal(first.action.type, 'start_worker')
    assert.equal(first.stage.visits.ask, 1)
    const second = nextStage(wf, first.stage, 'next', { roleId: 'developer' })
    assert.equal(second.stage.nodeId, 'work')
    assert.deepEqual(second.action, { type: 'start_worker', nodeId: 'work' }, 'работа без роли — роль задачи')
    assert.equal(second.stage.visits.work, 1)
    assert.equal(second.stage.visits.ask, 1)
  })

  it('nextStage: work → ask (ask после работы)', () => {
    const wf = defaultWorkflow(noReviewer)
    const workNext = wf.edges.find((e) => e.from === 'work')!
    const after = workNext.to
    workNext.to = 'ask'
    wf.nodes.push({ id: 'ask', type: 'ask', roleId: 'developer', instructions: 'уточни', x: 0, y: 0 })
    wf.edges.push({ id: 'e_ask_next', from: 'ask', outcome: 'next', to: after })
    const step = nextStage(wf, { nodeId: 'work', visits: { work: 1 } }, 'next', { roleId: 'developer' })
    assert.equal(step.stage.nodeId, 'ask')
    assert.equal(step.stage.visits.ask, 1)
    assert.equal(step.action.type, 'start_worker')
    assert.equal(nextStage(wf, step.stage, 'next', { roleId: 'developer' }).stage.nodeId, after)
  })

  it('wfWorkStage: этап ask с type и обрезанными instructions; describeWorkflow — роль и instructions', () => {
    const wf = withAsk({ roleId: 'analyst', instructions: '  что нужно?  ' })
    assert.deepEqual(wfWorkStage(wf, 'ask'), { nodeId: 'ask', type: 'ask', title: 'Вопрос человеку', roleId: 'analyst', instructions: 'что нужно?' })
    const info = describeWorkflow(wf).find((s) => s.id === 'ask')!
    assert.equal(info.type, 'ask')
    assert.equal(info.roleId, 'analyst')
    assert.equal(info.instructions, 'что нужно?')
    assert.equal(info.showcase, undefined)
  })
})

describe('validateWorkflow: код и параметры проблем для перевода в UI', () => {
  it('у каждой проблемы есть код, а message — русский шаблон кода с параметрами', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    const broken: Workflow = {
      ...wf,
      nodes: [...wf.nodes.map((n) => (n.type === 'gate' ? { ...n, roleId: 'nope' } : n)), { id: 'lost', type: 'work', x: 0, y: 0 }],
      edges: wf.edges.filter((e) => e.outcome !== 'reject')
    }
    const { errors, warnings } = validateWorkflow(broken, ctx)
    assert.ok(errors.length > 0 && warnings.length > 0)
    for (const i of [...errors, ...warnings]) {
      assert.ok(i.code, i.message)
      const text = WF_ISSUE_TEXTS[i.code].replace(/\{(\w+)\}/g, (_, k: string) => String(i.params?.[k]))
      assert.equal(i.message, text)
    }
  })

  it('название ноды в параметрах — через ctx.nodeTitle', () => {
    const wf = defaultWorkflow(DEFAULT_ROLES)
    const lost: WfNode = { id: 'lost', type: 'work', x: 0, y: 0 }
    const { warnings } = validateWorkflow({ ...wf, nodes: [...wf.nodes, lost] }, { ...ctx, nodeTitle: (n) => `T:${n.id}` })
    const w = warnings.find((i) => i.code === 'unreachable')
    assert.equal(w?.params?.node, 'T:lost')
  })
})

describe('нода «Git»', () => {
  /** Дефолт: старт → git → работа → … Ветка создаётся до первой работы; ошибка git — к человеку. */
  const withGit = (patch: Record<string, unknown> = {}): Workflow => {
    const wf = structuredClone(defaultWorkflow(noReviewer))
    const first = wf.edges.find((e) => e.from === 'start')!
    const target = first.to
    first.to = 'git'
    wf.nodes.push({ id: 'git', type: 'git', operation: 'create_branch', branch: 'feature/{taskId}-{slug}', x: 100, y: 100, ...patch } as WfNode)
    wf.edges.push(
      { id: 'e_git_ok', from: 'git', outcome: 'ok', to: target },
      { id: 'e_git_error', from: 'git', outcome: 'error', to: 'check' }
    )
    return wf
  }
  const c = { ...ctx, roles: noReviewer }
  const errs = (wf: Workflow): string => messages(validateWorkflow(wf, c).errors)

  it('порты ok/error, название по умолчанию «Git»', () => {
    assert.deepEqual(WF_PORTS.git, ['ok', 'error'])
    assert.equal(describeWorkflow(withGit()).find((s) => s.id === 'git')!.title, 'Git')
  })

  it('в воркфлоу глобальной задачи create_branch и checkout — ошибка, остальное поле проверяется как раньше', () => {
    for (const patch of [
      { operation: 'create_branch', branch: 'orca/{taskId}' },
      { operation: 'create_branch', branch: 'feature/{slug}', base: 'develop' },
      { operation: 'checkout', branch: 'develop' }
    ]) {
      const { errors } = validateWorkflow(withGit(patch), c)
      assert.deepEqual(errors.map((e) => e.code), ['gitRunOperation'], JSON.stringify(patch))
    }
    hasError(withGit({ operation: 'create_branch', branch: '' }), 'не задано имя ветки', { nodeId: 'git' }, c)
  })

  it('корректные ноды commit и push проходят валидацию без ошибок и предупреждений', () => {
    for (const patch of [
      { operation: 'commit', message: 'feat: {title} ({taskId})', branch: undefined },
      { operation: 'push', branch: undefined },
      { operation: 'push', branch: undefined, remote: 'upstream' }
    ]) {
      const { errors, warnings } = validateWorkflow(withGit(patch), c)
      assert.deepEqual(errors, [], JSON.stringify(patch))
      assert.ok(!warnings.some((w) => w.nodeId === 'git'), JSON.stringify(patch))
    }
  })

  it('операция обязательна и из списка v1', () => {
    assert.deepEqual([...WF_GIT_OPERATIONS], ['create_branch', 'checkout', 'commit', 'push'])
    for (const bad of [undefined, '', 'merge', 'reset', 'push_force', 5]) hasError(withGit({ operation: bad }), 'неизвестная git-операция', { nodeId: 'git' }, c)
  })

  it('обязательные поля по операции', () => {
    assert.deepEqual(WF_GIT_FIELD_USE.create_branch.required, ['branch'])
    assert.deepEqual(WF_GIT_FIELD_USE.checkout.required, ['branch'])
    assert.deepEqual(WF_GIT_FIELD_USE.commit.required, ['message'])
    assert.deepEqual(WF_GIT_FIELD_USE.push.required, [])
    for (const bad of [undefined, '', '   ']) {
      hasError(withGit({ operation: 'create_branch', branch: bad }), 'для операции create_branch не задано имя ветки', { nodeId: 'git' }, c)
      hasError(withGit({ operation: 'checkout', branch: bad }), 'для операции checkout не задано имя ветки', { nodeId: 'git' }, c)
      hasError(withGit({ operation: 'commit', branch: undefined, message: bad }), 'не задано сообщение коммита', { nodeId: 'git' }, c)
    }
  })

  it('нестроковые поля — ошибка', () => {
    hasError(withGit({ branch: 5 }), 'поле «branch» должно быть строкой', { nodeId: 'git' }, c)
    hasError(withGit({ remote: {} }), 'поле «remote» должно быть строкой', { nodeId: 'git' }, c)
  })

  it('имя ветки, база и remote: недопустимые — ошибки с контекстом', () => {
    for (const branch of ['my branch', 'a..b', '-x', 'x/', '/x', 'x.lock', 'a~b', 'a:{slug}', 'feature/{slug}.']) {
      hasError(withGit({ branch }), `имя ветки «${branch}» недопустимо`, { nodeId: 'git' }, c)
    }
    hasError(withGit({ base: 'de velop' }), 'базовая ветка «de velop» недопустима', { nodeId: 'git' }, c)
    hasError(withGit({ branch: 'develop', base: 'develop' }), 'совпадает с базовой', { nodeId: 'git' }, c)
    hasError(withGit({ operation: 'push', branch: undefined, remote: '-f' }), 'имя remote «-f» недопустимо', { nodeId: 'git' }, c)
    hasError(withGit({ operation: 'push', branch: undefined, remote: 'my origin' }), 'имя remote', { nodeId: 'git' }, c)
  })

  it('подстановки: неизвестная — ошибка, {title} только в сообщении коммита', () => {
    hasError(withGit({ branch: 'f/{nope}' }), 'неизвестная подстановка «{nope}»', { nodeId: 'git' }, c)
    hasError(withGit({ branch: 'f/{title}' }), 'неизвестная подстановка «{title}»', { nodeId: 'git' }, c)
    hasError(withGit({ operation: 'commit', branch: undefined, message: 'x {slug} {who}' }), 'подстановка «{who}»', { nodeId: 'git' }, c)
    assert.equal(errs(withGit({ operation: 'commit', branch: undefined, message: '{taskId}: {title}' })), '')
  })

  it('лишние для операции поля — предупреждение, не ошибка', () => {
    const wf = withGit({ operation: 'commit', branch: 'x', message: 'm', remote: 'origin' })
    assert.equal(errs(wf), '')
    hasWarning(wf, 'поле «branch» не используется операцией commit', 'git', c)
    hasWarning(wf, 'поле «remote» не используется операцией commit', 'git', c)
    const empty = withGit({ operation: 'commit', branch: '  ', message: 'm' })
    assert.ok(!validateWorkflow(empty, c).warnings.some((w) => w.code === 'gitParamIgnored'))
  })

  it('без исхода ok или error — ошибка, чужой порт — ошибка', () => {
    for (const port of ['ok', 'error']) {
      const wf = withGit()
      wf.edges = wf.edges.filter((e) => e.id !== `e_git_${port}`)
      hasError(wf, `нет перехода для ${port}`, { nodeId: 'git' }, c)
    }
    const foreign = withGit()
    edge(foreign, 'e_git_error').outcome = 'conflict'
    hasError(foreign, 'лишний переход «conflict»', { nodeId: 'git' }, c)
    hasError(foreign, 'нет перехода для error', { nodeId: 'git' }, c)
  })

  it('error, ведущий в никуда (нет пути к концу), ловится общей проверкой', () => {
    const wf = withGit()
    wf.nodes.push({ id: 'sink', type: 'work', x: 0, y: 0 })
    edge(wf, 'e_git_error').to = 'sink'
    wf.edges.push({ id: 'e_sink', from: 'sink', outcome: 'next', to: 'sink' })
    hasError(wf, 'нет пути к концу', { nodeId: 'sink' }, c)
  })

  it('слаг: кириллица транслитерируется, лишнее — дефис, до 40 символов, пусто — task', () => {
    assert.equal(wfGitSlug('Нода Git: контракт (v1)'), 'noda-git-kontrakt-v1')
    assert.equal(wfGitSlug('Щётка ёжика'), 'schetka-ezhika')
    assert.equal(wfGitSlug('  ---  '), 'task')
    assert.equal(wfGitSlug(''), 'task')
    const long = wfGitSlug('a'.repeat(39) + ' bbbb')
    assert.ok(long.length <= 40 && !long.endsWith('-'), long)
  })

  it('подстановки: renderGitTemplate и wfGitVars', () => {
    const vars = wfGitVars({ id: 'task_abc', title: '  Починить логин ' })
    assert.deepEqual(vars, { taskId: 'task_abc', slug: 'pochinit-login', title: 'Починить логин' })
    assert.equal(renderGitTemplate('feature/{taskId}-{slug}', vars), 'feature/task_abc-pochinit-login')
    assert.equal(renderGitTemplate('fix: {title} [{nope}]', vars), 'fix: Починить логин [{nope}]')
    assert.ok(isValidGitBranchName(renderGitTemplate('feature/{taskId}-{slug}', vars)))
    assert.ok(isValidGitBranchName('orca/task_x') && isValidGitBranchName('release/1.2.3'))
    assert.ok(!isValidGitBranchName('@') && !isValidGitBranchName('a@{b'))
    assert.ok(isValidGitRemoteName('origin') && !isValidGitRemoteName(''))
  })

  describe('NodeStep (WfAction)', () => {
    const at = (wf: Workflow): ReturnType<typeof stageAction> => stageAction(wf, { nodeId: 'git', visits: {} }, { roleId: 'developer' })

    it('create_branch: только нужные поля, шаблон не подставлен, значения без пробелов по краям', () => {
      assert.deepEqual(at(withGit({ branch: ' feature/{slug} ', base: ' develop ', message: 'лишнее', remote: 'x' })),
        { type: 'git', nodeId: 'git', operation: 'create_branch', branch: 'feature/{slug}', base: 'develop' })
      assert.deepEqual(at(withGit()), { type: 'git', nodeId: 'git', operation: 'create_branch', branch: 'feature/{taskId}-{slug}' })
    })

    it('checkout, commit, push', () => {
      assert.deepEqual(at(withGit({ operation: 'checkout', branch: 'develop' })), { type: 'git', nodeId: 'git', operation: 'checkout', branch: 'develop' })
      assert.deepEqual(at(withGit({ operation: 'commit', message: 'wip {taskId}' })), { type: 'git', nodeId: 'git', operation: 'commit', message: 'wip {taskId}' })
      assert.deepEqual(at(withGit({ operation: 'push' })), { type: 'git', nodeId: 'git', operation: 'push', remote: 'origin' })
      assert.deepEqual(at(withGit({ operation: 'push', remote: 'upstream' })), { type: 'git', nodeId: 'git', operation: 'push', remote: 'upstream' })
    })

    it('неполная нода — blocked (настройка), а не исход error', () => {
      for (const patch of [{ operation: 'nope' }, { branch: '' }, { operation: 'commit', message: ' ' }]) {
        const a = at(withGit(patch))
        assert.equal(a.type, 'blocked', JSON.stringify(patch))
        assert.equal(a.nodeId, 'git')
      }
    })

    it('nextStage приводит в git-ноду с действием, а исходы ok/error ведут по рёбрам', () => {
      const wf = withGit()
      const step = startStage(wf, { roleId: 'developer' })
      assert.equal(step.stage.nodeId, 'git')
      assert.equal(step.action.type, 'git')
      assert.equal(step.stage.visits.git, 1)
      const ok = nextStage(wf, step.stage, 'ok', { roleId: 'developer' })
      assert.equal(ok.stage.nodeId, 'work')
      assert.equal(ok.action.type, 'start_worker')
      const err = nextStage(wf, step.stage, 'error', { roleId: 'developer' })
      assert.equal(err.stage.nodeId, 'check')
      assert.equal(err.action.type, 'request_human')
    })

    it('describeWorkflow показывает операцию и параметры', () => {
      const info = describeWorkflow(withGit({ operation: 'push' })).find((s) => s.id === 'git')!
      assert.deepEqual(info.git, { operation: 'push', remote: 'origin' })
      assert.ok(info.next.ok && info.next.error)
    })
  })
})
