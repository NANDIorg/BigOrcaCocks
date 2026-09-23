import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES } from './types.ts'
import type { Role } from './types.ts'
import { defaultWorkflow } from './workflow.ts'
import { appliedWorkflowErrors, applySections, mergeRole, sectionDiffLine, sectionsDiff } from './template-sections.ts'
import type { SectionSettings } from './template-sections.ts'

const agents = [
  { id: 'claude', title: 'Claude Code', installed: true },
  { id: 'codex', title: 'Codex', installed: true },
  { id: 'gemini', title: 'Gemini', installed: false }
] as const
const agentList = agents.map((a) => ({ ...a }))
const designer: Role = { id: 'designer', title: 'Дизайнер', description: '', agent: 'claude', model: '', effort: '', systemPrompt: '' } as Role
const withoutReviewer = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
const lines = (p: SectionSettings, t: SectionSettings): string[] =>
  sectionsDiff(p, t, agentList).map((d) => sectionDiffLine(d, agentList))

describe('sectionsDiff', () => {
  it('пустой проект совпадает с пустым шаблоном и с заполненным встроенными значениями', () => {
    assert.deepEqual(sectionsDiff({}, {}, agentList), [])
    assert.deepEqual(sectionsDiff({}, { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS, permissionMode: 'auto' }, agentList), [])
  })

  it('роли: добавленные, удалённые и изменённые — по id', () => {
    const roles = [...withoutReviewer.map((r) => (r.id === 'qa' ? { ...r, model: 'x' } : r)), designer]
    const [d] = sectionsDiff({ roles }, {}, agentList)
    assert.equal(d?.section, 'roles')
    if (d?.section !== 'roles') return
    assert.deepEqual(d.added.map((r) => r.id), ['designer'])
    assert.deepEqual(d.removed.map((r) => r.id), ['reviewer'])
    assert.deepEqual(d.changed.map((r) => r.id), ['qa'])
    assert.equal(d.reordered, false)
    assert.equal(sectionDiffLine(d, agentList), 'роли (+1 «Дизайнер», −1 «Ревьюер», изменено 1)')
  })

  it('агенты сравниваются среди установленных; порядок строк — как TEMPLATE_SECTIONS', () => {
    assert.deepEqual(
      lines({ enabledAgents: ['claude', 'gemini'], permissionMode: 'acceptEdits', agentRules: 'x' }, {}),
      ['агенты (−Codex)', 'разрешения', 'правила доски']
    )
  })

  it('воркфлоу: свой граф, равный дефолтному по ролям, отличием не считается', () => {
    assert.deepEqual(lines({ workflow: defaultWorkflow(DEFAULT_ROLES) }, {}), [])
    assert.deepEqual(lines({}, { roles: withoutReviewer, workflow: defaultWorkflow(withoutReviewer) }), [
      'роли (+1 «Ревьюер»)',
      'воркфлоу'
    ])
  })
})

describe('mergeRole', () => {
  it('заменяет роль с тем же id на месте, новую добавляет в конец, исходный массив не меняет', () => {
    const src = [...DEFAULT_ROLES]
    const changed = { ...DEFAULT_ROLES[1]!, title: 'Новый' }
    const out = mergeRole(src, changed)
    assert.equal(out[1]?.title, 'Новый')
    assert.equal(out.length, src.length)
    assert.deepEqual(src, DEFAULT_ROLES)
    assert.deepEqual(mergeRole(src, designer).map((r) => r.id).at(-1), 'designer')
  })
})

describe('applySections', () => {
  const project = { id: 'p', root: '/r', name: 'r', permissionMode: 'acceptEdits', roles: [...DEFAULT_ROLES, designer], agentRules: 'своё' }

  it('берёт только выбранные разделы, остальное и чужие поля проекта сохраняет', () => {
    const tpl: SectionSettings = { permissionMode: 'bypassPermissions', agentRules: 'шаблон', roles: DEFAULT_ROLES }
    const out = applySections(project, tpl, ['permissions'])
    assert.equal(out.permissionMode, 'bypassPermissions')
    assert.equal(out.agentRules, 'своё')
    assert.equal(out.roles?.length, DEFAULT_ROLES.length + 1)
    assert.equal(out.root, '/r')
    assert.equal(project.permissionMode, 'acceptEdits', 'исходный проект не меняется')
  })

  it('раздел, которого нет в шаблоне, у проекта удаляется — действует встроенное значение', () => {
    const out = applySections(project, {}, ['roles', 'agentRules'])
    assert.equal('roles' in out, false)
    assert.equal('agentRules' in out, false)
    assert.deepEqual(sectionsDiff(out, {}, agentList).map((d) => d.section), ['permissions'])
  })

  it('результат не делит объекты с шаблоном', () => {
    const tpl: SectionSettings = { roles: [{ ...designer }] }
    const out = applySections({}, tpl, ['roles'])
    out.roles![0]!.title = 'изменено'
    assert.equal(tpl.roles![0]!.title, 'Дизайнер')
  })

  it('roleIds: одна роль из шаблона, отсутствующая в шаблоне — удаляется, остальные не трогаются', () => {
    const tplRoles = DEFAULT_ROLES.map((r) => (r.id === 'qa' ? { ...r, model: 'tpl' } : r.id === 'developer' ? { ...r, model: 'tpl' } : r))
    const out = applySections(project, { roles: tplRoles }, ['roles'], ['qa', 'designer'])
    assert.equal(out.roles?.find((r) => r.id === 'qa')?.model, 'tpl')
    assert.notEqual(out.roles?.find((r) => r.id === 'developer')?.model, 'tpl')
    assert.equal(out.roles?.some((r) => r.id === 'designer'), false)
  })

  it('роли без воркфлоу ломают граф — русская ошибка с подсказкой; вместе с воркфлоу — применяется', () => {
    const p = { workflow: defaultWorkflow(DEFAULT_ROLES) }
    const tpl: SectionSettings = { roles: withoutReviewer, workflow: defaultWorkflow(withoutReviewer) }
    assert.throws(() => applySections(p, tpl, ['roles']), (e: Error) => {
      assert.match(e.message, /^после применения шаблона воркфлоу проекта ломается: .*нет роли «reviewer» в проекте/)
      assert.match(e.message, /примените вместе с разделами: воркфлоу$/)
      return true
    })
    assert.throws(() => applySections({ roles: withoutReviewer }, { workflow: defaultWorkflow(DEFAULT_ROLES) }, ['workflow']), (e: Error) => {
      assert.match(e.message, /примените вместе с разделами: роли, колонки$/)
      return true
    })
    const out = applySections(p, tpl, ['roles', 'workflow'])
    assert.deepEqual(appliedWorkflowErrors(out), [])
  })

  it('битый граф проекта не мешает применить разделы, не связанные с ним', () => {
    const broken = { roles: withoutReviewer, workflow: defaultWorkflow(DEFAULT_ROLES) }
    assert.notEqual(appliedWorkflowErrors(broken).length, 0)
    assert.equal(applySections(broken, { permissionMode: 'auto' }, ['permissions']).permissionMode, 'auto')
  })
})
