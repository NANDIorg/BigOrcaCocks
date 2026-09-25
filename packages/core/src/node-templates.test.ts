// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Шаблоны нод: проверка перед сохранением в библиотеку (docs/workflow.md, «Шаблоны нод»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateNodeTemplate } from './node-templates.ts'
import type { WfNodeTemplate } from './node-templates.ts'
import { defaultSubflow } from './workflow.ts'

const tpl = (node: Record<string, unknown>, extra: Partial<WfNodeTemplate> = {}): WfNodeTemplate =>
  ({ id: 'tpl_1', title: 'Мой шаблон', node, updatedAt: 1, ...extra }) as unknown as WfNodeTemplate
const codes = (list: { code?: string }[]): (string | undefined)[] => list.map((i) => i.code)

describe('validateNodeTemplate', () => {
  it('нода любого типа, кроме «Старт», проходит без замечаний', () => {
    const nodes: Record<string, unknown>[] = [
      { type: 'work', roleIds: ['developer'], instructions: 'делай', showcase: { what: 'макеты' } },
      { type: 'work', subflow: defaultSubflow() },
      { type: 'gate', roleId: 'reviewer', instructions: 'смотри диф' },
      { type: 'ask', roleId: 'developer', instructions: 'о чём спросить' },
      { type: 'human', instructions: 'проверь' },
      { type: 'merge' },
      { type: 'git', operation: 'push', remote: 'origin' },
      { type: 'git', operation: 'commit', message: 'feat: {title}' },
      { type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 3 } },
      { type: 'end', merged: true }
    ]
    for (const node of nodes) {
      assert.deepEqual(validateNodeTemplate(tpl(node)), { errors: [], warnings: [] }, JSON.stringify(node))
    }
  })

  it('роли шаблона против проекта не проверяются (при вставке), но служебная роль — ошибка', () => {
    assert.deepEqual(validateNodeTemplate(tpl({ type: 'gate', roleId: 'нет_такой_роли' })).errors, [])
    assert.deepEqual(codes(validateNodeTemplate(tpl({ type: 'gate', roleId: 'coordinator' })).errors), ['roleService'])
  })

  it('поля самого шаблона: id, название, описание, время', () => {
    const bad = validateNodeTemplate(tpl({ type: 'merge' }, { id: ' ', title: '', description: 5 as unknown as string, updatedAt: NaN }))
    assert.deepEqual(codes(bad.errors), ['templateNoId', 'templateNoTitle', 'templateNotString', 'templateBadUpdatedAt'])
    assert.match(bad.errors[2].message, /поле «description»/)
    assert.equal(validateNodeTemplate(tpl({ type: 'merge' }, { description: 'зачем нужен' })).errors.length, 0)
  })

  it('нода: не объект, неизвестный тип, «Старт»', () => {
    for (const node of [null, 'work', {}, { type: 'unknown' }]) {
      assert.deepEqual(codes(validateNodeTemplate(tpl(node as unknown as Record<string, unknown>)).errors), ['templateBadNode'], JSON.stringify(node))
    }
    assert.deepEqual(codes(validateNodeTemplate(tpl({ type: 'start' })).errors), ['templateNodeStart'])
    assert.deepEqual(codes(validateNodeTemplate(null as unknown as WfNodeTemplate).errors).slice(0, 2), ['templateNoId', 'templateNoTitle'])
  })

  it('содержимое ноды проверяется как в графе: ошибки ноды и её пути, без замечаний по соседям', () => {
    const noRole = validateNodeTemplate(tpl({ type: 'gate', roleId: '' }))
    assert.deepEqual(codes(noRole.errors), ['gateNoRole'])
    const badPath = { ...defaultSubflow(), edges: defaultSubflow().edges.slice(1) }
    const v = validateNodeTemplate(tpl({ type: 'work', subflow: badPath }))
    assert.ok(v.errors.length > 0)
    assert.ok(v.errors.every((i) => i.subflowOf?.nodeId === 'template' && i.nodeId === 'template' || i.nodeId?.startsWith('template/')))
    // Путь с ask и показ без человека дальше в шаблоне — не проблема шаблона; ask в пути — проблема.
    assert.deepEqual(validateNodeTemplate(tpl({ type: 'work', showcase: { what: 'макеты' } })).warnings, [])
    const withAsk = defaultSubflow()
    withAsk.nodes.push({ id: 'q', type: 'ask', roleId: 'developer', instructions: 'вопрос', x: 0, y: 0 })
    assert.ok(validateNodeTemplate(tpl({ type: 'work', subflow: withAsk })).errors.some((i) => i.code === 'subflowAskNotAllowed'))
    assert.deepEqual(codes(validateNodeTemplate(tpl({ type: 'git', operation: 'checkout', branch: 'x' })).errors), ['gitRunOperation'])
  })

  it('scope subtask: шаблон, который нельзя вставить в путь подзадачи, — ошибка', () => {
    assert.deepEqual(validateNodeTemplate(tpl({ type: 'ask', roleId: 'developer', instructions: 'вопрос' })).errors, [])
    assert.deepEqual(codes(validateNodeTemplate(tpl({ type: 'ask', roleId: 'developer', instructions: 'вопрос' }), { scope: 'subtask' }).errors), ['subflowAskNotAllowed'])
    assert.deepEqual(codes(validateNodeTemplate(tpl({ type: 'work', subflow: defaultSubflow() }), { scope: 'subtask' }).errors), ['subflowNested'])
    assert.deepEqual(validateNodeTemplate(tpl({ type: 'work' }), { scope: 'subtask' }).errors, [])
  })
})
