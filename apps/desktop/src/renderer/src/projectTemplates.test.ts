import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, builtinTemplate, type AgentInfo, type ProjectTemplate } from '@orca-board/core'
import type { OrcaApi, Project, TemplatesState } from '../../shared/ipc'
import {
  TEMPLATES_STALE_MESSAGE, deleteConfirmText, overridesBuiltin, patchedTemplate, pickTemplateId, renamedTemplate,
  resolveTemplateSettings, splitTemplates, templateAgents, templateUsage, templatesApi, templatesError
} from './projectTemplates'

const own: ProjectTemplate = {
  id: 'tpl_1', title: 'Мой', description: 'для сервисов',
  settings: { permissionMode: 'acceptEdits', agentRules: 'правило', enabledAgents: ['claude'] }
}
const general = builtinTemplate('general')!
const frontend = builtinTemplate('frontend')!
const state: TemplatesState = { templates: [general, frontend, own], defaultTemplateId: 'general' }

test('старый preload без templates — понятная ошибка, старый main — «перезапустите»', () => {
  assert.throws(() => templatesApi({} as Partial<OrcaApi>), { message: TEMPLATES_STALE_MESSAGE })
  assert.throws(() => templatesApi(undefined), { message: TEMPLATES_STALE_MESSAGE })
  assert.equal(templatesError("Error: No handler registered for 'templates:list'"), TEMPLATES_STALE_MESSAGE)
  assert.equal(templatesError('шаблон: пустое название'), 'шаблон: пустое название')
})

test('незаданные разделы шаблона — встроенные значения', () => {
  const r = resolveTemplateSettings({})
  assert.equal(r.permissionMode, 'auto')
  assert.equal(r.roles, DEFAULT_ROLES)
  assert.equal(r.columns, DEFAULT_COLUMNS)
  assert.equal(r.agentRules, '')
  assert.equal('enabledAgents' in r, false)
  assert.equal('workflow' in r, false)
  assert.deepEqual(resolveTemplateSettings(own.settings).enabledAgents, ['claude'])
})

test('правка собирает шаблон целиком: null и пустые правила удаляют поле, остальное не трогается', () => {
  const input = patchedTemplate(own, { enabledAgents: null, agentRules: '  \n', columns: DEFAULT_COLUMNS })
  assert.deepEqual(input, {
    id: 'tpl_1', title: 'Мой', description: 'для сервисов',
    settings: { permissionMode: 'acceptEdits', columns: DEFAULT_COLUMNS }
  })
  // Исходный шаблон не мутируется.
  assert.deepEqual(own.settings.enabledAgents, ['claude'])
  assert.equal(patchedTemplate({ ...own, description: undefined }, {}).description, undefined)
})

test('переименование: пустое название — ошибка, пустое описание убирает поле', () => {
  assert.deepEqual(renamedTemplate(own, '   ', 'x'), { error: 'Название шаблона не может быть пустым' })
  const r = renamedTemplate(own, ' Сервисы ', '  ')
  assert.ok(!('error' in r))
  assert.equal(r.title, 'Сервисы')
  assert.equal('description' in r, false)
  assert.equal(r.settings, own.settings)
})

test('встроенные отдельно от своих; копия встроенного «Общего» — своя, но удаление вернёт встроенный', () => {
  const generalCopy: ProjectTemplate = { id: 'general', title: 'Общий', settings: {} }
  const split = splitTemplates([general, frontend, own])
  assert.deepEqual(split.builtin.map((t) => t.id), ['general', 'frontend'])
  assert.deepEqual(split.own.map((t) => t.id), ['tpl_1'])
  assert.deepEqual(splitTemplates([generalCopy, frontend]).own.map((t) => t.id), ['general'])
  assert.equal(overridesBuiltin(generalCopy), true)
  assert.equal(overridesBuiltin(own), false)
  assert.equal(overridesBuiltin(general), false)
})

test('проекты считаются по templateId, без поля — не считаются', () => {
  const p = (id: string, templateId?: string): Project => ({ id, root: `/${id}`, name: id, ...(templateId ? { templateId } : {}) })
  assert.deepEqual(templateUsage([p('a', 'tpl_1'), p('b', 'tpl_1'), p('c', 'frontend'), p('d')]), { tpl_1: 2, frontend: 1 })
})

test('выбранный шаблон: запомненный, если есть, иначе по умолчанию', () => {
  assert.equal(pickTemplateId(state, 'frontend'), 'frontend')
  assert.equal(pickTemplateId(state, 'tpl_gone'), 'general')
  assert.equal(pickTemplateId(state, null), 'general')
})

test('агенты включены по шаблону: нет списка — все установленные', () => {
  const a = (id: string, installed = true): AgentInfo =>
    ({ id, title: id, installed, enabled: false, models: [], config: {} }) as unknown as AgentInfo
  const agents = [a('claude'), a('codex'), a('gemini', false)]
  assert.deepEqual(templateAgents(agents, undefined).map((x) => x.enabled), [true, true, false])
  assert.deepEqual(templateAgents(agents, ['codex', 'gemini']).map((x) => x.enabled), [false, true, false])
})

test('подтверждение удаления говорит о шаблоне по умолчанию и проектах из него', () => {
  const asDefault = deleteConfirmText(own, { ...state, defaultTemplateId: 'tpl_1' }, 2)
  assert.match(asDefault, /им станет «Общий»/)
  assert.match(asDefault, /проекты \(2\)/)
  assert.match(deleteConfirmText(own, state, 0), /Существующие проекты не изменятся/)
  assert.match(deleteConfirmText({ id: 'general', title: 'Общий', settings: {} }, state, 0), /вернётся встроенный/)
})
