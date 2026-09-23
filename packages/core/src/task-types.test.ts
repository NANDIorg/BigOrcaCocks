// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Типы задач: встроенные типы из шаблонов, правка встроенного на месте, правило разрешения типа прогона.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_EDITABLE_TYPE_ROLE_FIELDS, GENERAL_TASK_TYPE_ID, LEGACY_TASK_TYPE_DESCRIPTION, builtinTaskType,
  builtinTaskTypes, isBuiltinTypeInPlaceEdit, resolveRunType, resolveTaskType, runTypeInput, snapshotTaskType,
  taskTypeFromLegacyProject, type TaskType
} from './task-types.ts'
import { builtinTemplates } from './templates.ts'
import { DEFAULT_ROLES, type Role } from './types.ts'
import { defaultWorkflow, pipelineWorkflow, validateWorkflow } from './workflow.ts'

const writer: Role = { id: 'writer', title: 'Автор', agent: 'codex', model: 'gpt-5' }

/** Пользовательский тип «Документация»: своя роль, правила, разрешения и граф с проверкой человеком. */
function docsType(): TaskType {
  const roles = [...DEFAULT_ROLES.filter((r) => r.id === 'coordinator').map((r) => ({ ...r })), { ...writer }]
  return {
    id: 'type_docs',
    title: 'Документация',
    settings: {
      roles,
      agentRules: 'Пиши по-русски.',
      permissionMode: 'acceptEdits',
      workflow: pipelineWorkflow([{ type: 'human', id: 'review', title: 'Ревью человеком' }])
    }
  }
}

describe('встроенные типы', () => {
  it('те же id, названия и роли, что у встроенных шаблонов, без колонок и агентов', () => {
    const types = builtinTaskTypes()
    const templates = builtinTemplates()
    assert.deepEqual(types.map((t) => t.id), templates.map((t) => t.id))
    for (const [i, t] of types.entries()) {
      assert.equal(t.builtin, true)
      assert.equal(t.title, templates[i].title)
      assert.deepEqual(t.settings.roles, templates[i].settings.roles)
      assert.deepEqual(t.settings.workflow, templates[i].settings.workflow)
      assert.ok(!('columns' in t.settings), `${t.id}: колонки у типа`)
      assert.ok(!('enabledAgents' in t.settings), `${t.id}: агенты у типа`)
    }
  })

  it('каждый вызов — свежие объекты', () => {
    const a = builtinTaskType(GENERAL_TASK_TYPE_ID)!
    a.settings.roles![0].model = 'opus'
    assert.equal(builtinTaskType(GENERAL_TASK_TYPE_ID)!.settings.roles![0].model, undefined)
    assert.equal(builtinTaskType('нет такого'), undefined)
  })

  it('графы встроенных типов валидны по своим ролям без колонок доски', () => {
    for (const t of builtinTaskTypes()) {
      const r = resolveTaskType(t)
      assert.deepEqual(validateWorkflow(r.workflow, { roles: r.roles }).errors, [], t.id)
    }
  })
})

describe('правка встроенного типа на месте (isBuiltinTypeInPlaceEdit)', () => {
  const base = (): TaskType => builtinTaskType('backend')!
  const edited = (patch: (t: TaskType) => void): TaskType => {
    const t = base()
    patch(t)
    return t
  }

  it('исполнитель, системный промпт ролей и правила — на месте', () => {
    assert.deepEqual([...BUILTIN_EDITABLE_TYPE_ROLE_FIELDS], ['agent', 'model', 'effort', 'systemPrompt'])
    assert.ok(isBuiltinTypeInPlaceEdit(base(), base()))
    assert.ok(isBuiltinTypeInPlaceEdit(base(), edited((t) => {
      t.settings.roles![2] = { ...t.settings.roles![2], agent: 'codex', model: 'gpt-5', effort: 'high', systemPrompt: 'Свой промпт' }
    })))
    assert.ok(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.settings.agentRules = 'Свои правила' })))
    assert.ok(isBuiltinTypeInPlaceEdit(base(), edited((t) => { delete t.settings.agentRules })))
  })

  it('название, состав ролей, граф и разрешения — только через копию', () => {
    assert.equal(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.title = 'Мой бэкенд' })), false)
    assert.equal(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.description = 'другое' })), false)
    assert.equal(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.settings.roles![2].title = 'Сеньор' })), false)
    assert.equal(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.settings.roles!.pop() })), false)
    assert.equal(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.settings.workflow = defaultWorkflow([]) })), false)
    assert.equal(isBuiltinTypeInPlaceEdit(base(), edited((t) => { t.settings.permissionMode = 'bypassPermissions' })), false)
  })
})

describe('resolveTaskType и снимок', () => {
  it('пустые разделы — значения по умолчанию', () => {
    const r = resolveTaskType({ id: 'empty', title: 'Пустой', settings: {} })
    assert.deepEqual(r.roles, DEFAULT_ROLES)
    assert.notEqual(r.roles, DEFAULT_ROLES)
    assert.equal(r.agentRules, '')
    assert.equal(r.permissionMode, 'auto')
    assert.deepEqual(r.workflow, defaultWorkflow(DEFAULT_ROLES))
  })

  it('снимок и вход для store — копии: правка типа их не меняет', () => {
    const t = docsType()
    const snap = snapshotTaskType(t)
    const input = runTypeInput(t)
    t.settings.roles![1].model = 'другая'
    t.settings.workflow!.nodes.length = 0
    assert.deepEqual(snap, { id: 'type_docs', title: 'Документация', roles: [DEFAULT_ROLES[0], writer], agentRules: 'Пиши по-русски.', permissionMode: 'acceptEdits' })
    assert.equal(input.typeId, 'type_docs')
    assert.deepEqual(input.snapshot, snap)
    assert.deepEqual(input.workflow, docsType().settings.workflow)
  })
})

describe('resolveRunType: какой тип у прогона', () => {
  const library = (): TaskType[] => [...builtinTaskTypes(), docsType()]

  it('тип прогона есть в библиотеке — берутся его живые роли', () => {
    const lib = library()
    lib[lib.length - 1].settings.roles![1].model = 'gpt-5.1'
    const r = resolveRunType({ typeId: 'type_docs', taskType: snapshotTaskType(docsType()) }, lib, 'backend')
    assert.equal(r.source, 'type')
    assert.equal(r.typeId, 'type_docs')
    assert.equal(r.roles.find((x) => x.id === 'writer')?.model, 'gpt-5.1')
    assert.equal(r.agentRules, 'Пиши по-русски.')
    assert.equal(r.permissionMode, 'acceptEdits')
    assert.deepEqual(r.workflow, docsType().settings.workflow)
  })

  it('тип удалён — роли, правила и разрешения из снимка прогона', () => {
    const r = resolveRunType({ typeId: 'type_docs', taskType: snapshotTaskType(docsType()) }, builtinTaskTypes(), 'backend')
    assert.equal(r.source, 'snapshot')
    assert.equal(r.typeId, 'type_docs')
    assert.equal(r.title, 'Документация')
    assert.deepEqual(r.roles.map((x) => x.id), ['coordinator', 'writer'])
    assert.equal(r.agentRules, 'Пиши по-русски.')
    assert.equal(r.permissionMode, 'acceptEdits')
    assert.deepEqual(r.workflow, defaultWorkflow(r.roles))
  })

  it('нет typeId («Входящие», старый прогон) или нет прогона — тип проекта по умолчанию', () => {
    for (const run of [{}, undefined]) {
      const r = resolveRunType(run, library(), 'type_docs')
      assert.equal(r.source, 'default')
      assert.equal(r.typeId, 'type_docs')
      assert.deepEqual(r.roles.map((x) => x.id), ['coordinator', 'writer'])
    }
  })

  it('тип удалён и снимка нет — тип проекта по умолчанию', () => {
    const r = resolveRunType({ typeId: 'type_gone' }, library(), 'backend')
    assert.equal(r.source, 'default')
    assert.equal(r.typeId, 'backend')
  })

  it('неизвестный тип по умолчанию — «Общий», даже если его нет в библиотеке', () => {
    const fromLib = resolveRunType(undefined, library(), 'type_gone')
    assert.equal(fromLib.typeId, GENERAL_TASK_TYPE_ID)
    assert.equal(fromLib.source, 'default')
    const fromCode = resolveRunType({}, [docsType()], undefined)
    assert.equal(fromCode.typeId, GENERAL_TASK_TYPE_ID)
    assert.deepEqual(fromCode.roles, DEFAULT_ROLES)
  })

  it('подмена встроенного в библиотеке (правка на месте) важнее встроенного из кода', () => {
    const lib = library()
    lib[0].settings.roles![2].model = 'opus'
    const r = resolveRunType({}, lib, undefined)
    assert.equal(r.roles.find((x) => x.id === 'developer')?.model, 'opus')
  })
})

describe('taskTypeFromLegacyProject', () => {
  it('роли, граф, правила и разрешения проекта переходят в тип «<имя проекта>»', () => {
    const wf = pipelineWorkflow([{ type: 'human', id: 'eyes', title: 'Глазами' }])
    const t = taskTypeFromLegacyProject(
      { name: 'orca-board', roles: [writer], workflow: wf, agentRules: 'Правила', permissionMode: 'bypassPermissions' },
      'type_p1'
    )
    assert.deepEqual(t, {
      id: 'type_p1',
      title: 'orca-board',
      description: LEGACY_TASK_TYPE_DESCRIPTION,
      settings: { roles: [writer], workflow: wf, agentRules: 'Правила', permissionMode: 'bypassPermissions' }
    })
    assert.equal(t.builtin, undefined)
  })

  it('проект без настроек — DEFAULT_ROLES и зафиксированный дефолтный граф; пустые правила не переносятся', () => {
    const t = taskTypeFromLegacyProject({ name: 'old', agentRules: '  ' }, 'type_p2')
    assert.deepEqual(t.settings, { roles: DEFAULT_ROLES, workflow: defaultWorkflow(DEFAULT_ROLES) })
    // Граф зафиксирован: удаление ревьюера из ролей типа его не меняет.
    t.settings.roles = t.settings.roles!.filter((r) => r.id !== 'reviewer')
    assert.deepEqual(resolveTaskType(t).workflow, defaultWorkflow(DEFAULT_ROLES))
  })
})
