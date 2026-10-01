import { DEFAULT_ROLES, type Role } from './types.ts'
import {
  WORKFLOW_VERSION, WF_PORTS, defaultWorkflow, migrateWorkflow, validateWorkflow,
  type WfIssue, type WfNode, type WfNodeType, type WfValidationContext, type Workflow
} from './workflow.ts'
import { autoLayout } from './workflow-layout.ts'

/** Контекст сохранённого библиотечного типа; флаги запуска ролей сюда не входят. */
export interface WorkflowTypeContext {
  typeId: string
  title: string
  workflow: Workflow
  roles: Omit<Role, 'extraArgs'>[]
  custom: boolean
  revision: string
}

/** Узкое уведомление о результате: содержимое графа и настройки агентов не рассылаются. */
export interface WorkflowAssistantSaved {
  typeId: string
  title: string
  revision: string
}

/** Ошибка формы JSON до вызова семантического валидатора. */
export interface WorkflowDefinitionIssue {
  code: 'invalidDefinition'
  message: string
  path: string
  nodeId?: string
  edgeId?: string
}

export interface WorkflowPreparation {
  workflow?: Workflow
  errors: (WfIssue | WorkflowDefinitionIssue)[]
  warnings: WfIssue[]
}

export interface WorkflowSaveResult extends WorkflowTypeContext {
  warnings: WfIssue[]
}

export interface WorkflowCreateInput {
  title: string
  description?: string
  baseTypeId?: string
  definition: unknown
}

export interface WorkflowRoleSelection {
  typeId?: string
  baseTypeId?: string
}

export interface WorkflowSchema {
  version: number
  fields: Record<string, string>
  nodeFields: Record<string, string>
  edgeFields: Record<string, string>
  nodeTypes: { type: WfNodeType; ports: readonly string[]; fields: Record<string, string> }[]
  roles: Omit<Role, 'extraArgs'>[]
  rules: string[]
  example: Workflow
}

/** Машиночитаемая памятка модели: реальные поля и роли позволяют создать граф даже до первого проекта. */
export function workflowSchema(): WorkflowSchema {
  const fields: Record<WfNodeType, Record<string, string>> = {
    start: {}, end: { merged: 'boolean, optional' },
    work: { roleIds: 'string[], optional; no roles means coordinator chooses working roles', instructions: 'string, optional',
      showcase: '{what:string, required?:boolean}, optional', subflow: '{nodes:WfNode[], edges:WfEdge[]}, optional', runOnly: 'boolean, optional; run scope only' },
    ask: { roleId: 'string, required', instructions: 'non-empty string, required' },
    gate: { roleId: 'string, required', instructions: 'string, optional' },
    human: { instructions: 'string, optional' },
    decision: { roleId: 'string, required', question: 'non-empty string, required',
      options: '{id:string matching /^[a-z0-9][a-z0-9_-]{0,31}$/, label:string, description?:string}[], 2–8 options; ids are output ports', instructions: 'string, optional' },
    condition: { test: "{kind:'attempts', node:string, atLeast:integer>=1} | {kind:'role', roleIds:string[]} (subtask only); {kind:'files',glob:string} is unsupported" },
    merge: {},
    git: { operation: "'commit' | 'push' in run scope; 'create_branch' | 'checkout' also allowed in subtask scope", message: 'string; required for commit; placeholders {taskId}, {slug}, {title}',
      remote: 'string, optional for push; default origin', branch: 'string, required for create_branch/checkout; placeholders {taskId}, {slug}', base: 'string, optional for create_branch' },
    fork: { branches: '{id:string matching /^[a-z0-9][a-z0-9_-]{0,31}$/, label:string}[], 2–4 branches; ids are output ports' },
    join: { forkId: 'string, required; id of paired fork' }
  }
  return {
    version: WORKFLOW_VERSION,
    fields: { version: 'integer, current version 2', nodes: 'WfNode[]', edges: 'WfEdge[]' },
    nodeFields: { id: 'unique non-empty string; preserve existing ids', type: 'node type', x: 'finite number, optional; generated if omitted',
      y: 'finite number, optional; generated if omitted', title: 'string, optional', column: 'string, optional; shared across projects', templateId: 'string, optional; local template reference' },
    edgeFields: { id: 'unique non-empty string', from: 'source node id', outcome: 'source output port id', to: 'target node id' },
    nodeTypes: (Object.keys(WF_PORTS) as WfNodeType[]).map((type) => ({ type, ports: [...WF_PORTS[type]], fields: fields[type] })),
    roles: DEFAULT_ROLES.map(({ extraArgs: _private, ...role }) => ({ ...role })),
    rules: [
      'Exactly one start, at least one reachable work and end. Each output port has exactly one edge.',
      'Role references must use existing working roles; coordinator and assistant are service roles.',
      'Subflow belongs to work only; no nested subflow, ask, decision, fork or join inside subflow.',
      'Fork paths converge in their paired join; no nested forks or crossing paths.',
      'Preserve ids and existing coordinates when editing. Missing coordinates are laid out automatically.',
      'Saving changes the global type library for new runs; existing runs retain their graph snapshots.'
    ],
    example: defaultWorkflow(DEFAULT_ROLES)
  }
}

export class WorkflowDefinitionError extends Error {
  readonly issue: WorkflowDefinitionIssue
  constructor(path: string, reason: string, at: { nodeId?: string; edgeId?: string } = {}) {
    super(`воркфлоу: ${path} — ${reason}`)
    this.issue = { code: 'invalidDefinition', message: this.message, path, ...at }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Разбор данных без доверия к TypeScript-типу. Рекурсивная форма проверяется до миграции и validateWorkflow,
 * иначе condition.test или нода вложенного пути могут упасть на доступе к полям вместо понятной ошибки.
 */
export function parseWorkflowDefinition(value: unknown, allowMissingCoordinates = false): Workflow {
  const fail = (path: string, reason: string, at: { nodeId?: string; edgeId?: string } = {}): never => {
    throw new WorkflowDefinitionError(path, reason, at)
  }
  const text = (v: unknown, path: string, required = false): void => {
    if ((required || v !== undefined) && typeof v !== 'string') fail(path, 'должно быть строкой')
  }
  const strings = (v: unknown, path: string): void => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) fail(path, 'должно быть массивом строк')
  }
  const path = (v: unknown, name: string, depth: number): void => {
    if (!object(v)) return fail(name, 'ожидается объект')
    if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) return fail(name, 'nodes и edges должны быть массивами')
    for (const [i, raw] of v.nodes.entries()) {
      const nameNode = `${name}.nodes[${i}]`
      if (!object(raw)) fail(nameNode, 'нода должна быть объектом')
      const n = raw as Record<string, unknown>
      text(n.id, `${nameNode}.id`, true)
      text(n.type, `${nameNode}.type`, true)
      const at = { nodeId: String(n.id) }
      for (const key of ['x', 'y']) {
        if (n[key] === undefined && allowMissingCoordinates) continue
        if (typeof n[key] !== 'number' || !Number.isFinite(n[key])) fail(`${nameNode}.${key}`, 'координаты должны быть числами', at)
      }
      for (const key of ['title', 'column', 'templateId', 'roleId', 'instructions', 'question', 'forkId', 'operation', 'branch', 'base', 'message', 'remote']) text(n[key], `${nameNode}.${key}`)
      for (const key of ['runOnly', 'merged']) if (n[key] !== undefined && typeof n[key] !== 'boolean') fail(`${nameNode}.${key}`, 'должно быть boolean', at)
      if (n.roleIds !== undefined) strings(n.roleIds, `${nameNode}.roleIds`)
      if (n.type === 'condition') {
        if (!object(n.test)) fail(`${nameNode}.test`, 'ожидается объект условия', at)
        const test = n.test as Record<string, unknown>
        text(test.kind, `${nameNode}.test.kind`, true)
        if (test.kind === 'attempts') {
          text(test.node, `${nameNode}.test.node`, true)
          if (typeof test.atLeast !== 'number') fail(`${nameNode}.test.atLeast`, 'должно быть числом', at)
        }
        if (test.kind === 'role') strings(test.roleIds, `${nameNode}.test.roleIds`)
        if (test.kind === 'files') text(test.glob, `${nameNode}.test.glob`, true)
      }
      for (const key of ['options', 'branches']) {
        if (n[key] === undefined) continue
        if (!Array.isArray(n[key])) fail(`${nameNode}.${key}`, 'ожидается массив', at)
        for (const [j, entry] of (n[key] as unknown[]).entries()) {
          if (!object(entry)) fail(`${nameNode}.${key}[${j}]`, 'ожидается объект', at)
          for (const field of ['id', 'label', 'description']) text((entry as Record<string, unknown>)[field], `${nameNode}.${key}[${j}].${field}`)
        }
      }
      if (n.showcase !== undefined) {
        if (!object(n.showcase)) fail(`${nameNode}.showcase`, 'ожидается объект', at)
        const showcase = n.showcase as Record<string, unknown>
        text(showcase.what, `${nameNode}.showcase.what`, true)
        if (showcase.required !== undefined && typeof showcase.required !== 'boolean') fail(`${nameNode}.showcase.required`, 'должно быть boolean', at)
      }
      if (n.subflow !== undefined) {
        if (depth >= 1) fail(`${nameNode}.subflow`, 'вложенный путь подзадачи запрещён', at)
        path(n.subflow, `${nameNode}.subflow`, depth + 1)
      }
    }
    for (const [i, raw] of v.edges.entries()) {
      const nameEdge = `${name}.edges[${i}]`
      if (!object(raw)) fail(nameEdge, 'переход должен быть объектом')
      for (const key of ['id', 'from', 'to', 'outcome']) text((raw as Record<string, unknown>)[key], `${nameEdge}.${key}`, true)
    }
  }
  if (!object(value)) return fail('workflow', 'ожидается объект')
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    fail('workflow.version', 'номер версии формата должен быть положительным целым числом')
  }
  path(value, 'workflow', 0)
  return JSON.parse(JSON.stringify(value)) as Workflow
}

/** Координаты не влияют на семантику: раскладка заполняет только пропуски, включая пути подзадач. */
function fillCoordinates(workflow: Workflow): Workflow {
  const layout = autoLayout(workflow)
  return {
    ...workflow,
    nodes: workflow.nodes.map((node, i): WfNode => {
      const next = { ...node, x: node.x ?? layout.nodes[i].x, y: node.y ?? layout.nodes[i].y }
      if (next.type === 'work' && next.subflow) {
        const inner = fillCoordinates({ version: WORKFLOW_VERSION, ...next.subflow })
        next.subflow = { nodes: inner.nodes, edges: inner.edges }
      }
      return next
    })
  }
}

/** Подготовка черновика не мутирует ввод и никогда не пишет состояние. Ошибки не скрываются исключением валидатора. */
export function prepareWorkflow(definition: unknown, context: WfValidationContext): WorkflowPreparation {
  try {
    const workflow = migrateWorkflow(parseWorkflowDefinition(definition, true), context.roles)
    const issues = validateWorkflow(workflow, context)
    // Раскладка рассчитана на известные типы и порты; ошибки семантики должны остаться диагностикой.
    return { workflow: issues.errors.length ? workflow : fillCoordinates(workflow), ...issues }
  } catch (error) {
    if (error instanceof WorkflowDefinitionError) return { errors: [error.issue], warnings: [] }
    throw error
  }
}
