import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, WORKFLOW_VERSION, defaultSubflow, validateWorkflow, type WfNode, type WfSubflow, type Workflow } from '@orca-board/core'
import { addNode, issueTargets, wfAddableTypes } from './workflowEdit'
import { wfIssueText } from './defaultTitles'
import {
  canOpenPath, crumbs, graphAt, hasCustomSubflow, isDefaultLike, levelIssues, locateId, resolvePath, resetSubflow, scopeOf,
  startCustomSubflow, subflowSteps, subflowSummary, writeGraphAt
} from './workflowNav'
import { graphWithMerge } from './workflowFixture'

const roles = DEFAULT_ROLES
const root = graphWithMerge([{ id: 'reviewer' }])
const node = (w: Workflow, id: string): WfNode => w.nodes.find((n) => n.id === id)!

/** Путь «ревью + мерж»: работа → проверка → мерж → конец, отказ проверки — обратно в работу. */
function reviewedPath(): WfSubflow {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w', type: 'work', x: 200, y: 0 },
      { id: 'rev', type: 'gate', roleId: 'reviewer', x: 400, y: 0 },
      { id: 'm', type: 'merge', x: 600, y: 0 },
      { id: 'end', type: 'end', merged: true, x: 800, y: 0 },
      { id: 'conflict', type: 'human', title: 'Конфликт', x: 600, y: 160 }
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'w' },
      { id: 'e2', from: 'w', outcome: 'next', to: 'rev' },
      { id: 'e3', from: 'rev', outcome: 'accept', to: 'm' },
      { id: 'e4', from: 'rev', outcome: 'reject', to: 'w' },
      { id: 'e5', from: 'm', outcome: 'ok', to: 'end' },
      { id: 'e6', from: 'm', outcome: 'conflict', to: 'conflict' },
      { id: 'e7', from: 'conflict', outcome: 'accept', to: 'm' },
      { id: 'e8', from: 'conflict', outcome: 'reject', to: 'w' }
    ]
  }
}

const withPath = (sub: WfSubflow): Workflow => ({ ...root, nodes: root.nodes.map((n) => (n.id === 'work' && n.type === 'work' ? { ...n, subflow: sub } : n)) })
const issuesOf = (wf: Workflow) => validateWorkflow(wf, { roles })

test('вход только в «Работу» и только из графа типа', () => {
  assert.equal(canOpenPath(root, [], 'work'), true)
  assert.equal(canOpenPath(root, [], 'review'), false, 'проверка не имеет пути')
  assert.equal(canOpenPath(root, [], 'нет'), false)
  assert.equal(canOpenPath(root, ['work'], 'work'), false, 'внутри пути вложенного пути нет')
  assert.equal(scopeOf([]), 'run')
  assert.equal(scopeOf(['work']), 'subtask')
})

test('graphAt: граф типа, свой путь и образец по умолчанию', () => {
  assert.deepEqual(graphAt(root, []), { graph: root, isDefault: false })
  const def = graphAt(root, ['work'])!
  assert.equal(def.isDefault, true)
  assert.deepEqual(def.graph.nodes, defaultSubflow().nodes)
  assert.equal(def.graph.version, WORKFLOW_VERSION)

  const own = withPath(reviewedPath())
  const at = graphAt(own, ['work'])!
  assert.equal(at.isDefault, false)
  assert.equal(at.graph.nodes.length, 6)
  assert.equal(graphAt(root, ['review']), undefined)
})

test('graphAt: битый путь из файла не роняет редактор — показывается образец по умолчанию', () => {
  const broken = { ...root, nodes: root.nodes.map((n) => (n.id === 'work' ? ({ ...n, subflow: 'мусор' } as unknown as WfNode) : n)) }
  assert.equal(graphAt(broken, ['work'])!.isDefault, true)
  assert.equal(subflowSummary('мусор'), '')
  assert.equal(isDefaultLike('мусор' as unknown as WfSubflow), false)
})

test('resolvePath отбрасывает часть пути, ставшую недействительной', () => {
  assert.deepEqual(resolvePath(root, ['work']), ['work'])
  assert.deepEqual(resolvePath(root, ['нет']), [])
  assert.deepEqual(resolvePath(root, ['work', 'w']), ['work'], 'глубина 1')
})

test('writeGraphAt: правка пути пишется в work.subflow, остальной граф не меняется', () => {
  const own = withPath(reviewedPath())
  const { graph } = graphAt(own, ['work'])!
  const edited = writeGraphAt(own, ['work'], addNode(graph, 'git', 0, 300).workflow)
  const sub = (node(edited, 'work') as Extract<WfNode, { type: 'work' }>).subflow!
  assert.equal(sub.nodes.length, 7)
  assert.equal('version' in sub, false, 'у пути нет своей версии')
  assert.equal(edited.version, own.version)
  assert.equal(node(edited, 'review'), node(own, 'review'))
  assert.equal((node(own, 'work') as Extract<WfNode, { type: 'work' }>).subflow!.nodes.length, 6, 'исходный граф не меняется')
})

test('writeGraphAt: на уровне графа типа заменяет граф, образец по умолчанию не записывается', () => {
  const other = { ...root, nodes: root.nodes.slice(0, 2), edges: [] }
  assert.equal(writeGraphAt(root, [], other), other)
  assert.equal(writeGraphAt(root, ['work'], graphAt(root, ['work'])!.graph), root)
})

test('startCustomSubflow заводит копию умолчания, resetSubflow её убирает', () => {
  const own = startCustomSubflow(root, 'work')
  assert.equal(hasCustomSubflow(node(own, 'work')), true)
  assert.deepEqual((node(own, 'work') as Extract<WfNode, { type: 'work' }>).subflow, defaultSubflow())
  assert.equal(startCustomSubflow(own, 'work'), own, 'повторно не перезаписывает')
  assert.equal(startCustomSubflow(root, 'review'), root, 'не у «Работы» — без изменений')
  const back = resetSubflow(own, 'work')
  assert.equal(hasCustomSubflow(node(back, 'work')), false)
  assert.equal('subflow' in node(back, 'work'), false)
  assert.equal(resetSubflow(root, 'work'), root)
})

test('isDefaultLike: сдвиг нод не считается отличием, новая нода — считается', () => {
  const moved = defaultSubflow()
  moved.nodes[1] = { ...moved.nodes[1], x: 999, y: 999 }
  assert.equal(isDefaultLike(moved), true)
  assert.equal(isDefaultLike(reviewedPath()), false)
})

test('подпись ноды: ревью, человек, мерж, git — по порядку обхода, «только работа» без шагов', () => {
  assert.deepEqual(subflowSteps(reviewedPath()), ['review', 'merge'], 'человек только на конфликте мержа — не в счёт')
  assert.equal(subflowSummary(reviewedPath()), 'ревью + мерж')
  const withHuman = reviewedPath()
  withHuman.edges = withHuman.edges.map((e) => (e.id === 'e3' ? { ...e, to: 'conflict' } : e))
  assert.deepEqual(subflowSteps(withHuman), ['review', 'human', 'merge'], 'человек в основном ходе — в счёт')
  const workOnly: WfSubflow = {
    nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'w', type: 'work', x: 1, y: 0 }, { id: 'end', type: 'end', x: 2, y: 0 }],
    edges: [{ id: 'a', from: 'start', outcome: 'next', to: 'w' }, { id: 'b', from: 'w', outcome: 'next', to: 'end' }]
  }
  assert.equal(subflowSummary(workOnly), 'только работа')
  assert.deepEqual(subflowSteps(defaultSubflow()), ['merge'])
})

test('крошки: «Граф типа › Реализация»', () => {
  const named = { ...root, nodes: root.nodes.map((n) => (n.id === 'work' ? { ...n, title: 'Реализация' } : n)) }
  const c = crumbs(named, ['work'])
  assert.deepEqual(c.map((x) => x.title), ['Граф типа', 'Реализация'])
  assert.deepEqual(c.map((x) => x.path), [[], ['work']])
  assert.deepEqual(crumbs(named, []).map((x) => x.title), ['Граф типа'])
})

test('палитра пути без «Вопроса человеку», палитра графа типа — с ним', () => {
  assert.equal(wfAddableTypes('run').includes('ask'), true)
  assert.equal(wfAddableTypes('subtask').includes('ask'), false)
  assert.deepEqual(wfAddableTypes('subtask'), wfAddableTypes('run').filter((t) => t !== 'ask'))
})

test('locateId: адрес проблемы `impl/rev` → путь и id внутри', () => {
  assert.deepEqual(locateId(root, 'node', 'work/rev'), { path: ['work'], id: 'rev' })
  assert.deepEqual(locateId(root, 'node', 'review'), { path: [], id: 'review' })
  assert.deepEqual(locateId(root, 'edge', 'work/e1'), { path: ['work'], id: 'e1' })
  assert.deepEqual(locateId(root, 'node', 'нет/x'), { path: [], id: 'нет/x' }, 'не «Работа» — как есть')
})

/** Граф с ошибкой в пути (нода «Вопрос человеку») и предупреждением (проверка и в пути, и дальше в графе). */
function brokenPathGraph(): Workflow {
  const sub = reviewedPath()
  sub.nodes.push({ id: 'q', type: 'ask', instructions: 'О чём?', x: 300, y: 300 })
  return withPath(sub)
}

test('levelIssues: на графе типа проблема пути ложится на ноду «Работа», внутри — на ноду пути без префикса', () => {
  const all = issuesOf(brokenPathGraph())
  const ask = all.errors.find((e) => e.code === 'subflowAskNotAllowed')!
  assert.equal(ask.nodeId, 'work/q')
  assert.equal(ask.subflowOf?.nodeId, 'work')

  const top = levelIssues(all, [])
  const topTargets = issueTargets(top)
  assert.equal(topTargets.nodes.get('work')?.level, 'error')
  assert.ok(topTargets.nodes.get('work')!.messages.some((m) => m.startsWith('нода «Работа» → путь подзадачи: ')), 'на графе типа — с префиксом')
  assert.equal(topTargets.nodes.has('work/q'), false)

  const inner = levelIssues(all, ['work'])
  const innerTargets = issueTargets(inner)
  assert.equal(innerTargets.nodes.get('q')?.level, 'error')
  assert.ok(innerTargets.nodes.get('q')!.messages.every((m) => !m.includes('→ путь подзадачи')), 'внутри пути — без префикса')
  assert.equal(innerTargets.nodes.has('work'), false)
})

test('levelIssues: собственная проблема ноды и двойное ревью остаются на графе типа и не попадают в путь', () => {
  const all = issuesOf(withPath(reviewedPath()))
  const double = all.warnings.find((w) => w.code === 'subflowDoubleReview')
  assert.ok(double, 'проверка есть и в пути, и дальше в графе')
  assert.equal(double!.nodeId, 'work')
  assert.equal(issueTargets(levelIssues(all, [])).nodes.get('work')?.level, 'warning')
  assert.equal(levelIssues(all, ['work']).warnings.some((w) => w.code === 'subflowDoubleReview'), false)
})

test('levelIssues: предупреждение «нет мержа» в пути подсвечивает ноду внутри пути', () => {
  const sub = reviewedPath()
  sub.edges = sub.edges.map((e) => (e.id === 'e3' ? { ...e, to: 'end' } : e))
  const all = issuesOf(withPath(sub))
  const noMerge = all.warnings.find((w) => w.code === 'subflowNoMerge')
  assert.ok(noMerge, 'от старта можно дойти до конца, минуя мерж')
  assert.ok(noMerge!.nodeId?.startsWith('work/'))
  const inner = levelIssues(all, ['work'])
  assert.ok(inner.warnings.some((w) => w.code === 'subflowNoMerge' && w.nodeId && !w.nodeId.includes('/')))
})

test('wfIssueText: проблема пути получает префикс на языке интерфейса, обычная — нет', () => {
  const all = issuesOf(brokenPathGraph())
  const ask = all.errors.find((e) => e.code === 'subflowAskNotAllowed')!
  assert.ok(wfIssueText(ask).startsWith('нода «Работа» → путь подзадачи: нода «'))
  const { subflowOf: _subflowOf, ...plain } = ask
  assert.ok(!wfIssueText(plain).includes('→ путь подзадачи'))
})
