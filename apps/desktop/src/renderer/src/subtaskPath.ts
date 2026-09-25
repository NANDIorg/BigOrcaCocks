import { defaultSubflow, type GlobalTask, type StageChange, type Task, type WfNode, type WfNodeType, type WfSubflow, type Workflow } from '@orca-board/core'
import { t, type TKey } from './i18n'
import { builtinText, nodeTitle } from './defaultTitles'
import { stageLabel, type StageLabel } from './cardState'
import { STATUS_HISTORY_COLLAPSED, STATUS_SOURCE_TITLES } from './statusHistory'

// Путь подзадачи (`work.subflow`, docs/workflow.md → «Путь подзадачи»): у подзадачи этапа «Работа» своя позиция `Task.stage` —
// на ноде пути, а не на графе прогона. Чистые функции без React: пилюля шага пути на карточке, «держит этап прогона» и история
// шагов в карточке задачи. Всё, что читается из снимка, необязательно: старый main этих полей не отдаёт — тогда блоков нет.

type WorkNode = Extract<WfNode, { type: 'work' }>

/** Подзадача, для которой граф прогона не нужен: ответ или проверка. Путь есть только у рабочей подзадачи этапа. */
type PathTask = Pick<Task, 'answerFor' | 'gateFor' | 'stageOf'>

/**
 * Нода «Работа» графа прогона, чей путь проходит подзадача (как `TaskStore.taskWorkflow`): рабочая подзадача со `stageOf` на
 * ноде `work`. Нет графа, нет `stageOf`, ответ, проверка или нода не `work` — undefined.
 */
export function pathOwner(task: PathTask, workflow: Workflow | undefined): WorkNode | undefined {
  if (!workflow || task.answerFor || task.gateFor || !task.stageOf) return undefined
  const node = workflow.nodes.find((n) => n.id === task.stageOf?.nodeId)
  return node?.type === 'work' ? node : undefined
}

/** Путь подзадачи: `subflow` ноды или путь по умолчанию (тот же, что берёт движок). Не подзадача пути — undefined. */
export function pathGraph(task: PathTask, workflow: Workflow | undefined): WfSubflow | undefined {
  const owner = pathOwner(task, workflow)
  return owner ? owner.subflow ?? defaultSubflow() : undefined
}

/**
 * Название ноды пути. Ноде «Работа» без своего названия достаётся название внешней «Работы»: в `defaultSubflow()` у неё
 * заголовка нет, а человеку нужно «Реализация», а не «Работа» (так же наследует заголовок `taskWorkStage`).
 */
export function pathNodeName(node: WfNode, owner: WorkNode): string {
  return node.type === 'work' && !node.title?.trim() ? nodeTitle(owner) : nodeTitle(node)
}

/** Ноды пути, на которых подзадача не стоит: в истории и на карточке их нет. */
const PASS_THROUGH: readonly WfNodeType[] = ['start', 'condition']

/** Шаг пути, на котором сейчас стоит подзадача; ещё не вошла в путь, позиции нет или нода не «стоячая» — undefined. */
function currentStep(task: Pick<Task, 'stage'> & PathTask, workflow: Workflow | undefined): { node: WfNode; owner: WorkNode; visits: number } | undefined {
  const owner = pathOwner(task, workflow)
  const stage = task.stage
  if (!owner || !stage) return undefined
  const graph = owner.subflow ?? defaultSubflow()
  const node = graph.nodes.find((n) => n.id === stage.nodeId)
  if (!node || PASS_THROUGH.includes(node.type)) return undefined
  return { node, owner, visits: stage.visits?.[stage.nodeId] ?? 1 }
}

/**
 * Пилюля этапа на карточке подзадачи. На пути — «Реализация › Ревью» (этап прогона › шаг пути; шаг «Работа» и есть этап, тогда
 * только «Реализация»), со второго захода в шаг — «· N-й заход». Подсказка называет и этап, и шаг. Подзадача ещё не вошла в путь
 * (нет `Task.stage`) или это не подзадача пути — null: карточка берёт обычную пилюлю (`stageLabel`).
 */
export function subtaskPathLabel(task: Pick<Task, 'stage'> & PathTask, workflow: Workflow | undefined): StageLabel | null {
  const step = currentStep(task, workflow)
  if (!step) return null
  const stageName = nodeTitle(step.owner)
  const stepName = pathNodeName(step.node, step.owner)
  const base = stepName === stageName ? stageName : t('board.path.label', { stage: stageName, step: stepName })
  const text = step.visits > 1 ? t('board.stage.visit', { name: base, n: step.visits }) : base
  return { kind: 'stage', text, title: t('board.path.title', { stage: stageName, step: stepName }) }
}

/**
 * Пилюля этапа карточки любой подзадачи прогона: путь подзадачи, а иначе прежняя (`stageLabel`). Названия нод считаются по
 * тому графу, где нода лежит: у задачи-проверки ветки подзадачи `gateFor.nodeId` — нода пути проверяемой задачи, а не графа прогона.
 */
export function cardStageLabel(
  task: Pick<Task, 'stage' | 'gateFor'> & PathTask,
  workflow: Workflow | undefined,
  titles: Readonly<Record<string, string>> | undefined,
  taskById: (id: string) => Pick<Task, 'title' | 'stage'> & PathTask | undefined
): StageLabel | null {
  const path = subtaskPathLabel(task, workflow)
  if (path) return path
  const target = task.gateFor?.taskId !== undefined ? taskById(task.gateFor.taskId) : undefined
  const targetGraph = target ? pathGraph(target, workflow) : undefined
  const owner = target ? pathOwner(target, workflow) : undefined
  const scoped = targetGraph && owner
    ? Object.fromEntries(targetGraph.nodes.map((n) => [n.id, pathNodeName(n, owner)]))
    : titles
  return stageLabel(task, scoped, (id) => taskById(id)?.title)
}

/** Чего ждёт подзадача, держащая этап прогона: проверки (`gate` пути) или человека (`human` пути: решение, конфликт мержа). */
export type StageHoldReason = 'review' | 'human'

/** Пометка «держит этап»: что подзадача ждёт внутри пути и как назвать шаг. */
export interface StageHold {
  reason: StageHoldReason
  text: string
  title: string
}

/**
 * Подзадача держит этап прогона: этап «Работа» закрывается, когда все подзадачи текущего захода дошли до `end` пути, а эта
 * стоит на `gate` (ждёт проверки ветки) или `human` (ждёт человека) своего пути. Задачи прошлых заходов, закрытые задачи, ответы и
 * проверки этап не держат; граф прогона стоит не на её этапе — тоже. Нет графа или позиции (старый main) — null.
 */
export function stageHold(
  task: Pick<Task, 'stage' | 'status'> & PathTask,
  run: Partial<Pick<GlobalTask, 'stage' | 'workflowScope'>> | undefined,
  workflow: Workflow | undefined,
  isDone: (status: string) => boolean
): StageHold | null {
  const at = run?.stage
  if (run?.workflowScope !== 'run' || !at || !task.stageOf || isDone(task.status)) return null
  if (at.nodeId !== task.stageOf.nodeId || (at.visits?.[at.nodeId] ?? 1) !== task.stageOf.visit) return null
  const step = currentStep(task, workflow)
  if (!step || (step.node.type !== 'gate' && step.node.type !== 'human')) return null
  const reason: StageHoldReason = step.node.type === 'gate' ? 'review' : 'human'
  const stageName = nodeTitle(step.owner)
  const stepName = pathNodeName(step.node, step.owner)
  return {
    reason,
    text: t(reason === 'review' ? 'board.path.holdReview' : 'board.path.holdHuman'),
    title: t('board.path.holdTitle', { stage: stageName, step: stepName })
  }
}

/** Строка истории шагов подзадачи: вход в ноду пути, чем пришла и сколько на ней пробыла. */
export interface PathRow {
  /** Порядковый номер записи в `Task.stageHistory` — ключ React. */
  index: number
  nodeId: string
  /** Название шага пути; ноды уже нет в графе (граф поменяли) — название из записи. */
  name: string
  type?: WfNodeType
  at: number
  /** Заход в шаг со второго — «N-й заход»; первый и неизвестный — undefined. */
  visit?: number
  /** Чем пришла: возврат на доработку, конфликт мержа, перезапуск — только заметные исходы. */
  outcome?: string
  source?: string
  /** До следующего входа; у последней записи — до now, у конца пути — 0. */
  durationMs: number
  current: boolean
  migrated: boolean
}

const NOTABLE_OUTCOMES: readonly NonNullable<StageChange['outcome']>[] = ['reject', 'accept', 'restart', 'conflict', 'error']

/**
 * История шагов подзадачи (`Task.stageHistory`) от старых к новым. Название — из пути (переведено), иначе из записи. Вход в
 * `start` и условия не показываем: подзадача на них не стоит. Нет поля (снапшот старого main), нет пути или записей — пустой список.
 */
export function pathHistoryRows(
  task: Pick<Task, 'stageHistory'> & PathTask,
  workflow: Workflow | undefined,
  now: number
): PathRow[] {
  const owner = pathOwner(task, workflow)
  const history = task.stageHistory
  if (!owner || !history) return []
  const graph = owner.subflow ?? defaultSubflow()
  const shown = history.flatMap((h, index) => {
    const node = graph.nodes.find((n) => n.id === h.nodeId)
    return node && PASS_THROUGH.includes(node.type) ? [] : [{ h, index, node }]
  })
  return shown.map(({ h, index, node }, i) => {
    const next = shown[i + 1]
    const current = next === undefined
    return {
      index,
      nodeId: h.nodeId,
      name: node ? pathNodeName(node, owner) : h.title ? builtinText(h.title) : h.nodeId,
      ...(node ? { type: node.type } : {}),
      at: h.at,
      ...(h.visit !== undefined && h.visit > 1 ? { visit: h.visit } : {}),
      ...(h.outcome && NOTABLE_OUTCOMES.includes(h.outcome) ? { outcome: t(`global.timeline.stageOutcome.${h.outcome}` as TKey) } : {}),
      ...(h.by ? { source: STATUS_SOURCE_TITLES[h.by] ?? String(h.by) } : {}),
      durationMs: node?.type === 'end' ? 0 : Math.max(0, (next ? next.h.at : now) - h.at),
      current,
      migrated: h.migrated === true
    }
  })
}

/** Где подзадача в своём пути — для шапки блока в карточке задачи. Не подзадача пути — null; шаг неизвестен (не вошла в путь) — только этап. */
export function pathSummary(task: Pick<Task, 'stage'> & PathTask, workflow: Workflow | undefined): { stage: string; step?: string; visit: number } | null {
  const owner = pathOwner(task, workflow)
  if (!owner) return null
  const step = currentStep(task, workflow)
  return { stage: nodeTitle(owner), ...(step ? { step: pathNodeName(step.node, step.owner) } : {}), visit: task.stageOf?.visit ?? 1 }
}

/** Видимые строки: свёрнутый блок — последние `STATUS_HISTORY_COLLAPSED`, развёрнутый — все. */
export function visiblePathRows(rows: readonly PathRow[], expanded: boolean): PathRow[] {
  return expanded || rows.length <= STATUS_HISTORY_COLLAPSED ? [...rows] : rows.slice(-STATUS_HISTORY_COLLAPSED)
}

/** Названия нод пути подзадачи по id (для полосы «По этапам» в статистике); не подзадача пути — undefined. */
export function pathNodeTitles(task: PathTask, workflow: Workflow | undefined): Record<string, string> | undefined {
  const owner = pathOwner(task, workflow)
  if (!owner) return undefined
  return Object.fromEntries((owner.subflow ?? defaultSubflow()).nodes.map((n) => [n.id, pathNodeName(n, owner)]))
}
