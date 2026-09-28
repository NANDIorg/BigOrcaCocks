import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, WF_DECISION_MAX_OPTIONS, WF_DECISION_OPTION_ID, nextStage, wfPorts, validateWorkflow, type WfStage, type Workflow } from '@orca-board/core'
import {
  WF_TYPE_ORDER, WF_TYPE_TITLES, addDecisionOption, addRetryLimit, changeNodeType, decisionOptionId, moveDecisionOption,
  patchDecisionOption, removeDecisionOption, resetDecisionOptions, conditionOfKind, exportWorkflowJson, hasColumn, parseWorkflowJson, patchNode, portTarget, setPortTarget, stageRoles, targetOptions, workflowFileName
} from './workflowForm'
import { setLocale } from './i18n'
import { graphWithMerge } from './workflowFixture'
import { connect } from './workflowEdit'
import { legacyDefaultWorkflow } from '@orca-board/core'

const wf = graphWithMerge(DEFAULT_ROLES)
const node = (w: Workflow, id: string) => w.nodes.find((n) => n.id === id)
/** Роль ноды любого типа (у «Работы» — роли списком через запятую): у типов без роли — undefined. */
const roleOf = (w: Workflow, id: string): string | undefined => {
  const n = node(w, id)
  if (n?.type === 'work') return n.roleIds?.join(',')
  return n && 'roleId' in n ? n.roleId : undefined
}
const showcaseOf = (w: Workflow): unknown => {
  const n = node(w, 'work')
  return n?.type === 'work' ? n.showcase : undefined
}
const ctx = { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS }

test('роли для этапов — без служебных coordinator и assistant', () => {
  const ids = stageRoles(DEFAULT_ROLES).map((r) => r.id)
  assert.ok(!ids.includes('coordinator') && !ids.includes('assistant'))
  assert.ok(ids.includes('reviewer') && ids.includes('developer'))
})

test('patchNode: пустые необязательные поля удаляются, чужие для типа — игнорируются', () => {
  let next = patchNode(wf, 'work', { title: '', roleIds: ['developer', 'qa'], column: 'review' })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, roleIds: ['developer', 'qa'], column: 'review' })
  next = patchNode(next, 'work', { roleIds: [], column: '', merged: true, test: { kind: 'role', roleIds: [] } })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0 }, 'пустой список — роли не заданы')

  next = patchNode(wf, 'review', { roleId: '', instructions: '  ' })
  assert.equal(roleOf(next, 'review'), '')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'review'))

  assert.equal(patchNode(wf, 'нет', { title: 'x' }), wf)
  assert.equal(node(wf, 'work')?.title, 'Работа', 'исходный граф не меняется')
})

test('patchNode: роли «Работы» — список; одиночный roleId старого формата заменяется списком, у гейта и вопроса roleId прежний', () => {
  const legacy: Workflow = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'work' && n.type === 'work' ? { ...n, roleIds: undefined, roleId: 'developer' } : n)) }
  const next = patchNode(legacy, 'work', { roleIds: ['frontend', 'backend'] })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, title: 'Работа', roleIds: ['frontend', 'backend'] })
  assert.deepEqual(patchNode(wf, 'work', { roleId: 'qa' }), wf, 'roleId у «Работы» больше не правится')
  assert.equal(roleOf(patchNode(wf, 'review', { roleId: 'qa' }), 'review'), 'qa')
})

test('patchNode: инструкция и показ у «Работы»', () => {
  let next = patchNode(wf, 'work', { instructions: 'Сделай 3 варианта макета', showcase: { what: 'макеты' } })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, title: 'Работа', roleIds: ['developer'], instructions: 'Сделай 3 варианта макета', showcase: { what: 'макеты' } })
  next = patchNode(next, 'work', { showcase: { required: true } })
  assert.deepEqual(showcaseOf(next), { what: 'макеты', required: true }, 'флажок не стирает текст')
  next = patchNode(next, 'work', { showcase: { what: '' } })
  assert.deepEqual(showcaseOf(next), { what: '', required: true }, 'обязательный показ с пустым «что» остаётся — его подсветит валидация')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'work'))
  next = patchNode(next, 'work', { showcase: { required: false }, instructions: ' ' })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, title: 'Работа', roleIds: ['developer'] }, 'пустой показ и инструкция удаляются')
  assert.deepEqual(patchNode(wf, 'review', { showcase: { what: 'x' } }), wf, 'показ только у «Работы»')

  const human = changeNodeType(patchNode(wf, 'work', { instructions: 'этап', showcase: { what: 'макеты' } }), 'work', 'human')
  const h = node(human, 'work')
  assert.equal(h?.type === 'human' ? h.instructions : undefined, 'этап', 'инструкция переносится')
  assert.ok(!(h && 'showcase' in h), 'показа у человека нет')
})

test('changeNodeType: сохраняет id, позицию и роль, убирает рёбра лишних портов', () => {
  const human = changeNodeType(wf, 'review', 'human')
  const n = node(human, 'review')
  assert.equal(n?.type, 'human')
  assert.equal(n?.title, 'Ревью')
  assert.deepEqual([n?.x, n?.y], [440, 0])
  assert.equal(portTarget(human, 'review', 'accept'), 'merge')

  const back = changeNodeType(human, 'review', 'gate')
  assert.equal(node(back, 'review')?.type, 'gate')
  assert.equal(roleOf(back, 'review'), '')

  const toWork = changeNodeType(wf, 'review', 'work')
  assert.equal(node(toWork, 'review')?.type, 'work')
  assert.equal(roleOf(toWork, 'review'), 'reviewer')
  assert.deepEqual(toWork.edges.filter((e) => e.from === 'review'), [], 'у работы нет портов accept/reject')

  const toStart = changeNodeType(wf, 'work', 'start')
  assert.ok(!toStart.edges.some((e) => e.to === 'work'), 'в старт переходы не ведут')
  assert.equal(changeNodeType(wf, 'work', 'work'), wf)
})

test('select «куда ведёт»: смена цели порта и снятие перехода', () => {
  const next = setPortTarget(wf, 'review', 'reject', 'conflict')
  assert.equal(portTarget(next, 'review', 'reject'), 'conflict')
  assert.equal(next.edges.find((e) => e.from === 'review' && e.outcome === 'reject')?.id, 'e_review_reject')
  const cut = setPortTarget(next, 'review', 'reject', null)
  assert.equal(portTarget(cut, 'review', 'reject'), undefined)
  assert.equal(setPortTarget(cut, 'review', 'reject', null), cut)
  assert.equal(setPortTarget(wf, 'review', 'reject', 'start'), wf, 'в старт вести нельзя')
  assert.ok(!targetOptions(wf).some((o) => o.id === 'start'))
  assert.equal(targetOptions(wf).find((o) => o.id === 'merge')?.label, 'Мерж (merge)')
})

test('условие нового вида — с полями по умолчанию', () => {
  assert.deepEqual(conditionOfKind(wf, 'attempts'), { kind: 'attempts', node: 'work', atLeast: 3 })
  assert.deepEqual(conditionOfKind(wf, 'role'), { kind: 'role', roleIds: [] })
})

test('экспорт и импорт JSON: круг без потерь, мусор — понятная ошибка', () => {
  const back = parseWorkflowJson(exportWorkflowJson(wf))
  assert.deepEqual(back, { workflow: wf })
  assert.match((parseWorkflowJson('{') as { error: string }).error, /^файл не JSON/)
  assert.match((parseWorkflowJson('[]') as { error: string }).error, /не воркфлоу/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":{}}') as { error: string }).error, /nodes и edges/)
  assert.match((parseWorkflowJson('{"version":99,"nodes":[],"edges":[]}') as { error: string }).error, /обновите приложение/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":[{"id":"a","type":"x","x":0,"y":0}],"edges":[]}') as { error: string }).error, /неизвестный тип «x»/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":[{"id":"a"}],"edges":[]}') as { error: string }).error, /нода №1/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":[],"edges":[{"id":"e"}]}') as { error: string }).error, /переход №1/)
  assert.equal(workflowFileName('my app: v2'), 'workflow-my-app-v2.json')
  assert.equal(workflowFileName('  '), 'workflow.json')
})

test('ошибки импорта и названия пресета — на языке интерфейса', () => {
  setLocale('en')
  try {
    assert.match((parseWorkflowJson('{') as { error: string }).error, /^not a JSON file/)
    assert.match((parseWorkflowJson('{"version":1,"nodes":[{"id":"a","type":"x","x":0,"y":0}],"edges":[]}') as { error: string }).error, /unknown type “x”/)
    const res = addRetryLimit(wf)
    assert.ok('workflow' in res)
    assert.ok(res.workflow.nodes.some((n) => n.title === 'Rejects ≥ 3'))
  } finally {
    setLocale('ru')
  }
})

test('пресет «3 отказа → человек»: граф валиден, третий отказ уходит человеку', () => {
  const res = addRetryLimit(wf)
  assert.ok('workflow' in res)
  const limited = res.workflow
  assert.equal(res.added, 1)
  assert.deepEqual(validateWorkflow(limited, ctx).errors, [])
  const run = { roleId: 'developer' }
  let stage: WfStage = { nodeId: 'review', visits: { start: 1, work: 1, review: 1 } }
  for (let i = 1; i <= 2; i++) {
    const step = nextStage(limited, stage, 'reject', run)
    assert.equal(step.stage.nodeId, 'work', `отказ ${i} — снова в работу`)
    stage = { ...step.stage, nodeId: 'review' }
  }
  const third = nextStage(limited, stage, 'reject', run)
  assert.equal(third.action.type, 'request_human')
  assert.equal(portTarget(limited, third.stage.nodeId, 'accept'), 'merge')
  assert.equal(portTarget(limited, third.stage.nodeId, 'reject'), 'work')

  const again = addRetryLimit(limited)
  assert.ok('error' in again, 'повторно лимит не ставится')
  assert.ok('error' in addRetryLimit(graphWithMerge([])), 'без проверки агентом ставить некуда')
})

test('ask: тип в select «Тип», без поля «Колонка»', () => {
  assert.ok(WF_TYPE_ORDER.includes('ask'))
  assert.equal(WF_TYPE_TITLES.ask, 'Вопрос человеку')
  assert.equal(hasColumn('ask'), false)
  assert.equal(hasColumn('work'), true)
})

test('patchNode для ask: роль опциональна, инструкция обязательна и не удаляется пустой', () => {
  const withAsk = changeNodeType(wf, 'review', 'ask')
  assert.equal(node(withAsk, 'review')?.type, 'ask')
  let next = patchNode(withAsk, 'review', { roleId: 'developer', instructions: 'Уточни срок' })
  assert.deepEqual(node(next, 'review'), { id: 'review', type: 'ask', x: node(wf, 'review')!.x, y: node(wf, 'review')!.y, title: node(wf, 'review')!.title, roleId: 'developer', instructions: 'Уточни срок' })
  next = patchNode(next, 'review', { roleId: '', instructions: '  ', column: 'review' })
  const n = node(next, 'review')
  assert.equal(n?.type === 'ask' && 'roleId' in n, false, 'пустая роль — «роль задачи»')
  assert.equal(n?.type === 'ask' && n.instructions, '  ', 'пустая инструкция остаётся строкой, а не пропадает')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'review'), 'валидация подсвечивает пустое «О чём спросить»')
})

test('changeNodeType в ask и из него: роль и инструкция переносятся, колонка — нет, порты чистятся', () => {
  const work = patchNode(wf, 'work', { roleId: 'developer', instructions: 'Спроси про формат', column: 'review' })
  const ask = changeNodeType(work, 'work', 'ask')
  const a = node(ask, 'work')
  assert.equal(a?.type === 'ask' && a.roleId, 'developer')
  assert.equal(a?.type === 'ask' && a.instructions, 'Спроси про формат')
  assert.equal(a?.column, undefined, 'у ask колонки нет')
  assert.ok(ask.edges.some((e) => e.from === 'work' && e.outcome === 'next'))

  const back = changeNodeType(ask, 'work', 'work')
  const w = node(back, 'work')
  assert.deepEqual(w?.type === 'work' && w.roleIds, ['developer'], 'роль вопроса становится списком из одной роли')
  assert.equal(w?.type === 'work' && w.instructions, 'Спроси про формат')

  // Гейт с двумя портами → ask с одним: лишние рёбра уходят.
  const fromGate = changeNodeType(wf, 'review', 'ask')
  assert.equal(fromGate.edges.filter((e) => e.from === 'review').every((e) => e.outcome === 'next'), true)
})

test('импорт графа версии 1: миграция в версию 2 и замечания на языке интерфейса — что снято и почему', () => {
  const v1 = legacyDefaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
  const res = parseWorkflowJson(JSON.stringify(v1))
  assert.ok('workflow' in res)
  assert.equal(res.workflow.version, 2)
  assert.ok(!res.workflow.nodes.some((n) => n.type === 'merge'), 'merge версии 1 снят')
  assert.equal(res.migration?.fromVersion, 1)
  assert.ok(res.migration!.notes.some((n) => /снята: подзадачи теперь сливаются в ветку глобальной задачи сами/.test(n) && n.includes('«Мерж')), res.migration!.notes.join('\n'))
  assert.ok(res.migration!.notes.every((n) => !n.includes('config.wf.migration')), 'ни одного ключа словаря вместо текста')
  setLocale('en')
  try {
    const en = parseWorkflowJson(JSON.stringify(v1))
    assert.ok('workflow' in en)
    assert.ok(en.migration!.notes.every((n) => !/[А-Яа-яЁё]/.test(n)), en.migration!.notes.join('\n'))
    assert.ok(en.migration!.notes.some((n) => /removed: subtasks now merge into the global task branch/.test(n)))
  } finally {
    setLocale('ru')
  }
})

test('импорт: условие по роли снимается с пометкой; граф версии 2 приходит без замечаний', () => {
  const v1 = legacyDefaultWorkflow([{ id: 'developer' }])
  v1.nodes.push({ id: 'byrole', type: 'condition', title: 'Фронт?', x: 0, y: 0, test: { kind: 'role', roleIds: ['frontend'] } })
  v1.edges = v1.edges.map((e) => (e.from === 'work' ? { ...e, to: 'byrole' } : e))
  v1.edges.push({ id: 'e_yes', from: 'byrole', outcome: 'yes', to: 'end' }, { id: 'e_no', from: 'byrole', outcome: 'no', to: 'end' })
  const res = parseWorkflowJson(JSON.stringify(v1))
  assert.ok('workflow' in res)
  assert.ok(!res.workflow.nodes.some((n) => n.id === 'byrole'))
  assert.ok(res.migration?.notes.some((n) => n === 'условие по роли «Фронт?» снято: у глобальной задачи нет роли, путь идёт по «Да»'), res.migration?.notes.join('\n'))
  const v2 = parseWorkflowJson(exportWorkflowJson(wf))
  assert.ok('workflow' in v2 && v2.migration === undefined)
})

// ---------- decision ----------

/** Граф с условием `limit` (порты yes/no) — из пресета лимита повторов. */
const withCondition = (): Workflow => {
  const res = addRetryLimit(wf)
  assert.ok('workflow' in res)
  return res.workflow
}
const optionsOf = (w: Workflow, id: string) => {
  const n = node(w, id)
  return n?.type === 'decision' ? n.options : undefined
}
const edgesFrom = (w: Workflow, id: string): string[] => w.edges.filter((e) => e.from === id).map((e) => `${e.outcome}->${e.to}`).sort()

test('decision: тип в select «Тип», без поля «Колонка»', () => {
  assert.ok(WF_TYPE_ORDER.includes('decision'))
  assert.equal(WF_TYPE_TITLES.decision, 'Решение ИИ')
  assert.equal(hasColumn('decision'), false)
})

test('patchNode для decision: вопрос, обязательная роль, необязательное «как решать»', () => {
  const g = changeNodeType(withCondition(), 'limit', 'decision')
  let next = patchNode(g, 'limit', { question: 'Нужен дизайн?', roleId: 'analyst', instructions: 'Смотри на UI' })
  let n = node(next, 'limit')
  assert.ok(n?.type === 'decision')
  assert.equal(n.question, 'Нужен дизайн?')
  assert.equal(n.roleId, 'analyst')
  assert.equal(n.instructions, 'Смотри на UI')
  next = patchNode(next, 'limit', { question: '', roleId: '', instructions: ' ' })
  n = node(next, 'limit')
  assert.ok(n?.type === 'decision')
  assert.equal(n.question, '', 'пустой вопрос остаётся строкой — его подсветит валидация')
  assert.equal(n.roleId, '', 'роль обязательна: пустая остаётся строкой')
  assert.equal('instructions' in n, false, 'пустое «как решать» удаляется')
  // Вопрос есть только у decision: у гейта патч его не добавляет.
  assert.equal('question' in node(patchNode(wf, 'review', { question: 'x' }), 'review')!, false)
})

test('changeNodeType condition ↔ decision: рёбра yes/no сохраняются, роль и инструкция переносятся', () => {
  const g = withCondition()
  const before = edgesFrom(g, 'limit')
  assert.equal(before.length, 2)
  const d = changeNodeType(g, 'limit', 'decision')
  assert.deepEqual(optionsOf(d, 'limit')?.map((o) => o.id), ['yes', 'no'])
  assert.deepEqual(edgesFrom(d, 'limit'), before, 'условие → решение: оба ребра на месте')
  assert.equal(node(d, 'limit')?.title, node(g, 'limit')?.title)
  assert.deepEqual(edgesFrom(changeNodeType(d, 'limit', 'condition'), 'limit'), before, 'решение → условие: оба ребра на месте')

  // Решение со своими вариантами → условие: остаются только рёбра портов yes/no.
  const custom = addDecisionOption(resetDecisionOptions(connect(d, 'limit', 'yes', 'work').workflow, 'limit'), 'limit', 'Design')
  const withDesign = connect(custom.workflow, 'limit', 'design', 'review').workflow
  assert.deepEqual(edgesFrom(changeNodeType(withDesign, 'limit', 'condition'), 'limit').map((e) => e.split('->')[0]), ['no', 'yes'])

  // Роль и инструкция: гейт → решение → работа.
  const gate = patchNode(wf, 'review', { instructions: 'Проверь тесты' })
  const fromGate = changeNodeType(gate, 'review', 'decision')
  const r = node(fromGate, 'review')
  assert.ok(r?.type === 'decision')
  assert.equal(r.roleId, 'reviewer')
  assert.equal(r.instructions, 'Проверь тесты')
  assert.equal(fromGate.edges.some((e) => e.from === 'review'), false, 'accept/reject — не варианты решения')
  const back = node(changeNodeType(fromGate, 'review', 'work'), 'review')
  assert.deepEqual(back?.type === 'work' && back.roleIds, ['reviewer'])
})

test('decisionOptionId: латиница из метки, иначе opt; свободный суффикс; всегда по маске', () => {
  assert.equal(decisionOptionId('Design', []), 'design')
  assert.equal(decisionOptionId('  UI / UX review! ', []), 'ui_ux_review')
  assert.equal(decisionOptionId('Дизайн', []), 'opt')
  assert.equal(decisionOptionId('', ['opt', 'opt_2']), 'opt_3')
  assert.equal(decisionOptionId('yes', ['yes']), 'yes_2')
  for (const label of ['Design', 'x'.repeat(80), '___a', '1 2 3', 'Ёж', 'A'.repeat(24) + ' b']) {
    const id = decisionOptionId(label, [])
    assert.ok(WF_DECISION_OPTION_ID.test(id), `${label} → ${id}`)
    assert.ok(WF_DECISION_OPTION_ID.test(decisionOptionId(label, [id, `${id}_2`])), 'с суффиксом тоже по маске')
  }
})

test('варианты decision: добавить, переименовать, переместить, удалить с ребром, сбросить на «Да / Нет»', () => {
  let g = changeNodeType(withCondition(), 'limit', 'decision')
  const edgesBefore = edgesFrom(g, 'limit')

  const added = addDecisionOption(g, 'limit')
  assert.equal(added.optionId, 'opt')
  g = added.workflow
  assert.deepEqual(optionsOf(g, 'limit')?.map((o) => o.id), ['yes', 'no', 'opt'])
  assert.deepEqual(optionsOf(g, 'limit')?.at(-1), { id: 'opt', label: '' })
  g = connect(g, 'limit', 'opt', 'work').workflow
  assert.ok(g.edges.some((e) => e.from === 'limit' && e.outcome === 'opt'))

  // Метка меняется, id — нет: ребро остаётся.
  g = patchDecisionOption(g, 'limit', 'opt', { label: 'Сначала дизайн', description: 'Есть новые экраны' })
  assert.deepEqual(optionsOf(g, 'limit')?.at(-1), { id: 'opt', label: 'Сначала дизайн', description: 'Есть новые экраны' })
  assert.ok(g.edges.some((e) => e.from === 'limit' && e.outcome === 'opt'))
  g = patchDecisionOption(g, 'limit', 'opt', { description: '  ' })
  assert.deepEqual(optionsOf(g, 'limit')?.at(-1), { id: 'opt', label: 'Сначала дизайн' }, 'пустое пояснение удаляется')
  assert.equal(patchDecisionOption(g, 'limit', 'nope', { label: 'x' }), g)

  // Порядок вариантов — порядок портов.
  g = moveDecisionOption(g, 'limit', 'opt', -1)
  assert.deepEqual(wfPorts(node(g, 'limit')!), ['yes', 'opt', 'no'])
  assert.equal(moveDecisionOption(g, 'limit', 'yes', -1), g, 'выше первого некуда')
  assert.equal(moveDecisionOption(g, 'limit', 'nope', 1), g)
  g = moveDecisionOption(g, 'limit', 'yes', 5)
  assert.deepEqual(wfPorts(node(g, 'limit')!), ['opt', 'no', 'yes'], 'сдвиг за край — в конец')

  // Удаление варианта убирает его ребро, остальные рёбра на месте.
  const removed = removeDecisionOption(g, 'limit', 'opt')
  assert.deepEqual(wfPorts(node(removed, 'limit')!), ['no', 'yes'])
  assert.equal(removed.edges.some((e) => e.from === 'limit' && e.outcome === 'opt'), false)
  assert.deepEqual(edgesFrom(removed, 'limit'), edgesBefore)
  assert.equal(removeDecisionOption(removed, 'limit', 'opt'), removed)

  // Сброс: yes/no с рёбрами остаются, прочие варианты уходят с рёбрами; метки — «Да / Нет».
  g = patchDecisionOption(g, 'limit', 'yes', { label: 'Конечно' })
  const reset = resetDecisionOptions(g, 'limit')
  assert.deepEqual(optionsOf(reset, 'limit'), [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }])
  assert.deepEqual(edgesFrom(reset, 'limit'), edgesBefore)

  // Не decision и несуществующая нода — граф как есть.
  assert.equal(addDecisionOption(wf, 'review').workflow, wf)
  assert.equal(addDecisionOption(wf, 'review').optionId, undefined)
  assert.equal(resetDecisionOptions(wf, 'nope'), wf)
  assert.equal(removeDecisionOption(wf, 'review', 'accept'), wf)
})

test('варианты decision: не больше WF_DECISION_MAX_OPTIONS, id уникальны', () => {
  let g = changeNodeType(withCondition(), 'limit', 'decision')
  while ((optionsOf(g, 'limit')?.length ?? 0) < WF_DECISION_MAX_OPTIONS) g = addDecisionOption(g, 'limit', 'Option').workflow
  const ids = optionsOf(g, 'limit')!.map((o) => o.id)
  assert.deepEqual(ids, ['yes', 'no', 'option', 'option_2', 'option_3', 'option_4', 'option_5', 'option_6'])
  const over = addDecisionOption(g, 'limit', 'more')
  assert.equal(over.workflow, g)
  assert.equal(over.optionId, undefined)
})

test('импорт графа с decision: тип известен, варианты и рёбра сохраняются', () => {
  const g = connect(changeNodeType(withCondition(), 'limit', 'decision'), 'limit', 'yes', 'work').workflow
  const res = parseWorkflowJson(exportWorkflowJson(g))
  assert.ok('workflow' in res)
  assert.deepEqual(optionsOf(res.workflow, 'limit'), optionsOf(g, 'limit'))
  assert.deepEqual(edgesFrom(res.workflow, 'limit'), edgesFrom(g, 'limit'))
})
