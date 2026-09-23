import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, defaultWorkflow, type AgentInfo } from '@orca-board/core'
import { defaultsDiff } from './about/defaultsDiff'

const agent = (id: string, installed = true): AgentInfo =>
  ({ id, title: id, installed, enabled: true, models: [], config: {} }) as unknown as AgentInfo
const agents = [agent('claude'), agent('codex'), agent('gemini', false)]
const defaults = { permissionMode: 'auto' as const, roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS }
const project = { id: 'p', root: '/r', name: 'r' }

test('проект без своих настроек совпадает с дефолтом', () => {
  assert.deepEqual(defaultsDiff(project, defaults, agents), [])
})

test('лишняя колонка, выключенный агент и режим разрешений попадают в отличия', () => {
  const columns = [...DEFAULT_COLUMNS, { id: 'col_x', title: 'Тестирование', color: '#2ea043', kind: 'custom' as const }]
  const diff = defaultsDiff(
    { ...project, columns, enabledAgents: ['claude'], permissionMode: 'acceptEdits' },
    defaults,
    agents
  )
  assert.deepEqual(diff, ['агенты (−codex)', 'колонки (+1 «Тестирование»)', 'разрешения'])
})

test('изменённая роль и порядок колонок', () => {
  const roles = DEFAULT_ROLES.map((r, i) => (i === 1 ? { ...r, title: r.title + '!' } : r))
  const diff = defaultsDiff({ ...project, roles, columns: [...DEFAULT_COLUMNS].reverse() }, defaults, agents)
  assert.deepEqual(diff, ['роли (изменено 1)', 'колонки (порядок)'])
})

test('правила доски: отличие по тексту без пробелов по краям', () => {
  assert.deepEqual(defaultsDiff({ ...project, agentRules: '- без ORION' }, defaults, agents), ['правила доски'])
  assert.deepEqual(defaultsDiff({ ...project, agentRules: '- без ORION\n' }, { ...defaults, agentRules: '- без ORION' }, agents), [])
})

test('воркфлоу: без своих графов совпадает, свой граф проекта — отличие', () => {
  const wf = defaultWorkflow(DEFAULT_ROLES)
  assert.deepEqual(defaultsDiff({ ...project, workflow: wf }, defaults, agents), [])
  const moved = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'end' ? { ...n, title: 'Готово' } : n)) }
  assert.deepEqual(defaultsDiff({ ...project, workflow: moved }, defaults, agents), ['воркфлоу'])
  assert.deepEqual(defaultsDiff(project, { ...defaults, workflow: moved }, agents), ['воркфлоу'])
})
