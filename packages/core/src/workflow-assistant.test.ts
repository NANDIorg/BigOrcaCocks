import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES } from './types.ts'
import { prepareWorkflow, workflowSchema } from './workflow-assistant.ts'

const graph = () => ({
  version: 2,
  nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'work', roleIds: ['developer'] }, { id: 'e', type: 'end' }],
  edges: [{ id: 'sw', from: 's', outcome: 'next', to: 'w' }, { id: 'we', from: 'w', outcome: 'next', to: 'e' }]
})

describe('подготовка графа ассистента', () => {
  it('схема объясняет поля развилок и даёт исполнимый пример без проекта', () => {
    const schema = workflowSchema()
    assert.equal(schema.version, 2)
    assert.ok(schema.roles.some((r) => r.id === 'developer'))
    assert.equal(JSON.stringify(schema).includes('extraArgs'), false)
    assert.ok(schema.nodeTypes.find((n) => n.type === 'decision')?.fields.question)
    assert.ok(schema.nodeTypes.find((n) => n.type === 'condition')?.fields.test)
    assert.deepEqual(prepareWorkflow(schema.example, { roles: schema.roles }).errors, [])
  })

  it('заполняет координаты, сохраняя заданные координаты, id и исходный объект', () => {
    const raw = graph()
    Object.assign(raw.nodes[1], { x: 777, y: 888 })
    const before = JSON.stringify(raw)
    const result = prepareWorkflow(raw, { roles: DEFAULT_ROLES })
    assert.deepEqual(result.errors, [])
    assert.equal(result.workflow?.nodes[1].x, 777)
    assert.equal(result.workflow?.nodes[1].y, 888)
    assert.deepEqual(result.workflow?.nodes.map((n) => n.id), ['s', 'w', 'e'])
    assert.ok(result.workflow?.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
    assert.equal(JSON.stringify(raw), before)
  })

  it('проверяет вложенный путь и расставляет его независимо от внешнего графа', () => {
    const raw = graph()
    const inner = graph()
    Object.assign(raw.nodes[1], { subflow: { nodes: inner.nodes, edges: inner.edges } })
    const result = prepareWorkflow(raw, { roles: DEFAULT_ROLES })
    assert.deepEqual(result.errors, [])
    const work = result.workflow?.nodes.find((n) => n.type === 'work')
    assert.ok(work?.type === 'work' && work.subflow)
    assert.ok(work.subflow.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
  })

  it('возвращает структурированные ошибки сырой формы, включая вложенные ноды и condition.test', () => {
    const malformed = [null, { ...graph(), nodes: [null] },
      { ...graph(), nodes: [{ id: 'c', type: 'condition' }] },
      { ...graph(), nodes: [{ id: 'w', type: 'work', subflow: { nodes: [{ id: 5, type: 'start' }], edges: [] } }] },
      { ...graph(), nodes: [{ id: 'w', type: 'work', x: Number.NaN }] }]
    for (const raw of malformed) {
      const result = prepareWorkflow(raw, { roles: DEFAULT_ROLES })
      assert.ok(result.errors.length, JSON.stringify(raw))
      assert.ok(result.errors[0].code)
      assert.ok(result.errors[0].message)
      assert.equal(result.workflow, undefined)
    }
  })

  it('семантический валидатор сохраняет коды портов и предупреждения', () => {
    const raw = graph()
    raw.edges.pop()
    const result = prepareWorkflow(raw, { roles: DEFAULT_ROLES })
    assert.ok(result.errors.some((e) => e.code === 'missingOutcome' && e.nodeId === 'w'))
    const valid = prepareWorkflow(graph(), { roles: DEFAULT_ROLES })
    assert.ok(valid.warnings.length, 'граф без проверки человеком предупреждает, но сохраняется')
  })

  it('version NaN, Infinity, zero и дробь не превращаются в валидный v2 при миграции', () => {
    for (const version of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      const result = prepareWorkflow({ ...graph(), version }, { roles: DEFAULT_ROLES })
      assert.ok(result.errors.length, String(version))
    }
  })

  it('неправильные типы options и test.roleIds возвращают ошибки без TypeError', () => {
    for (const node of [
      { id: 'd', type: 'decision', question: 15, roleId: 'developer', options: [null] },
      { id: 'd', type: 'decision', question: 'Что делать?', roleId: 'developer', options: [{ id: 7, label: 'Да' }] },
      { id: 'c', type: 'condition', test: { kind: 'role', roleIds: null } },
      { id: 'c', type: 'condition', test: [] }
    ]) {
      const result = prepareWorkflow({ ...graph(), nodes: [node] }, { roles: DEFAULT_ROLES })
      assert.equal(result.errors[0].code, 'invalidDefinition')
    }
  })

  it('полный fork/join раскладывается рядами, join правее длинного пути', () => {
    const result = prepareWorkflow({ version: 2,
      nodes: [{ id: 's', type: 'start' }, { id: 'f', type: 'fork', branches: [{ id: 'left', label: 'Первый' }, { id: 'right', label: 'Второй' }] },
        { id: 'a', type: 'work' }, { id: 'b', type: 'work' }, { id: 'c', type: 'work' }, { id: 'j', type: 'join', forkId: 'f' }, { id: 'e', type: 'end' }],
      edges: [{ id: 'sf', from: 's', outcome: 'next', to: 'f' }, { id: 'fa', from: 'f', outcome: 'left', to: 'a' }, { id: 'fb', from: 'f', outcome: 'right', to: 'b' },
        { id: 'aj', from: 'a', outcome: 'next', to: 'j' }, { id: 'bc', from: 'b', outcome: 'next', to: 'c' }, { id: 'cj', from: 'c', outcome: 'next', to: 'j' }, { id: 'je', from: 'j', outcome: 'next', to: 'e' }]
    }, { roles: DEFAULT_ROLES })
    assert.deepEqual(result.errors, [])
    const nodes = new Map(result.workflow!.nodes.map((node) => [node.id, node]))
    assert.ok(nodes.get('b')!.y > nodes.get('a')!.y)
    assert.equal(nodes.get('c')!.y, nodes.get('b')!.y)
    assert.ok(nodes.get('j')!.x > nodes.get('c')!.x)
    assert.ok(result.workflow!.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))
  })

  it('неизвестные типы из Object.prototype дают structured errors во внешнем и вложенном графе', () => {
    for (const type of ['__proto__', 'constructor', 'toString']) {
      const invalid = { version: 2,
        nodes: [{ id: 's', type: 'start' }, { id: 'bad', type }, { id: 'w', type: 'work' }, { id: 'e', type: 'end' }],
        edges: [{ id: 'sb', from: 's', outcome: 'next', to: 'bad' }, { id: 'bw', from: 'bad', outcome: 'next', to: 'w' },
          { id: 'be', from: 'bad', outcome: 'other', to: 'e' }, { id: 'we', from: 'w', outcome: 'next', to: 'e' }] }
      for (const nested of [false, true]) {
        const raw = nested ? { ...graph(), nodes: [{ id: 's', type: 'start' },
          { id: 'w', type: 'work', subflow: { nodes: invalid.nodes, edges: invalid.edges } }, { id: 'e', type: 'end' }] } : invalid
        const result = prepareWorkflow(raw, { roles: DEFAULT_ROLES })
        assert.ok(result.errors.some((issue) => issue.code === 'nodeUnknownType'), `${type}, nested=${nested}`)
      }
    }
  })
})
