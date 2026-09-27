import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, defaultSubflow, validateWorkflow, type WfIssue, type WfNodeType, type Workflow } from '@orca-board/core'
import { wfAddableTypes } from './workflowEdit'
import {
  WF_PALETTE_GROUPS, filterTemplates, groupProblems, issueCard, mainPath, matchesQuery, nodeCardIssues, paletteGroups,
  shortIssueText
} from './workflowEditorView'
import { graphWithMerge } from './workflowFixture'

const describe = (type: WfNodeType): string[] => [type, type === 'gate' ? 'проверка ветки агентом' : '']

test('палитра: каждый добавляемый тип — ровно в одной группе', () => {
  const all = WF_PALETTE_GROUPS.flatMap((g) => g.types)
  assert.equal(new Set(all).size, all.length)
  for (const type of wfAddableTypes('run')) assert.ok(all.includes(type), type)
})

test('палитра: пустой запрос — все группы, в пути подзадачи — без запрещённых типов', () => {
  const run = paletteGroups(wfAddableTypes('run'), '', describe)
  assert.deepEqual(run.map((g) => g.id), ['agent', 'human', 'app', 'bound'])
  const sub = paletteGroups(wfAddableTypes('subtask'), '  ', describe)
  const types = sub.flatMap((g) => g.types)
  assert.ok(!types.includes('ask'))
  assert.ok(!types.includes('decision'))
  assert.ok(types.includes('work'))
})

test('палитра: поиск по пояснению без учёта регистра, пустые группы уходят', () => {
  const res = paletteGroups(wfAddableTypes('run'), 'ВЕТКИ агент', describe)
  assert.deepEqual(res, [{ id: 'agent', types: ['gate'] }])
  assert.deepEqual(paletteGroups(wfAddableTypes('run'), 'нет-такого', describe), [])
})

test('matchesQuery: все слова должны найтись, пропуски в текстах не мешают', () => {
  assert.ok(matchesQuery('', []))
  assert.ok(matchesQuery('диз рев', ['Дизайн-ревью', undefined]))
  assert.ok(!matchesQuery('диз мерж', ['Дизайн-ревью']))
})

test('свои ноды: поиск по названию, описанию и сводке', () => {
  const list = [
    { title: 'Дизайн-ревью', description: 'роль designer' },
    { title: 'Фронтенд с тестами' }
  ]
  assert.deepEqual(filterTemplates(list, 'designer').map((x) => x.title), ['Дизайн-ревью'])
  assert.deepEqual(filterTemplates(list, 'работа', (x) => (x.title.startsWith('Фронт') ? 'Работа' : '')).map((x) => x.title), ['Фронтенд с тестами'])
  assert.equal(filterTemplates(list, '').length, 2)
})

test('карточка проблемы: по коду, путь подзадачи — всегда «Путь подзадачи», неизвестное — «Основное»', () => {
  assert.equal(issueCard({ code: 'gateNoRole' }), 'who')
  assert.equal(issueCard({ code: 'missingOutcome' }), 'out')
  assert.equal(issueCard({ code: 'endlessLoop' }), 'out')
  assert.equal(issueCard({ code: 'gitNoBranch' }), 'what')
  assert.equal(issueCard({ code: 'subflowNoMerge' }), 'path')
  assert.equal(issueCard({ code: 'gateNoRole', subflowOf: { nodeId: 'impl', title: 'Реализация' } }), 'path')
  assert.equal(issueCard({ code: 'nodeDuplicateId' }), 'main')
  assert.equal(issueCard({}), 'main')
})

test('проблемы ноды по карточкам: худший уровень, чужие карточки — в «Основное»', () => {
  const issues = {
    errors: [
      { message: 'a', code: 'gateNoRole', nodeId: 'rev' },
      { message: 'b', code: 'missingOutcome', nodeId: 'other' }
    ],
    warnings: [
      { message: 'c', code: 'endlessLoop', nodeId: 'rev' },
      { message: 'd', code: 'roleMissing', nodeId: 'rev' }
    ]
  } satisfies { errors: WfIssue[]; warnings: WfIssue[] }
  const res = nodeCardIssues(issues, 'rev', ['main', 'who', 'out'], (i) => i.message.toUpperCase())
  assert.deepEqual(res.get('who'), { level: 'error', messages: ['A', 'D'] })
  assert.deepEqual(res.get('out'), { level: 'warning', messages: ['C'] })
  assert.equal(res.has('main'), false)
  // У ноды без карточки «Кто выполняет» проблема роли видна в «Основном».
  const cond = nodeCardIssues(issues, 'rev', ['main', 'out'], (i) => i.message)
  assert.deepEqual(cond.get('main'), { level: 'error', messages: ['a', 'd'] })
  assert.equal(nodeCardIssues(undefined, 'rev', ['main'], (i) => i.message).size, 0)
})

test('shortIssueText: снимает префикс ноды и пути, остальные двоеточия не трогает', () => {
  assert.equal(shortIssueText('нода «Ревью»: не выбрана роль проверяющего'), 'Не выбрана роль проверяющего')
  assert.equal(shortIssueText('node “Review”: no reviewer role'), 'No reviewer role')
  assert.equal(
    shortIssueText('нода «Реализация» → путь подзадачи: нода «Мерж»: нет перехода для «конфликт»'),
    'Нет перехода для «конфликт»'
  )
  assert.equal(shortIssueText('нет ноды «Конец»'), 'Нет ноды «Конец»')
  assert.equal(
    shortIssueText('нода «Git»: в поле «branch» неизвестная подстановка «{x}», доступны: {id}'),
    'В поле «branch» неизвестная подстановка «{x}», доступны: {id}'
  )
})

test('группы проблем: по нодам, группы с ошибками — первыми', () => {
  const issues = {
    errors: [
      { message: 'e1', nodeId: 'b' },
      { message: 'e2' }
    ],
    warnings: [
      { message: 'w1', nodeId: 'a' },
      { message: 'w2', nodeId: 'b' },
      { message: 'w3', edgeId: 'e_x' }
    ]
  } satisfies { errors: WfIssue[]; warnings: WfIssue[] }
  const groups = groupProblems(issues)
  assert.deepEqual(groups.map((g) => [g.nodeId ?? g.edgeId ?? '-', g.level, g.items.map((i) => i.issue.message)]), [
    ['b', 'error', ['e1', 'w2']],
    ['-', 'error', ['e2']],
    ['a', 'warning', ['w1']],
    ['e_x', 'warning', ['w3']]
  ])
})

test('группы проблем настоящего графа: у каждой проблемы с нодой есть группа', () => {
  const wf: Workflow = structuredClone(graphWithMerge([{ id: 'reviewer' }]))
  const gate = wf.nodes.find((n) => n.type === 'gate')
  assert.ok(gate && gate.type === 'gate')
  gate.roleId = ''
  const issues = validateWorkflow(wf, { roles: DEFAULT_ROLES })
  const groups = groupProblems(issues)
  assert.ok(groups.some((g) => g.nodeId === gate.id && g.level === 'error'))
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), issues.errors.length + issues.warnings.length)
})

test('основной путь: от старта по первому исходу, путь по умолчанию — работа, мерж, конец', () => {
  const sub = defaultSubflow()
  const types = mainPath(sub).map((n) => n.type)
  assert.equal(types[0], 'start')
  assert.ok(types.includes('work'))
  assert.equal(types[types.length - 1], 'end')
  // Цикл не зацикливает: второй заход в ноду обрывает путь.
  const loop = {
    nodes: [
      { id: 's', type: 'start' as const, x: 0, y: 0 },
      { id: 'w', type: 'work' as const, x: 0, y: 0 }
    ],
    edges: [
      { id: 'e1', from: 's', outcome: 'next', to: 'w' },
      { id: 'e2', from: 'w', outcome: 'next', to: 's' }
    ]
  }
  assert.deepEqual(mainPath(loop).map((n) => n.id), ['s', 'w'])
  assert.deepEqual(mainPath({ nodes: [], edges: [] }), [])
})
