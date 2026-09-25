// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Типы задач: заготовки типов, правило разрешения типа прогона.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GENERAL_TASK_TYPE_ID, LEGACY_TASK_TYPE_DESCRIPTION, presetTaskType,
  presetTaskTypes, resolveRunType, resolveTaskType, runTypeInput, snapshotTaskType,
  taskTypeFromLegacyProject, type TaskType
} from './task-types.ts'
import { DEFAULT_ROLES, type Role } from './types.ts'
import { defaultWorkflow, nextStage, pipelineWorkflow, startStage, validateWorkflow } from './workflow.ts'

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

describe('заготовки типов', () => {
  it('набор и уникальные id: id не меняются — на них ссылаются старые проекты и прогоны, по ним сверяет засев', () => {
    const types = presetTaskTypes()
    assert.deepEqual(types.map((t) => t.id), ['general', 'frontend', 'backend', 'fullstack', 'mobile', 'autotests', 'docs'])
    for (const t of types) {
      assert.deepEqual(Object.keys(t).sort(), ['description', 'id', 'settings', 'title'], `${t.id}: заготовка — обычный тип без особых полей`)
      assert.ok(t.title.trim(), `${t.id}: пустое название`)
      assert.ok(!('columns' in t.settings), `${t.id}: колонки у типа`)
      assert.ok(!('enabledAgents' in t.settings), `${t.id}: агенты у типа`)
    }
    assert.equal(new Set(types.map((t) => t.title)).size, types.length, 'повтор названий')
  })

  it('названия — по виду задачи, а не проекта', () => {
    assert.deepEqual(presetTaskTypes().map((t) => t.title), [
      'Программирование', 'Фронтенд', 'Бэкенд', 'Фронтенд и бэкенд', 'Мобильная разработка', 'QA: автотесты', 'Документация'
    ])
  })

  for (const t of presetTaskTypes()) {
    it(`«${t.title}»: роли с уникальными id, coordinator и assistant из DEFAULT_ROLES, есть рабочая роль`, () => {
      const roles = t.settings.roles ?? []
      const ids = roles.map((r) => r.id)
      assert.equal(new Set(ids).size, ids.length, `повтор id ролей: ${ids.join(', ')}`)
      for (const r of roles) assert.ok(r.title.trim() && r.id.trim(), `пустой id или название у ${r.id}`)
      for (const service of ['coordinator', 'assistant']) {
        const own = roles.find((r) => r.id === service)
        const base = DEFAULT_ROLES.find((r) => r.id === service)!
        assert.ok(own, `нет роли ${service}`)
        assert.equal(own.agent, base.agent)
        assert.equal(own.description, base.description)
      }
      assert.ok(roles.some((r) => r.id !== 'coordinator' && r.id !== 'assistant'), 'нет рабочих ролей')
    })
  }

  it('«Программирование» — дефолт: DEFAULT_ROLES и defaultWorkflow', () => {
    const general = presetTaskType(GENERAL_TASK_TYPE_ID)!
    assert.deepEqual(general.settings.roles, DEFAULT_ROLES)
    assert.deepEqual(general.settings.workflow, defaultWorkflow(DEFAULT_ROLES))
  })

  it('«Фронтенд и бэкенд»: задача frontend после ревью идёт к человеку, backend — сразу в мерж', () => {
    const wf = presetTaskType('fullstack')!.settings.workflow!
    const afterReview = (roleId: string): string => {
      const ctx = { roleId }
      const work = startStage(wf, ctx)
      const review = nextStage(wf, work.stage, 'next', ctx)
      assert.equal(review.stage.nodeId, 'review')
      return nextStage(wf, review.stage, 'accept', ctx).stage.nodeId
    }
    assert.equal(afterReview('frontend'), 'eyes')
    assert.equal(afterReview('backend'), 'merge')
  })

  it('«Бэкенд»: после ревью — прогон тестов ролью qa, затем мерж', () => {
    const wf = presetTaskType('backend')!.settings.workflow!
    const ctx = { roleId: 'developer' }
    const work = startStage(wf, ctx)
    const review = nextStage(wf, work.stage, 'next', ctx)
    const tests = nextStage(wf, review.stage, 'accept', ctx)
    assert.deepEqual(tests.action, { type: 'create_gate', nodeId: 'tests', roleId: 'qa' })
    assert.equal(nextStage(wf, tests.stage, 'accept', ctx).stage.nodeId, 'merge')
    assert.equal(nextStage(wf, tests.stage, 'reject', ctx).stage.nodeId, 'work')
  })

  it('«Документация»: ревью делает человек, агентного гейта нет', () => {
    const wf = presetTaskType('docs')!.settings.workflow!
    assert.equal(wf.nodes.some((n) => n.type === 'gate'), false)
    assert.ok(wf.nodes.some((n) => n.type === 'human' && n.id === 'review'))
  })

  it('каждый вызов — свежие объекты', () => {
    const a = presetTaskType(GENERAL_TASK_TYPE_ID)!
    a.settings.roles![0].model = 'opus'
    assert.equal(presetTaskType(GENERAL_TASK_TYPE_ID)!.settings.roles![0].model, undefined)
    assert.equal(presetTaskType('нет такого'), undefined)
  })

  it('графы заготовок валидны по своим ролям без колонок доски', () => {
    for (const t of presetTaskTypes()) {
      const r = resolveTaskType(t)
      const v = validateWorkflow(r.workflow, { roles: r.roles })
      assert.deepEqual(v.errors, [], t.id)
      // Возврат в работу без лимита повторов — как у дефолтного графа; других предупреждений быть не должно.
      assert.deepEqual(v.warnings.filter((w) => !w.message.includes('без лимита повторов')), [], t.id)
    }
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
  const library = (): TaskType[] => [...presetTaskTypes(), docsType()]

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
    const r = resolveRunType({ typeId: 'type_docs', taskType: snapshotTaskType(docsType()) }, presetTaskTypes(), 'backend')
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

  it('неизвестный тип по умолчанию — «Программирование» из библиотеки', () => {
    const fromLib = resolveRunType(undefined, library(), 'type_gone')
    assert.equal(fromLib.typeId, GENERAL_TASK_TYPE_ID)
    assert.equal(fromLib.source, 'default')
  })

  it('«Программирование» удалён — первый тип библиотеки, а не заготовка из кода', () => {
    const lib = library().filter((t) => t.id !== GENERAL_TASK_TYPE_ID)
    const r = resolveRunType({}, lib, 'type_gone')
    assert.equal(r.typeId, 'frontend')
    assert.equal(resolveRunType({}, [docsType()], undefined).typeId, 'type_docs')
  })

  it('пустая библиотека (старый main) — заготовка «Программирование» из кода', () => {
    const r = resolveRunType({}, [], undefined)
    assert.equal(r.typeId, GENERAL_TASK_TYPE_ID)
    assert.deepEqual(r.roles, DEFAULT_ROLES)
  })

  it('правленный тип из библиотеки важнее заготовки из кода', () => {
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
  })

  it('проект без настроек — DEFAULT_ROLES и зафиксированный дефолтный граф; пустые правила не переносятся', () => {
    const t = taskTypeFromLegacyProject({ name: 'old', agentRules: '  ' }, 'type_p2')
    assert.deepEqual(t.settings, { roles: DEFAULT_ROLES, workflow: defaultWorkflow(DEFAULT_ROLES) })
    // Граф зафиксирован: удаление ревьюера из ролей типа его не меняет.
    t.settings.roles = t.settings.roles!.filter((r) => r.id !== 'reviewer')
    assert.deepEqual(resolveTaskType(t).workflow, defaultWorkflow(DEFAULT_ROLES))
  })
})
