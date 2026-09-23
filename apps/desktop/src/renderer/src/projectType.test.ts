import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, builtinTemplate, type AgentInfo, type ProjectTemplate } from '@orca-board/core'
import type { Project, TemplatesState } from '../../shared/ipc'
import {
  applyPreview, isStaleTemplatesError, projectAsTemplateSettings, projectBase, templateDiffRows, templatesApi, writableTemplates
} from './projectType'

const agent = (id: string): AgentInfo =>
  ({ id, title: id, installed: true, enabled: true, models: [], config: {} }) as unknown as AgentInfo
const agents = [agent('claude'), agent('codex')]
const project: Project = { id: 'p', root: '/r', name: 'r' }
const general: ProjectTemplate = { id: 'general', title: 'Общий', builtin: true, settings: {} }
const mine: ProjectTemplate = { id: 'tpl_1', title: 'Мой', settings: { permissionMode: 'acceptEdits' } }
const state: TemplatesState = { templates: [general, mine], defaultTemplateId: 'general' }

test('templatesApi: без шаблонов в preload — null (старый UI), с ними — оба метода', () => {
  assert.equal(templatesApi(undefined), null)
  assert.equal(templatesApi({ projects: {} } as never), null)
  const api = { templates: { list: () => Promise.resolve(state) }, projects: { applyTemplate: () => Promise.resolve(project) } }
  assert.ok(templatesApi(api as never))
  assert.ok(isStaleTemplatesError("No handler registered for 'templates:list'"))
  assert.ok(isStaleTemplatesError("No handler registered for 'projects:applyTemplate'"))
  assert.ok(!isStaleTemplatesError('шаблон не найден: x'))
})

test('projectBase: свой шаблон, висячий и пустой templateId — шаблон по умолчанию с пояснением', () => {
  assert.deepEqual(projectBase({ templateId: 'tpl_1' }, state), { template: mine, own: true })
  const gone = projectBase({ templateId: 'tpl_gone' }, state)
  assert.equal(gone?.template.id, 'general')
  assert.equal(gone?.own, false)
  assert.match(gone?.note ?? '', /удалён \(tpl_gone\).*«Общий»/)
  const none = projectBase({}, state)
  assert.equal(none?.template.id, 'general')
  assert.match(none?.note ?? '', /Тип не задан/)
  assert.equal(projectBase({}, { templates: [], defaultTemplateId: 'general' }), null)
})

test('templateDiffRows: роли расписаны по одной — изменённая, недостающая и лишняя', () => {
  const extra = { id: 'designer', title: 'Дизайнер', agent: 'claude' as const }
  const roles = [
    ...DEFAULT_ROLES.filter((r) => r.id !== 'qa').map((r) => (r.id === 'developer' ? { ...r, model: 'opus' } : r)),
    extra
  ]
  const rows = templateDiffRows({ ...project, roles, permissionMode: 'acceptEdits' }, {}, agents)
  assert.deepEqual(rows.map((r) => r.section), ['roles', 'permissions'])
  const byId = Object.fromEntries((rows[0].roles ?? []).map((r) => [r.id, r.change]))
  assert.deepEqual(byId, { developer: 'changed', qa: 'removed', designer: 'added' })
  assert.equal(rows[1].roles, undefined)
  assert.deepEqual(templateDiffRows(project, {}, agents), [])
})

test('applyPreview: колонки уходят — задачи в backlog, роли пропадают — задачи на них', () => {
  const col = { id: 'col_x', title: 'Тестирование', color: '#2ea043', kind: 'custom' as const }
  const extra = { id: 'designer', title: 'Дизайнер', agent: 'claude' as const }
  const p = { ...project, columns: [...DEFAULT_COLUMNS, col], roles: [...DEFAULT_ROLES, extra] }
  const tasks = [
    { status: 'col_x', roleId: 'designer' },
    { status: 'col_x', roleId: 'developer' },
    { status: DEFAULT_COLUMNS[0].id, roleId: 'designer' }
  ]
  const all = applyPreview(p, {}, { sections: ['agents', 'roles', 'columns', 'workflow', 'permissions', 'agentRules'] }, tasks)
  assert.deepEqual(all.columnsGone, [{ id: 'col_x', title: 'Тестирование', tasks: 2 }])
  assert.equal(all.backlogTasks, 2)
  assert.deepEqual(all.rolesGone.map((r) => [r.id, r.tasks]), [['designer', 2]])
  assert.match(all.rolesGone[0].consequences.join(' '), /Задачи на этой роли \(2\)/)
  assert.equal(all.setsType, true)
  assert.equal(all.error, null)
  assert.ok(all.notes.some((n) => /новых прогонов/.test(n)))

  // Только разрешения — колонки и роли не трогаются, тип не меняется.
  const perm = applyPreview(p, { permissionMode: 'acceptEdits' }, { sections: ['permissions'] }, tasks)
  assert.deepEqual([perm.columnsGone, perm.backlogTasks, perm.rolesGone, perm.setsType], [[], 0, [], false])

  // Одна роль из шаблона, которой в шаблоне нет, — удаляется; остальные на месте.
  const one = applyPreview(p, {}, { sections: ['roles'], roleIds: ['designer'] }, tasks)
  assert.deepEqual(one.rolesGone.map((r) => r.id), ['designer'])
})

test('applyPreview: граф шаблона без его ролей — ошибка с подсказкой, последствия всё равно посчитаны', () => {
  const fullstack = builtinTemplate('fullstack')
  assert.ok(fullstack)
  const res = applyPreview(project, fullstack.settings, { sections: ['workflow'] }, [])
  assert.match(res.error ?? '', /воркфлоу проекта ломается.*примените вместе с разделами: роли/)
  assert.equal(applyPreview(project, fullstack.settings, { sections: ['roles', 'workflow'] }, []).error, null)
})

test('projectAsTemplateSettings: роли и колонки явно, без своего графа и пустых правил', () => {
  assert.deepEqual(projectAsTemplateSettings({ ...project, agentRules: '  ' }), {
    permissionMode: 'auto', roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS
  })
  const s = projectAsTemplateSettings({ ...project, enabledAgents: ['claude'], agentRules: 'Тесты рядом с кодом' })
  assert.deepEqual(s.enabledAgents, ['claude'])
  assert.equal(s.agentRules, 'Тесты рядом с кодом')
  assert.deepEqual(writableTemplates(state).map((t) => t.id), ['tpl_1'])
})
