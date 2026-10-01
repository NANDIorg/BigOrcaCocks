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
import { defaultWorkflow, nextRunStage, pipelineWorkflow, startRunStage, validateWorkflow } from './workflow.ts'
import { TaskStore } from './store.ts'

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
  it('«Входящие» и старый прогон без графа сразу выполняют свою задачу, без глобальной подготовки и серверного этапа fullstack', () => {
    for (const type of presetTaskTypes()) {
      const s = new TaskStore()
      const role = type.settings.roles!.find((r) => !['coordinator', 'reviewer', 'qa', 'ui-review'].includes(r.id))!
      const inbox = s.createTask({ title: 'Одна задача', roleId: role.id })
      const fallback = { roleIds: type.settings.roles!.map((r) => r.id), workflow: type.settings.workflow }
      const before = structuredClone(type.settings.workflow)
      s.enterWork(inbox.id, fallback)
      assert.equal(s.getTask(inbox.id)!.stage?.nodeId, 'work', type.id)
      const scoped = s.runWorkflow(inbox.runId, fallback)
      assert.deepEqual(scoped.nodes.filter((n) => n.type === 'work').map((n) => n.id), ['work'], type.id)
      assert.deepEqual(validateWorkflow(scoped, { roles: type.settings.roles! }).errors.map((e) => e.code), ['versionOld'], type.id)
      const legacy = s.createRun('Старый прогон без графа')
      assert.deepEqual(s.runWorkflow(legacy.id, fallback), scoped, type.id)
      assert.deepEqual(type.settings.workflow, before, 'глобальный граф не изменился при проекции')
    }
  })
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
    it(`«${t.title}»: роли с уникальными id, coordinator из DEFAULT_ROLES, без assistant, есть рабочая роль`, () => {
      const roles = t.settings.roles ?? []
      const ids = roles.map((r) => r.id)
      assert.equal(new Set(ids).size, ids.length, `повтор id ролей: ${ids.join(', ')}`)
      for (const r of roles) assert.ok(r.title.trim() && r.id.trim(), `пустой id или название у ${r.id}`)
      const own = roles.find((r) => r.id === 'coordinator')
      const base = DEFAULT_ROLES.find((r) => r.id === 'coordinator')!
      assert.ok(own, 'нет роли coordinator')
      assert.equal(own.agent, base.agent)
      assert.equal(own.description, base.description)
      // Ассистент — настройки приложения (AppSettings.assistant), а не роль типа.
      assert.ok(!ids.includes('assistant'), 'роль assistant в заготовке')
      assert.ok(roles.some((r) => r.id !== 'coordinator' && r.id !== 'assistant'), 'нет рабочих ролей')
    })
  }

  it('«Программирование» сохраняет стандартные роли, но выполняет независимый QA', () => {
    const general = presetTaskType(GENERAL_TASK_TYPE_ID)!
    assert.deepEqual(general.settings.roles!.map((r) => [r.id, r.agent]), DEFAULT_ROLES.map((r) => [r.id, r.agent]))
    assert.ok(general.settings.roles!.every((r) => r.systemPrompt?.trim()))
    assert.ok(general.settings.workflow!.nodes.some((n) => n.type === 'gate' && n.roleId === 'qa'))
  })

  it('«Фронтенд и бэкенд»: контракт → сервер → интеграция обеих сторон → независимые проверки', () => {
    const wf = presetTaskType('fullstack')!.settings.workflow!
    const first = startRunStage(wf)
    assert.deepEqual(first.action, { type: 'start_stage', nodeId: 'contract', roleIds: ['backend'] })
    const api = nextRunStage(wf, first.stage, 'next')
    assert.deepEqual(api.action, { type: 'start_stage', nodeId: 'api', roleIds: ['backend'] })
    const integration = nextRunStage(wf, api.stage, 'next')
    assert.deepEqual(integration.action, { type: 'start_stage', nodeId: 'work', roleIds: ['frontend', 'backend'] })
    const review = nextRunStage(wf, integration.stage, 'next')
    assert.equal(review.stage.nodeId, 'review')
    assert.equal(nextRunStage(wf, review.stage, 'accept').action.type, 'create_gate')
    assert.equal(nextRunStage(wf, review.stage, 'reject').stage.nodeId, 'work', 'отказ — в последнюю работу')
  })

  it('«Бэкенд»: после ревью — прогон тестов ролью qa, затем проверка человеком', () => {
    const wf = presetTaskType('backend')!.settings.workflow!
    const analysis = startRunStage(wf)
    assert.deepEqual(analysis.action, { type: 'start_stage', nodeId: 'contract', roleIds: ['developer'] })
    const work = nextRunStage(wf, analysis.stage, 'next')
    assert.deepEqual(work.action, { type: 'start_stage', nodeId: 'work', roleIds: ['developer'] })
    const review = nextRunStage(wf, work.stage, 'next')
    const tests = nextRunStage(wf, review.stage, 'accept')
    assert.deepEqual(tests.action, { type: 'create_gate', nodeId: 'tests', roleId: 'qa' })
    assert.equal(nextRunStage(wf, tests.stage, 'accept').action.type, 'request_human')
    assert.equal(nextRunStage(wf, tests.stage, 'reject').stage.nodeId, 'work')
  })

  it('«Документация»: источники и примеры проверяет агент, результат принимает человек', () => {
    const wf = presetTaskType('docs')!.settings.workflow!
    assert.ok(wf.nodes.some((n) => n.type === 'gate' && n.roleId === 'reviewer'))
    assert.ok(wf.nodes.some((n) => n.type === 'human' && n.id === 'review'))
  })

  it('все объявленные рабочие роли действительно участвуют в этапах или проверках', () => {
    for (const type of presetTaskTypes()) {
      const wf = type.settings.workflow!
      const used = new Set(wf.nodes.flatMap((node) => node.type === 'work' ? node.roleIds?.length ? node.roleIds : type.settings.roles!.filter((r) => r.id !== 'coordinator').map((r) => r.id) : node.type === 'gate' ? [node.roleId] : []))
      for (const r of type.settings.roles!) if (r.id !== 'coordinator') assert.ok(used.has(r.id), `${type.id}: роль ${r.id} никогда не запускается`)
    }
  })

  it('доменные проверки реально исполняются до финальной приёмки', () => {
    const expected: Record<string, string[]> = {
      general: ['reviewer', 'qa'], frontend: ['reviewer', 'qa', 'ui-review'],
      backend: ['reviewer', 'qa'], fullstack: ['reviewer', 'qa', 'ui-review'],
      mobile: ['qa', 'reviewer', 'qa'], autotests: ['reviewer', 'qa'], docs: ['reviewer']
    }
    for (const type of presetTaskTypes()) {
      const wf = type.settings.workflow!
      let current = startRunStage(wf)
      const gates: string[] = []
      let human = false
      for (let steps = 0; steps < wf.nodes.length; steps++) {
        if (current.action.type === 'create_gate') gates.push(current.action.roleId)
        else if (current.action.type === 'request_human') human = true
        else if (current.action.type === 'done') break
        else assert.equal(current.action.type, 'start_stage', `${type.id}: лишний обязательный этап`)
        current = nextRunStage(wf, current.stage, current.action.type === 'start_stage' ? 'next' : 'accept')
      }
      assert.deepEqual(gates, expected[type.id], type.id)
      assert.ok(human, `${type.id}: нет ручной приёмки`)
      assert.equal(current.action.type, 'done', type.id)
    }
  })

  it('отказ любой проверки возвращает исполнителей и заново запускает всю цепочку проверок', () => {
    for (const type of presetTaskTypes()) {
      const wf = type.settings.workflow!
      for (const check of wf.nodes.filter((n) => n.type === 'gate' || n.type === 'human')) {
        const rejected = nextRunStage(wf, { nodeId: check.id, visits: { work: 1, [check.id]: 1 } }, 'reject')
        assert.equal(rejected.action.type, 'start_stage', `${type.id}/${check.id}`)
        assert.equal(rejected.stage.nodeId, 'work', `${type.id}/${check.id}: возврат в неподходящую роль`)
        assert.equal(rejected.stage.visits.work, 2)
        const repeat = nextRunStage(wf, rejected.stage, 'next')
        const firstGate = wf.nodes.find((n) => n.type === 'gate')
        assert.ok(firstGate, `${type.id}: нет независимой проверки`)
        assert.equal(repeat.stage.nodeId, firstGate.id, `${type.id}/${check.id}: старые проверки пропущены`)
      }
    }
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

  it('снимок несёт флаги запуска роли (extraArgs) как введены', () => {
    const t = docsType()
    t.settings.roles![1] = { ...t.settings.roles![1], extraArgs: '  --search -s "workspace write" ' }
    const snap = snapshotTaskType(t)
    assert.equal(snap.roles[1].extraArgs, '  --search -s "workspace write" ')
    assert.equal(snap.roles[0].extraArgs, undefined)
    assert.equal(runTypeInput(t).snapshot.roles[1].extraArgs, '  --search -s "workspace write" ')
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

  it('снимок прогона до переноса ассистента в настройки — роль assistant отфильтрована', () => {
    const snap = snapshotTaskType(docsType())
    const old = { ...snap, roles: [snap.roles[0], { id: 'assistant', title: 'Ассистент', agent: 'claude' as const }, ...snap.roles.slice(1)] }
    const r = resolveRunType({ typeId: 'type_docs', taskType: old }, presetTaskTypes(), 'backend')
    assert.equal(r.source, 'snapshot')
    assert.deepEqual(r.roles.map((x) => x.id), ['coordinator', 'writer'])
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
    assert.deepEqual(r.roles, presetTaskType(GENERAL_TASK_TYPE_ID)!.settings.roles)
  })

  it('правленный тип из библиотеки важнее заготовки из кода', () => {
    const lib = library()
    lib[0].settings.roles!.find((x) => x.id === 'developer')!.model = 'opus'
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
