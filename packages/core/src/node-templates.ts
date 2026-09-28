// Шаблоны нод: глобальная библиотека настроенных нод (`projects.json → nodeTemplates`), которые человек вставляет
// в графы любых типов задач. Вставка — копия ноды с `templateId`, а не ссылка: снимок графа прогона (`Run.workflow`)
// остаётся самодостаточным. Модуль импортирует renderer — без node-импортов, значения с расширением .ts.
import { WF_ISSUE_TEXTS, WF_PORTS, WORKFLOW_VERSION, validateWorkflow, wfPorts, wfWorkRoleIds } from './workflow.ts'
import type { WfEdge, WfIssue, WfIssueCode, WfNode, WfValidation, WfValidationContext, Workflow } from './workflow.ts'

/** `Omit` по каждой ветке объединения: обычный `Omit` схлопнул бы `WfNode` до общих полей. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Нода шаблона: как `WfNode`, но без id и позиции — их задаёт вставка. */
export type WfTemplateNode = DistributiveOmit<WfNode, 'id' | 'x' | 'y'>

/**
 * Именованная настроенная нода: тип, роли, инструкции, показ и (у `work`) путь подзадачи. Шаблоном может быть любая
 * нода, кроме `start`. Версий нет: вставка — копия, `updatedAt` нужен редактору, чтобы подсказать «шаблон изменился».
 */
export interface WfNodeTemplate {
  id: string
  title: string
  description?: string
  node: WfTemplateNode
  updatedAt: number
}

/** Id ноды-образца в графе, на котором шаблон проверяется. */
const SAMPLE_ID = 'template'

/**
 * Проблемы, которые у ноды в шаблоне не проблемы: роли и колонки берутся из типа задачи при вставке, ссылки условия
 * `attempts` и «человек после показа» зависят от графа, в который шаблон попадёт. Все варианты `decision` в образце
 * ведут в конец — куда они поведут на самом деле, решает граф.
 */
const TEMPLATE_IGNORED: readonly WfIssueCode[] = ['attemptsNoNode', 'showcaseUnseen', 'noHumanBeforeEnd', 'unreachable', 'endlessLoop', 'subflowDoubleReview', 'decisionSameTarget']

/** Роли, которые называет нода (и её путь подзадачи): проверка ролей против типа — при вставке. */
function referencedRoles(node: WfTemplateNode): string[] {
  const own: string[] = node.type === 'work' ? wfWorkRoleIds(node) : node.type === 'gate' || node.type === 'ask' || node.type === 'decision' ? (typeof node.roleId === 'string' && node.roleId ? [node.roleId] : []) : []
  const path = node.type === 'work' ? (node.subflow as { nodes?: unknown } | undefined)?.nodes : undefined
  const inner = Array.isArray(path)
    ? path.flatMap((n: unknown) => (n && typeof n === 'object' ? referencedRoles(n as WfTemplateNode) : []))
    : []
  return [...own, ...inner]
}

/**
 * Проверка шаблона перед сохранением. Приходит из файла или UI, поэтому поля читаются без доверия к типам. Сама нода
 * проверяется в образце графа «старт → нода → конец» тем же `validateWorkflow` (в том числе путь подзадачи); роли — не
 * против ролей проекта, а только на служебность, колонки и ссылки на другие ноды — при вставке. `scope` — куда
 * шаблон вставляют: в граф глобальной задачи (`'run'`, по умолчанию) или в путь подзадачи (`'subtask'`, там нет `ask`
 * и вложенного пути). `nodeTitle` — как в `WfValidationContext`.
 */
export function validateNodeTemplate(
  template: WfNodeTemplate,
  ctx: Pick<WfValidationContext, 'nodeTitle' | 'scope'> = {}
): WfValidation {
  const errors: WfIssue[] = []
  const warnings: WfIssue[] = []
  const t = template as Partial<Record<keyof WfNodeTemplate, unknown>> | null
  const raw = t && typeof t === 'object' ? t : {}
  const name = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : typeof raw.id === 'string' ? raw.id : ''
  const known = (code: WfIssueCode, params: Record<string, string | number> = {}): WfIssue => ({
    message: WF_ISSUE_TEXTS[code].replace(/\{(\w+)\}/g, (all, k: string) => (k in params ? String(params[k]) : all)),
    code,
    ...(Object.keys(params).length ? { params } : {})
  })

  if (typeof raw.id !== 'string' || !raw.id.trim()) errors.push(known('templateNoId'))
  if (typeof raw.title !== 'string' || !raw.title.trim()) errors.push(known('templateNoTitle'))
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push(known('templateNotString', { template: name, field: 'description' }))
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) errors.push(known('templateBadUpdatedAt', { template: name }))

  const node = raw.node as (Partial<WfTemplateNode> & { type?: unknown }) | null | undefined
  if (!node || typeof node !== 'object' || typeof node.type !== 'string' || !(node.type in WF_PORTS)) {
    errors.push(known('templateBadNode', { template: name }))
    return { errors, warnings }
  }
  if (node.type === 'start') {
    errors.push(known('templateNodeStart', { template: name }))
    return { errors, warnings }
  }

  const sample = { ...(node as WfTemplateNode), id: SAMPLE_ID, x: 0, y: 0 } as WfNode
  // У `decision` порты — id вариантов: ребро на каждый, иначе образец дал бы «нет перехода» вместо ошибок самой ноды.
  const ports = [...new Set(wfPorts(sample))]
  const wf: Workflow = {
    version: WORKFLOW_VERSION,
    nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, sample, { id: 'end', type: 'end', x: 0, y: 0 }],
    edges: [
      { id: 'e_start', from: 'start', outcome: 'next', to: SAMPLE_ID },
      ...ports.map((outcome, i): WfEdge => ({ id: `e_${i}`, from: SAMPLE_ID, outcome, to: 'end' }))
    ]
  }
  // Нода-образец не имеет пути в конец, если она сама — конец; остальным конец достижим из любого порта.
  if (sample.type === 'end') wf.edges = [{ id: 'e_start', from: 'start', outcome: 'next', to: SAMPLE_ID }]
  const roles = [...new Set(referencedRoles(node as WfTemplateNode))].map((id) => ({ id, title: id, agent: 'claude' as const }))
  const result = validateWorkflow(wf, { roles, ...(ctx.nodeTitle ? { nodeTitle: ctx.nodeTitle } : {}), ...(ctx.scope ? { scope: ctx.scope } : {}) })
  const mine = (i: WfIssue): boolean => i.nodeId === SAMPLE_ID || i.nodeId?.startsWith(`${SAMPLE_ID}/`) === true
  const keep = (i: WfIssue): boolean => mine(i) && !(i.code && TEMPLATE_IGNORED.includes(i.code))
  errors.push(...result.errors.filter(keep))
  warnings.push(...result.warnings.filter(keep))
  return { errors, warnings }
}
