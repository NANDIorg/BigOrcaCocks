import { wfPorts, type WfDecisionOption, type WfEdge, type WfIssue, type WfNode, type WfNodeType, type WfOutcome, type WfPort, type Workflow } from '@orca-board/core'
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
export function wfOutcomeLabel(type: WfNodeType, outcome: WfPort): string {
  if (type === 'git' && outcome === 'ok') return t('config.wf.outcome.gitOk')
  // Порт ноды `decision` — id варианта: фиксированной подписи у него нет, подпись — метка варианта в самой ноде.
  return outcome in WF_OUTCOME_LABELS ? WF_OUTCOME_LABELS[outcome as WfOutcome] : outcome
}

/**
 * Подпись порта конкретной ноды: у `decision` — метка варианта (пустая — id, чтобы порт не остался без подписи),
 * у остальных — `wfOutcomeLabel` по типу.
 */
export function wfPortLabel(node: WfNode, port: WfPort): string {
  if (node.type === 'decision') {
    const option = Array.isArray(node.options) ? node.options.find((o) => o.id === port) : undefined
    return option?.label.trim() || port
  }
  return wfOutcomeLabel(node.type, port)
}

/**
 * Суффикс CSS-класса порта и ребра (`wf-port--…`, `wf-edge--…`): у фиксированных портов — сам исход (цвет accept/reject),
 * у вариантов `decision` — общий `opt`: id варианта — данные графа, класс по нему был бы мусорным.
 */
export function wfPortClass(type: WfNodeType, port: WfPort): string {
  return type === 'decision' ? 'opt' : port
}

/** «да» → «Да»: метка варианта — данные графа, а подписи исходов в словаре — со строчной буквы. */
const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Пресет вариантов «Да / Нет» ноды `decision`. id — `yes`/`no`, как порты `condition`: смена типа
 * `condition ↔ decision` сохраняет рёбра. Метки — на языке интерфейса в момент создания (дальше это данные графа).
 */
export function yesNoOptions(): WfDecisionOption[] {
  return [
    { id: 'yes', label: capitalized(t('config.wf.outcome.yes')) },
    { id: 'no', label: capitalized(t('config.wf.outcome.no')) }
  ]
}

/** Типы нод, которые можно добавить из палитры (в порядке показа). */
export const WF_ADDABLE_TYPES: readonly WfNodeType[] = ['work', 'ask', 'gate', 'decision', 'human', 'condition', 'merge', 'git', 'end', 'start']

/**
 * Типы нод, недоступные в пути подзадачи: вопросы человеку и развилки «Решение ИИ» — этапы глобальной задачи, а не
 * каждой подзадачи (валидатор: `subflowAskNotAllowed`, `subflowDecisionNotAllowed`).
 */
export const WF_SUBTASK_FORBIDDEN_TYPES: readonly WfNodeType[] = ['ask', 'decision']

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
 * графа, решение ИИ — без вопроса и роли, с вариантами «Да / Нет»: пустое поле сразу подсветит валидация, а инспектор предложит выбрать.
 */
export function makeNode(wf: Workflow, type: WfNodeType, x: number, y: number): WfNode {
  const id = uniqueId(type, wf.nodes.map((n) => n.id))
  const pos = { id, x, y }
  switch (type) {
    case 'gate':
      return { ...pos, type, roleId: '' }
    case 'ask':
      return { ...pos, type, instructions: '' }
    case 'decision':
      // Вопрос и роль задаются в инспекторе (пустые подсветит валидация), варианты — сразу «Да / Нет».
      return { ...pos, type, question: '', roleId: '', options: yesNoOptions() }
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

/** Можно ли провести ребро: порт есть у источника, обе ноды существуют, цель — не старт. */
export function canConnect(wf: Workflow, from: string, outcome: WfPort, to: string): boolean {
  const src = wf.nodes.find((n) => n.id === from)
  const dst = wf.nodes.find((n) => n.id === to)
  return !!src && !!dst && wfPorts(src).includes(outcome) && dst.type !== 'start'
}

/**
 * Проводит ребро `from --outcome--> to`. У порта ровно одно ребро, поэтому прежнее ребро этого порта
 * заменяется (его id сохраняется — выделение на нём не пропадает). Возврат в себя разрешён: это законная
 * петля «вернуть на доработку».
 */
export function connect(wf: Workflow, from: string, outcome: WfPort, to: string): { workflow: Workflow; edgeId?: string } {
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
