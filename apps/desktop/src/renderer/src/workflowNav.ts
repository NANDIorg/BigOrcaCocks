import {
  WF_PORTS, WORKFLOW_VERSION, defaultSubflow,
  type WfEdge, type WfIssue, type WfNode, type WfSubflow, type WfValidation, type Workflow
} from '@orca-board/core'
import { t } from './i18n'
import { nodeTitle } from './defaultTitles'

// Вход в ноду «Работа» и путь подзадачи в редакторе воркфлоу — чистые функции. Хост (`TaskTypeWorkflow`) хранит один
// граф типа и стек `WfPath` из id нод «Работа»: `[]` — граф типа, `['impl']` — путь подзадачи ноды `impl`. Правки
// пути записываются обратно в `work.subflow` этой ноды, так что наружу, в сохранение и валидацию, уходит один граф.
// Глубина ровно 1 (у ноды пути своего пути нет), но код от глубины не зависит: её ограничивает `canOpenPath`.

/** Путь входа: id нод «Работа» от графа типа вглубь. Пустой — сам граф типа. */
export type WfPath = readonly string[]

/** Что редактирует холст: граф типа (`'run'`) или путь подзадачи (`'subtask'`). Сужает палитру и инспектор. */
export type WfScope = 'run' | 'subtask'

export const scopeOf = (path: WfPath): WfScope => (path.length === 0 ? 'run' : 'subtask')

/** Максимальная глубина входа: путь подзадачи, но не путь внутри пути. */
export const MAX_PATH_DEPTH = 1

/** Граф в виде, который понимают холст и валидатор: у пути нет своей версии, берём версию внешнего графа. */
function asWorkflow(sub: WfSubflow): Workflow {
  return { version: WORKFLOW_VERSION, nodes: sub.nodes, edges: sub.edges }
}

/** Путь подзадачи из файла приходит без гарантий: годится только объект с массивами nodes и edges. */
function isSubflow(raw: unknown): raw is WfSubflow {
  const s = raw as { nodes?: unknown; edges?: unknown } | null | undefined
  return !!s && typeof s === 'object' && Array.isArray(s.nodes) && Array.isArray(s.edges)
}

type WorkNode = Extract<WfNode, { type: 'work' }>

const workNode = (wf: Workflow, id: string): WorkNode | undefined => {
  const n = wf.nodes.find((x) => x.id === id)
  return n?.type === 'work' ? n : undefined
}

/** У ноды «Работа» свой путь подзадачи (не путь по умолчанию). */
export function hasCustomSubflow(node: WfNode): boolean {
  return node.type === 'work' && node.subflow !== undefined
}

/**
 * Можно ли войти в ноду: только «Работа» и только из графа типа. Внутри пути вложенного пути нет —
 * ни двойной клик, ни кнопка инспектора ничего не открывают.
 */
export function canOpenPath(wf: Workflow, path: WfPath, nodeId: string): boolean {
  return path.length < MAX_PATH_DEPTH && workNode(wf, nodeId) !== undefined
}

/**
 * Граф, который сейчас показывает холст. `isDefault` — у ноды нет своего пути, показан образец `defaultSubflow()`:
 * править его нельзя, пока человек не заведёт свой. `undefined` — путь ведёт в никуда (нода удалена, тип сменили).
 */
export function graphAt(root: Workflow, path: WfPath): { graph: Workflow; isDefault: boolean } | undefined {
  let cur = root
  let isDefault = false
  for (const id of path) {
    const node = workNode(cur, id)
    if (!node) return undefined
    isDefault = !isSubflow(node.subflow)
    cur = asWorkflow(isSubflow(node.subflow) ? node.subflow : defaultSubflow())
  }
  return { graph: cur, isDefault }
}

/** Самая длинная правильная часть пути: после замены графа целиком (импорт, сброс) вход мог потерять смысл. */
export function resolvePath(root: Workflow, path: WfPath): string[] {
  const res: string[] = []
  for (const id of path) {
    if (!canOpenPath(root, res, id)) break
    res.push(id)
  }
  return res
}

/** Записывает правку графа уровня `path` в граф типа. Правка образца по умолчанию (`isDefault`) не записывается. */
export function writeGraphAt(root: Workflow, path: WfPath, graph: Workflow): Workflow {
  if (path.length === 0) return graph
  const [head, ...rest] = path
  const node = workNode(root, head)
  if (!node) return root
  if (rest.length === 0) {
    if (!isSubflow(node.subflow)) return root
    return replaceNode(root, { ...node, subflow: { nodes: graph.nodes, edges: graph.edges } })
  }
  const inner = graphAt(root, [head])
  if (!inner || inner.isDefault) return root
  const next = writeGraphAt(inner.graph, rest, graph)
  return replaceNode(root, { ...node, subflow: { nodes: next.nodes, edges: next.edges } })
}

function replaceNode(wf: Workflow, node: WfNode): Workflow {
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === node.id ? node : n)) }
}

/** «Свой путь»: у ноды появляется собственная копия пути по умолчанию — её и правят. */
export function startCustomSubflow(wf: Workflow, nodeId: string): Workflow {
  const node = workNode(wf, nodeId)
  if (!node || isSubflow(node.subflow)) return wf
  return replaceNode(wf, { ...node, subflow: defaultSubflow() })
}

/** «По умолчанию»: собственный путь ноды удаляется, подзадачи снова идут по `defaultSubflow()`. */
export function resetSubflow(wf: Workflow, nodeId: string): Workflow {
  const node = workNode(wf, nodeId)
  if (!node || node.subflow === undefined) return wf
  const { subflow: _subflow, ...rest } = node
  return replaceNode(wf, rest)
}

/** Свой путь ноды совпадает с путём по умолчанию, ничего не потеряется при возврате к нему. */
export function isDefaultLike(sub: WfSubflow): boolean {
  if (!isSubflow(sub)) return false
  const def = defaultSubflow()
  const key = (s: WfSubflow): string =>
    JSON.stringify([
      s.nodes.map((n) => ({ ...n, x: 0, y: 0 })).sort((a, b) => a.id.localeCompare(b.id)),
      s.edges.map((e: WfEdge) => [e.from, e.outcome, e.to]).sort()
    ])
  return key(sub) === key(def)
}

// ---------- подпись ноды ----------

type PathStep = 'review' | 'human' | 'merge' | 'git'

const STEP_OF: Partial<Record<WfNode['type'], PathStep>> = { gate: 'review', human: 'human', merge: 'merge', git: 'git' }

/**
 * Что делает путь помимо работы: проверки, человек, мерж, git — в порядке обхода от старта (порты — как в `WF_PORTS`),
 * каждый вид один раз. Подпись ноды «Работа» со своим путём. Конфликт мержа (`merge` → `conflict`) не считается: это
 * запасной выход, он есть и у пути по умолчанию, а человек в подписи означает решение человека в основном ходе.
 */
export function subflowSteps(sub: WfSubflow): PathStep[] {
  const nodes = new Map<string, WfNode>()
  for (const n of sub.nodes) nodes.set(n.id, n)
  const start = sub.nodes.find((n) => n.type === 'start')
  const seen = new Set<string>()
  const queue = start ? [start.id] : []
  const steps: PathStep[] = []
  while (queue.length) {
    const id = queue.shift()!
    const node = nodes.get(id)
    if (!node || seen.has(id)) continue
    seen.add(id)
    const step = STEP_OF[node.type]
    if (step && !steps.includes(step)) steps.push(step)
    for (const outcome of WF_PORTS[node.type] ?? []) {
      if (node.type === 'merge' && outcome === 'conflict') continue
      const edge = sub.edges.find((e) => e.from === id && e.outcome === outcome)
      if (edge) queue.push(edge.to)
    }
  }
  return steps
}

/** «ревью + мерж»; путь из одной работы — «только работа»; битый путь — пустая строка. */
export function subflowSummary(sub: unknown): string {
  if (!isSubflow(sub)) return ''
  const steps = subflowSteps(sub)
  if (steps.length === 0) return t('config.wf.path.workOnly')
  return steps.map((s) => t(`config.wf.path.step.${s}`)).join(' + ')
}

// ---------- крошки ----------

export interface WfCrumb {
  /** Путь, который откроет клик по крошке. */
  path: WfPath
  title: string
}

/** «Граф типа › Реализация»: первая крошка — граф типа, дальше — названия нод «Работа» по пути. */
export function crumbs(root: Workflow, path: WfPath): WfCrumb[] {
  const res: WfCrumb[] = [{ path: [], title: t('config.wf.nav.root') }]
  let cur = root
  path.forEach((id, i) => {
    const node = cur.nodes.find((n) => n.id === id)
    res.push({ path: path.slice(0, i + 1), title: node ? nodeTitle(node) : id })
    const at = graphAt(root, path.slice(0, i + 1))
    if (at) cur = at.graph
  })
  return res
}

// ---------- проблемы валидации по путям ----------

/** id ноды или перехода внутри пути из проблемы валидации: `impl/rev` → путь `['impl']`, id `rev`. */
export function locateId(root: Workflow, kind: 'node' | 'edge', id: string): { path: string[]; id: string } {
  const own = kind === 'node' ? root.nodes.some((n) => n.id === id) : root.edges.some((e) => e.id === id)
  const slash = id.indexOf('/')
  if (own || slash < 0) return { path: [], id }
  const head = id.slice(0, slash)
  if (!workNode(root, head)) return { path: [], id }
  return { path: [head], id: id.slice(slash + 1) }
}

/**
 * Проблемы валидации для холста уровня `path`. Валидатор отдаёт всё графом типа: проблема пути приходит с `subflowOf` и
 * `nodeId` вида `impl/rev`.
 * - Граф типа (`[]`): проблема пути ложится на ноду «Работа» (`impl`) — она подсвечивается, а текст в подсказке идёт
 *   с префиксом «нода «Реализация» → путь подзадачи»; переходы пути на этом уровне не видны.
 * - Внутри пути: остаются только его проблемы, id — без префикса, текст — без префикса; проблема без ноды
 *   (например, «нет Старта») остаётся без адреса и видна только в общем списке.
 */
export function levelIssues(issues: WfValidation, path: WfPath): WfValidation {
  if (path.length === 0) {
    const up = (i: WfIssue): WfIssue => {
      if (!i.subflowOf) return i
      const { edgeId: _edgeId, ...rest } = i
      return { ...rest, nodeId: i.subflowOf.nodeId }
    }
    return { errors: issues.errors.map(up), warnings: issues.warnings.map(up) }
  }
  const prefix = `${path.join('/')}/`
  const down = (list: readonly WfIssue[]): WfIssue[] =>
    list.flatMap((i) => {
      if (!i.subflowOf || i.subflowOf.nodeId !== path[path.length - 1]) return []
      const { subflowOf: _subflowOf, nodeId, edgeId, ...rest } = i
      return [{
        ...rest,
        ...(nodeId?.startsWith(prefix) ? { nodeId: nodeId.slice(prefix.length) } : {}),
        ...(edgeId?.startsWith(prefix) ? { edgeId: edgeId.slice(prefix.length) } : {})
      }]
    })
  return { errors: down(issues.errors), warnings: down(issues.warnings) }
}
