import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateNodeTemplate, validateWorkflow, type WfNode, type WfNodeTemplate, type Workflow } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import {
  applyTemplate, insertTemplate, linkTemplate, nodeTemplatesApi, nodeTemplatesError, nodeTemplatesStaleMessage,
  renamedTemplateInput, templateInput, templateMisfit, templateNodeOf, templateSummary, templateSync, withTemplate
} from './nodeTemplates'
import { graphWithMerge } from './workflowFixture'
import { WF_TYPE_TITLES } from './workflowForm'

const root = graphWithMerge([{ id: 'reviewer' }])
const node = (w: Workflow, id: string): WfNode => w.nodes.find((n) => n.id === id)!

const reviewerTemplate = (over: Partial<WfNodeTemplate> = {}): WfNodeTemplate => ({
  id: 'tpl_1', title: 'Ревьюер', updatedAt: 1000,
  node: { type: 'gate', roleId: 'reviewer', instructions: 'Смотри тесты' },
  ...over
})

test('старый main/preload: понятная ошибка вместо падения', () => {
  assert.throws(() => nodeTemplatesApi({} as Partial<OrcaApi>), { message: nodeTemplatesStaleMessage() })
  assert.throws(() => nodeTemplatesApi(undefined), { message: nodeTemplatesStaleMessage() })
  assert.equal(nodeTemplatesError("Error: No handler registered for 'nodeTemplates:list'"), nodeTemplatesStaleMessage())
  assert.equal(nodeTemplatesError('шаблон нод не сохранён: пустое название'), 'шаблон нод не сохранён: пустое название')
  const api = { nodeTemplates: {} } as Partial<OrcaApi>
  assert.equal(nodeTemplatesApi(api), api.nodeTemplates)
})

test('templateNodeOf: без id, позиции и ссылки на шаблон, копия глубокая', () => {
  const work: WfNode = {
    id: 'impl', type: 'work', x: 40, y: 80, title: 'Реализация', templateId: 'tpl_old', roleIds: ['developer'], instructions: 'Пиши код',
    subflow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], edges: [] }
  }
  const tpl = templateNodeOf(work)
  assert.deepEqual(Object.keys(tpl).sort(), ['instructions', 'roleIds', 'subflow', 'title', 'type'])
  assert.notEqual(tpl.type === 'work' ? tpl.roleIds : undefined, work.type === 'work' ? work.roleIds : undefined)
  assert.equal(work.id, 'impl')
})

test('templateInput и renamedTemplateInput: пустое описание не отправляется, тело — копия', () => {
  const gate = node(root, 'review')
  const input = templateInput(gate, '  Проверка  ', '  ')
  assert.equal(input.title, 'Проверка')
  assert.equal('description' in input, false)
  assert.equal('id' in input, false)
  assert.equal(templateInput(gate, 'A', 'о чём', 'tpl_9').id, 'tpl_9')
  assert.equal(templateInput(gate, 'A', ' о чём ').description, 'о чём')

  const tpl = reviewerTemplate({ description: 'старое' })
  const renamed = renamedTemplateInput(tpl, ' Новое ', '')
  assert.deepEqual(renamed, { id: 'tpl_1', title: 'Новое', node: tpl.node })
  assert.notEqual(renamed.node, tpl.node)
})

test('insertTemplate: копия с templateId, свободный id и позиция; шаблон не меняется', () => {
  const tpl = reviewerTemplate()
  const first = insertTemplate(root, tpl, 120, 60)
  const inserted = node(first.workflow, first.nodeId)
  assert.equal(inserted.type, 'gate')
  assert.equal(inserted.templateId, 'tpl_1')
  assert.deepEqual([inserted.x, inserted.y], [120, 60])
  assert.equal(root.nodes.length + 1, first.workflow.nodes.length)
  assert.equal(new Set(first.workflow.nodes.map((n) => n.id)).size, first.workflow.nodes.length)
  assert.deepEqual(tpl.node, { type: 'gate', roleId: 'reviewer', instructions: 'Смотри тесты' })

  const second = insertTemplate(first.workflow, tpl, 140, 80)
  assert.notEqual(second.nodeId, first.nodeId)
})

test('insertTemplate: путь подзадачи копируется, а не делится с шаблоном', () => {
  const tpl: WfNodeTemplate = {
    id: 'tpl_w', title: 'Работа с ревью', updatedAt: 1,
    node: { type: 'work', subflow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], edges: [] } }
  }
  const res = insertTemplate(root, tpl, 0, 0)
  const copy = node(res.workflow, res.nodeId)
  assert.ok(copy.type === 'work' && copy.subflow && tpl.node.type === 'work' && copy.subflow !== tpl.node.subflow)
})

test('templateSync: нет ссылки, библиотека не загружена, шаблон удалён, совпадает, разошёлся', () => {
  const tpl = reviewerTemplate()
  const inserted = insertTemplate(root, tpl, 0, 0)
  const copy = node(inserted.workflow, inserted.nodeId)

  assert.equal(templateSync(node(root, 'review'), [tpl]).kind, 'none')
  assert.equal(templateSync(copy, null).kind, 'unknown')
  assert.equal(templateSync(copy, []).kind, 'missing')
  assert.equal(templateSync(copy, [tpl]).kind, 'same')
  // положение на холсте и id в сравнении не участвуют
  assert.equal(templateSync({ ...copy, x: 999, y: 1, id: 'other' }, [tpl]).kind, 'same')
  // шаблон пересохранён с тем же содержимым (updatedAt другой) — не тревожим
  assert.equal(templateSync(copy, [reviewerTemplate({ updatedAt: 5000 })]).kind, 'same')
  // шаблон изменился
  const changed = reviewerTemplate({ updatedAt: 5000, node: { type: 'gate', roleId: 'reviewer', instructions: 'Смотри ещё и стили' } })
  const state = templateSync(copy, [changed])
  assert.equal(state.kind, 'differs')
  // правка самой ноды тоже расхождение
  assert.equal(templateSync({ ...copy, title: 'Своё' }, [tpl]).kind, 'differs')
})

test('applyTemplate: тело заменяется, id, позиция и переходы остаются', () => {
  const inserted = insertTemplate(root, reviewerTemplate(), 320, 40)
  let wf = inserted.workflow
  wf = { ...wf, edges: [...wf.edges, { id: 'e_new_acc', from: inserted.nodeId, outcome: 'accept', to: 'end' }, { id: 'e_new_rej', from: inserted.nodeId, outcome: 'reject', to: 'end' }] }
  const changed = reviewerTemplate({ updatedAt: 9, node: { type: 'gate', roleId: 'reviewer', instructions: 'Новое' } })
  const next = applyTemplate(wf, inserted.nodeId, changed)
  const n = node(next, inserted.nodeId)
  assert.ok(n.type === 'gate' && n.instructions === 'Новое')
  assert.deepEqual([n.x, n.y, n.templateId], [320, 40, 'tpl_1'])
  assert.equal(next.edges.length, wf.edges.length)
  assert.equal(templateSync(n, [changed]).kind, 'same')
})

test('applyTemplate: у шаблона другой тип — переходы по несуществующим портам убираются', () => {
  const inserted = insertTemplate(root, reviewerTemplate(), 0, 0)
  const wf: Workflow = {
    ...inserted.workflow,
    edges: [...inserted.workflow.edges, { id: 'e_acc', from: inserted.nodeId, outcome: 'accept', to: 'end' }]
  }
  const human: WfNodeTemplate = { id: 'tpl_1', title: 'Человек', updatedAt: 2, node: { type: 'human' } }
  const next = applyTemplate(wf, inserted.nodeId, human)
  assert.equal(node(next, inserted.nodeId).type, 'human')
  // у human, как и у gate, есть accept — переход остаётся; у work только next — accept убирается
  assert.ok(next.edges.some((e) => e.id === 'e_acc'))
  const work: WfNodeTemplate = { id: 'tpl_1', title: 'Работа', updatedAt: 3, node: { type: 'work' } }
  const back = applyTemplate(wf, inserted.nodeId, work)
  assert.equal(back.edges.some((e) => e.id === 'e_acc'), false)
})

test('applyTemplate: нода Старт и неизвестная нода не меняются', () => {
  const tpl = reviewerTemplate()
  assert.equal(applyTemplate(root, 'start', tpl), root)
  assert.equal(applyTemplate(root, 'nope', tpl), root)
})

test('linkTemplate: ссылка на шаблон после «Сохранить как свою»', () => {
  const next = linkTemplate(root, 'review', 'tpl_7')
  assert.equal(node(next, 'review').templateId, 'tpl_7')
  assert.equal(node(root, 'review').templateId, undefined)
  assert.equal(linkTemplate(root, 'nope', 'tpl_7'), root)
})

test('templateMisfit: в граф типа — любой, в путь подзадачи — без «Вопроса человеку» и вложенного пути', () => {
  const ask: WfNodeTemplate = { id: 'a', title: 'Вопрос', updatedAt: 1, node: { type: 'ask', roleId: 'analyst', instructions: 'о чём спросить' } }
  const nested: WfNodeTemplate = {
    id: 'n', title: 'С путём', updatedAt: 1,
    node: { type: 'work', subflow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], edges: [] } }
  }
  assert.equal(templateMisfit(ask, 'run'), null)
  assert.equal(templateMisfit(nested, 'run'), null)
  assert.match(templateMisfit(ask, 'subtask') ?? '', /Вопрос человеку|недоступен/)
  assert.notEqual(templateMisfit(nested, 'subtask'), null)
  assert.equal(templateMisfit(reviewerTemplate(), 'subtask'), null)
  // согласовано с проверкой core
  assert.ok(validateNodeTemplate(ask, { scope: 'subtask' }).errors.length > 0)
})

test('вставка шаблона даёт граф, который проходит валидацию (роли типа есть)', () => {
  const res = insertTemplate(root, reviewerTemplate(), 500, 500)
  const roles = [{ id: 'developer', title: 'D', agent: 'claude' as const }, { id: 'reviewer', title: 'R', agent: 'claude' as const }]
  const issues = validateWorkflow(res.workflow, { roles })
  assert.equal(issues.errors.some((e) => e.nodeId === res.nodeId && e.code === 'templateIdNotString'), false)
})

test('templateSummary: тип, у «Работы» с путём — что делает путь', () => {
  assert.equal(templateSummary(reviewerTemplate()), WF_TYPE_TITLES.gate)
  const path: WfNodeTemplate = {
    id: 'w', title: 'W', updatedAt: 1,
    node: {
      type: 'work',
      subflow: {
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 }, { id: 'w', type: 'work', x: 0, y: 0 },
          { id: 'rev', type: 'gate', roleId: 'reviewer', x: 0, y: 0 }, { id: 'm', type: 'merge', x: 0, y: 0 }, { id: 'end', type: 'end', merged: true, x: 0, y: 0 }
        ],
        edges: [
          { id: 'e1', from: 'start', outcome: 'next', to: 'w' }, { id: 'e2', from: 'w', outcome: 'next', to: 'rev' },
          { id: 'e3', from: 'rev', outcome: 'accept', to: 'm' }, { id: 'e4', from: 'rev', outcome: 'reject', to: 'w' },
          { id: 'e5', from: 'm', outcome: 'ok', to: 'end' }
        ]
      }
    }
  }
  assert.match(templateSummary(path), /ревью \+ мерж/)
})

test('withTemplate: существующий заменяется на месте, новый — в конец', () => {
  const a = reviewerTemplate({ id: 'a' })
  const b = reviewerTemplate({ id: 'b' })
  const b2 = reviewerTemplate({ id: 'b', title: 'Новое' })
  assert.deepEqual(withTemplate([a, b], b2).map((x) => x.title), ['Ревьюер', 'Новое'])
  assert.deepEqual(withTemplate([a], b).map((x) => x.id), ['a', 'b'])
})
