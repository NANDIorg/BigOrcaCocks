// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Файл экспорта типа задач: что попадает в файл, текст файла и его имя.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_TYPE_FILE_FORMAT, TASK_TYPE_FILE_VERSION, buildTaskTypeFile, serializeTaskTypeFile, taskTypeFileName,
  type TaskTypeFileMeta
} from './task-type-file.ts'
import { presetTaskType, presetTaskTypes, resolveTaskType, type TaskType } from './task-types.ts'
import { DEFAULT_ROLES } from './types.ts'
import { defaultSubflow, defaultWorkflow, type WfNode, type Workflow } from './workflow.ts'

const meta: TaskTypeFileMeta = { appVersion: '0.9.3', exportedAt: '2026-09-30T12:34:56.000Z' }

/** Все значения по ключу на любой глубине — проверить, что поля нет нигде в файле. */
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesOf(v, key))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([k, v]) => [...(k === key ? [v] : []), ...valuesOf(v, key)])
}

/** Тип со своим графом: ноды из шаблонов (в том числе в пути подзадачи) и колонки. */
function templatedType(): TaskType {
  const sub = defaultSubflow()
  const workflow: Workflow = {
    version: 2,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      {
        id: 'work', type: 'work', x: 220, y: 40, title: 'Реализация', column: 'col_dev', templateId: 'tpl_work',
        subflow: { nodes: sub.nodes.map((n, i): WfNode => ({ ...n, column: `col_sub_${i}`, templateId: `tpl_sub_${i}` })), edges: sub.edges }
      },
      { id: 'review', type: 'gate', roleId: 'reviewer', x: 440, y: 0, column: 'col_review', templateId: 'tpl_gate' },
      { id: 'end', type: 'end', x: 660, y: 0 }
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
      { id: 'e2', from: 'work', outcome: 'next', to: 'review' },
      { id: 'e3', from: 'review', outcome: 'accept', to: 'end' },
      { id: 'e4', from: 'review', outcome: 'reject', to: 'work' }
    ]
  }
  return {
    id: 'type_custom',
    title: '  Свой тип  ',
    description: '  Описание  ',
    settings: { roles: DEFAULT_ROLES.map((r) => ({ ...r })), agentRules: 'Пиши по-русски.', permissionMode: 'acceptEdits', workflow },
    workflowNotes: [{ code: 'mergeRemoved', message: 'Снят merge' }]
  }
}

describe('buildTaskTypeFile', () => {
  it('каждая заготовка даёт файл: метка и версия формата, без id типа, workflowNotes и templateId', () => {
    const presets = presetTaskTypes()
    assert.equal(presets.length, 7)
    for (const preset of presets) {
      const file = buildTaskTypeFile(preset, meta)
      assert.equal(file.format, TASK_TYPE_FILE_FORMAT, preset.id)
      assert.equal(file.format, 'orca-board.task-type')
      assert.equal(file.formatVersion, TASK_TYPE_FILE_VERSION)
      assert.equal(file.formatVersion, 1)
      assert.equal(file.exportedAt, meta.exportedAt)
      assert.equal(file.appVersion, meta.appVersion)
      assert.equal(file.type.title, preset.title)
      assert.equal('id' in file.type, false, preset.id)
      assert.deepEqual(valuesOf(file, 'workflowNotes'), [], preset.id)
      assert.deepEqual(valuesOf(file, 'templateId'), [], preset.id)
      const resolved = resolveTaskType(preset)
      assert.deepEqual(file.type.settings.roles, resolved.roles)
      assert.deepEqual(file.type.settings.workflow, resolved.workflow)
      assert.equal(file.type.settings.permissionMode, resolved.permissionMode)
    }
  })

  it('порядок ключей — как в описании формата', () => {
    const file = buildTaskTypeFile(presetTaskType('backend')!, meta)
    assert.deepEqual(Object.keys(file), ['format', 'formatVersion', 'exportedAt', 'appVersion', 'type'])
    assert.deepEqual(Object.keys(file.type), ['title', 'description', 'settings'])
    assert.deepEqual(Object.keys(file.type.settings), ['permissionMode', 'roles', 'agentRules', 'workflow'])
  })

  it('file.type по форме — вход сохранения типа без id: только title, description и settings', () => {
    const allowed = { type: ['title', 'description', 'settings'], settings: ['permissionMode', 'roles', 'agentRules', 'workflow'] }
    for (const type of [...presetTaskTypes(), templatedType(), { id: 'type_new', title: 'Новый тип', settings: {} }]) {
      const file = buildTaskTypeFile(type, meta)
      assert.deepEqual(Object.keys(file.type).filter((k) => !allowed.type.includes(k)), [], type.id)
      assert.deepEqual(Object.keys(file.type.settings).filter((k) => !allowed.settings.includes(k)), [], type.id)
    }
  })

  it('тип с пустыми настройками: раскрытые DEFAULT_ROLES, defaultWorkflow и auto, без agentRules', () => {
    const file = buildTaskTypeFile({ id: 'type_new', title: 'Новый тип', settings: {} }, meta)
    assert.deepEqual(file.type.settings.roles, DEFAULT_ROLES)
    assert.deepEqual(file.type.settings.workflow, defaultWorkflow(DEFAULT_ROLES))
    assert.equal(file.type.settings.permissionMode, 'auto')
    assert.equal('agentRules' in file.type.settings, false)
    assert.equal('description' in file.type, false)
  })

  it('agentRules: непустые — как есть, из одних пробелов — поля нет', () => {
    const rules = 'Не меняй контракт API.\nМиграции — только новые файлы.\n'
    assert.equal(buildTaskTypeFile({ id: 't', title: 'Т', settings: { agentRules: rules } }, meta).type.settings.agentRules, rules)
    assert.equal('agentRules' in buildTaskTypeFile({ id: 't', title: 'Т', settings: { agentRules: ' \n ' } }, meta).type.settings, false)
  })

  it('templateId снимается у всех нод, включая work.subflow; column, позиции и версия графа сохраняются', () => {
    const type = templatedType()
    const file = buildTaskTypeFile(type, meta)
    assert.deepEqual(valuesOf(file, 'templateId'), [])
    const { workflow } = file.type.settings
    assert.equal(workflow.version, 2)
    const work = workflow.nodes.find((n) => n.id === 'work')!
    assert.equal(work.type, 'work')
    assert.deepEqual([work.column, work.x, work.y, work.title], ['col_dev', 220, 40, 'Реализация'])
    assert.equal(workflow.nodes.find((n) => n.id === 'review')!.column, 'col_review')
    const sub = work.type === 'work' ? work.subflow! : undefined
    assert.ok(sub && sub.nodes.length > 0)
    assert.deepEqual(sub.nodes.map((n) => n.column), sub.nodes.map((_, i) => `col_sub_${i}`))
    // Кроме templateId, из графа ничего не пропало.
    const source = JSON.parse(JSON.stringify(type.settings.workflow, (k, v) => (k === 'templateId' ? undefined : v)))
    assert.deepEqual(workflow, source)
  })

  it('title и description — после trim; пустое описание — поля нет', () => {
    const file = buildTaskTypeFile(templatedType(), meta)
    assert.equal(file.type.title, 'Свой тип')
    assert.equal(file.type.description, 'Описание')
    for (const description of ['', '   ', undefined]) {
      const f = buildTaskTypeFile({ id: 't', title: 'Т', ...(description === undefined ? {} : { description }), settings: {} }, meta)
      assert.equal('description' in f.type, false)
    }
  })

  it('название заготовки — как хранится, без перевода', () => {
    assert.equal(buildTaskTypeFile(presetTaskType('backend')!, meta).type.title, 'Бэкенд')
  })

  it('глубокая копия: правка файла не меняет тип', () => {
    const type = templatedType()
    const before = JSON.stringify(type)
    const file = buildTaskTypeFile(type, meta)
    file.type.settings.roles[0].title = 'Другая'
    file.type.settings.roles.push({ id: 'extra', title: 'Лишняя', agent: 'claude' })
    file.type.settings.workflow.nodes[1].title = 'Другое'
    file.type.settings.workflow.edges.pop()
    const work = file.type.settings.workflow.nodes[1]
    if (work.type === 'work') work.subflow!.nodes.pop()
    assert.equal(JSON.stringify(type), before)
    // templateId снят только в файле: тип в библиотеке ссылку на шаблон не теряет.
    assert.equal(type.settings.workflow!.nodes[1].templateId, 'tpl_work')
  })

  it('сломанный граф не мешает экспорту: проверок графа нет', () => {
    const broken = { version: 2, nodes: [{ id: 'work', type: 'work', x: 0, y: 0, roleIds: ['gone'], subflow: {} }], edges: [] } as unknown as Workflow
    const file = buildTaskTypeFile({ id: 't', title: 'Т', settings: { workflow: broken } }, meta)
    assert.deepEqual(file.type.settings.workflow, broken)
  })
})

describe('serializeTaskTypeFile', () => {
  it('текст разбирается обратно в тот же файл, отступ 2 пробела, в конце перевод строки', () => {
    for (const type of [...presetTaskTypes(), templatedType()]) {
      const file = buildTaskTypeFile(type, meta)
      const text = serializeTaskTypeFile(file)
      assert.deepEqual(JSON.parse(text), file, type.id)
      assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'))
      assert.ok(text.startsWith('{\n  "format": "orca-board.task-type",\n  "formatVersion": 1,\n'))
    }
  })

  it('длинный промпт не усекается', () => {
    const systemPrompt = 'Длинная инструкция. '.repeat(5000)
    const type: TaskType = { id: 't', title: 'Т', settings: { roles: [{ id: 'developer', title: 'Разработчик', agent: 'claude', systemPrompt }] } }
    const parsed = JSON.parse(serializeTaskTypeFile(buildTaskTypeFile(type, meta)))
    assert.equal(parsed.type.settings.roles[0].systemPrompt, systemPrompt)
  })
})

describe('taskTypeFileName', () => {
  it('кириллица сохраняется', () => {
    assert.equal(taskTypeFileName('Бэкенд'), 'task-type-Бэкенд.json')
    assert.equal(taskTypeFileName('Фронтенд и бэкенд'), 'task-type-Фронтенд-и-бэкенд.json')
  })

  it('запрещённые символы, управляющие и пробелы заменяются на дефис', () => {
    assert.equal(taskTypeFileName('a\\b/c:d*e?f"g<h>i|j'), 'task-type-a-b-c-d-e-f-g-h-i-j.json')
    assert.equal(taskTypeFileName('QA: автотесты'), 'task-type-QA-автотесты.json')
    assert.equal(taskTypeFileName('a\u0000b\u001fc\u007fd\te\nf'), 'task-type-a-b-c-d-e-f.json')
    assert.equal(taskTypeFileName('a    b'), 'task-type-a-b.json')
  })

  it('края (дефисы и точки) срезаны', () => {
    assert.equal(taskTypeFileName('  ..Тип.. '), 'task-type-Тип.json')
    assert.equal(taskTypeFileName('/-тип-/'), 'task-type-тип.json')
    assert.equal(taskTypeFileName('v1.2'), 'task-type-v1.2.json')
  })

  it('длинное название усечено до 60 символов, край после усечения тоже срезан', () => {
    assert.equal(taskTypeFileName('я'.repeat(200)), `task-type-${'я'.repeat(60)}.json`)
    assert.equal(taskTypeFileName(`${'a'.repeat(59)} ${'b'.repeat(20)}`), `task-type-${'a'.repeat(59)}.json`)
    // Усечение по кодовым точкам: суррогатная пара не рвётся.
    assert.equal(taskTypeFileName('😀'.repeat(100)), `task-type-${'😀'.repeat(60)}.json`)
  })

  it('пустое название — task-type.json', () => {
    for (const title of ['', '   ', '...', '///', '-.-', '\u0000\n']) assert.equal(taskTypeFileName(title), 'task-type.json', JSON.stringify(title))
  })

  it('зарезервированные имена Windows закрыты префиксом', () => {
    assert.equal(taskTypeFileName('CON'), 'task-type-CON.json')
  })
})
