import { WF_PORTS, type WfEdge, type WfIssue, type WfNode, type WfNodeType, type WfOutcome, type Workflow } from '@orca-board/core'
import { t } from './i18n'
import { wfIssueText } from './defaultTitles'

// Правка графа воркфлоу в редакторе — чистые функции: на вход граф, на выход новый граф (исходный не меняется).
// Недопустимая операция возвращает граф как есть: холст и инспектор не обязаны проверять её заранее.
// Смысловые ошибки (нет перехода, нет роли) не запрещаются здесь — их показывает validateWorkflow.

/** Что выделено на холсте. */
export type WfSelection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null

/** Подписи исходов на портах и в инспекторе. Геттеры — чтобы подпись шла на текущем языке интерфейса. */
export const WF_OUTCOME_LABELS: Readonly<Record<WfOutcome, string>> = {
  get next() { return t('config.wf.outcome.next') },
  get accept() { return t('config.wf.outcome.accept') },
  get reject() { return t('config.wf.outcome.reject') },
  get yes() { return t('config.wf.outcome.yes') },
  get no() { return t('config.wf.outcome.no') },
  get ok() { return t('config.wf.outcome.ok') },
  get conflict() { return t('config.wf.outcome.conflict') },
  get error() { return t('config.wf.outcome.error') }
}

/**
 * Подпись исхода у ноды типа `type`. Общий `ok` — «слито» (мерж), а у ноды `git` это «выполнено»: слияния там нет.
 */
export function wfOutcomeLabel(type: WfNodeType, outcome: WfOutcome): string {
  if (type === 'git' && outcome === 'ok') return t('config.wf.outcome.gitOk')
  return WF_OUTCOME_LABELS[outcome]
}

/** Типы нод, которые можно добавить из палитры (в порядке показа). */
export const WF_ADDABLE_TYPES: readonly WfNodeType[] = ['work', 'ask', 'gate', 'human', 'condition', 'merge', 'git', 'end', 'start']

/**
 * Типы нод, недоступные в пути подзадачи: вопросы человеку задаёт этап глобальной задачи, а не каждая подзадача
 * (валидатор: `subflowAskNotAllowed`).
 */
export const WF_SUBTASK_FORBIDDEN_TYPES: readonly WfNodeType[] = ['ask']

/** Палитра холста по области: в пути подзадачи (`'subtask'`) без запрещённых там типов. */
export function wfAddableTypes(scope: 'run' | 'subtask'): readonly WfNodeType[] {
  return scope === 'subtask' ? WF_ADDABLE_TYPES.filter((type) => !WF_SUBTASK_FORBIDDEN_TYPES.includes(type)) : WF_ADDABLE_TYPES
}

/** Свободный id вида `<prefix>`, `<prefix>_2`, `<prefix>_3`… */
export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(prefix)) return prefix
  for (let i = 2; ; i++) if (!used.has(`${prefix}_${i}`)) return `${prefix}_${i}`
}

/**
 * Новая нода типа `type` с незаполненными полями. Гейт — без роли, условие — лимит повторов первой работы
 * графа: пустое поле сразу подсветит валидация, а инспектор предложит выбрать.
 */
export function makeNode(wf: Workflow, type: WfNodeType, x: number, y: number): WfNode {
  const id = uniqueId(type, wf.nodes.map((n) => n.id))
  const pos = { id, x, y }
  switch (type) {
    case 'gate':
      return { ...pos, type, roleId: '' }
    case 'ask':
      return { ...pos, type, instructions: '' }
    case 'condition': {
      const work = wf.nodes.find((n) => n.type === 'work')
      return { ...pos, type, test: { kind: 'attempts', node: work?.id ?? '', atLeast: 3 } }
    }
    case 'git':
      return { ...pos, type, operation: 'commit', message: '' }
    case 'end':
      return { ...pos, type, merged: false }
    default:
      return { ...pos, type }
  }
}

export function addNode(wf: Workflow, type: WfNodeType, x: number, y: number): { workflow: Workflow; nodeId: string } {
  const node = makeNode(wf, type, x, y)
  return { workflow: { ...wf, nodes: [...wf.nodes, node] }, nodeId: node.id }
}

/** Удаляет ноду вместе со всеми входящими и исходящими рёбрами. */
export function removeNode(wf: Workflow, nodeId: string): Workflow {
  if (!wf.nodes.some((n) => n.id === nodeId)) return wf
  return {
    ...wf,
    nodes: wf.nodes.filter((n) => n.id !== nodeId),
    edges: wf.edges.filter((e) => e.from !== nodeId && e.to !== nodeId)
  }
}

export function moveNode(wf: Workflow, nodeId: string, x: number, y: number): Workflow {
  const node = wf.nodes.find((n) => n.id === nodeId)
  if (!node || (node.x === x && node.y === y)) return wf
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)) }
}

/** Можно ли провести ребро: порт есть у типа источника, обе ноды существуют, цель — не старт. */
export function canConnect(wf: Workflow, from: string, outcome: WfOutcome, to: string): boolean {
  const src = wf.nodes.find((n) => n.id === from)
  const dst = wf.nodes.find((n) => n.id === to)
  return !!src && !!dst && WF_PORTS[src.type].includes(outcome) && dst.type !== 'start'
}

/**
 * Проводит ребро `from --outcome--> to`. У порта ровно одно ребро, поэтому прежнее ребро этого порта
 * заменяется (его id сохраняется — выделение на нём не пропадает). Возврат в себя разрешён: это законная
 * петля «вернуть на доработку».
 */
export function connect(wf: Workflow, from: string, outcome: WfOutcome, to: string): { workflow: Workflow; edgeId?: string } {
  if (!canConnect(wf, from, outcome, to)) return { workflow: wf }
  const old = wf.edges.filter((e) => e.from === from && e.outcome === outcome)
  const id = old[0]?.id ?? uniqueId(`e_${from}_${outcome}`, wf.edges.map((e) => e.id))
  const edge: WfEdge = { id, from, outcome, to }
  const rest = wf.edges.filter((e) => !(e.from === from && e.outcome === outcome))
  if (old.length === 1 && old[0].to === to) return { workflow: wf, edgeId: id }
  return { workflow: { ...wf, edges: [...rest, edge] }, edgeId: id }
}

export function disconnect(wf: Workflow, edgeId: string): Workflow {
  if (!wf.edges.some((e) => e.id === edgeId)) return wf
  return { ...wf, edges: wf.edges.filter((e) => e.id !== edgeId) }
}

/** Удаление выделенного (клавиша Delete). */
export function removeSelected(wf: Workflow, sel: WfSelection): Workflow {
  if (!sel) return wf
  return sel.kind === 'node' ? removeNode(wf, sel.id) : disconnect(wf, sel.id)
}

export type IssueLevel = 'error' | 'warning'

/** Проблемы по нодам и рёбрам для подсветки: уровень (ошибка важнее предупреждения) и тексты для подсказки. */
export interface IssueTargets {
  nodes: Map<string, { level: IssueLevel; messages: string[] }>
  edges: Map<string, { level: IssueLevel; messages: string[] }>
}

export function issueTargets(issues: { errors: readonly WfIssue[]; warnings: readonly WfIssue[] } | undefined): IssueTargets {
  const res: IssueTargets = { nodes: new Map(), edges: new Map() }
  if (!issues) return res
  const add = (map: IssueTargets['nodes'], id: string, level: IssueLevel, message: string): void => {
    const cur = map.get(id)
    if (!cur) map.set(id, { level, messages: [message] })
    else {
      cur.messages.push(message)
      if (level === 'error') cur.level = 'error'
    }
  }
  for (const [level, list] of [['error', issues.errors], ['warning', issues.warnings]] as const) {
    for (const i of list) {
      const text = wfIssueText(i)
      if (i.nodeId) add(res.nodes, i.nodeId, level, text)
      if (i.edgeId) add(res.edges, i.edgeId, level, text)
    }
  }
  return res
}
