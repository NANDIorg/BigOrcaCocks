import { isPendingRequest, toTaskScopeWorkflow, type ColumnKind, type GlobalTask, type HumanRequest, type Task, type WfNode, type WfNodeType, type Workflow } from '@orca-board/core'
import { t } from './i18n'
import { nodeTitle } from './defaultTitles'
import { pathGraph, pathNodeName, pathOwner } from './subtaskPath'

// «Человеку есть что ревьюить» — одно правило для ленты «Ждут вас», счётчика ревью на доске глобальных задач и блока
// ревью в карточке задачи. Колонка «Ревью» ≠ этап проверки: задача сдана в «Ревью», а воркфлоу стоит на `merge`
// (мерж упал или прервался рестартом) — там «Принять» не ревью, а повтор этапа (docs/human-requests.md → «В интерфейсе»).

/** Что показать по задаче в колонке «Ревью»: `review` — ждёт проверки человеком, `stalled` — этап остановлен. */
export type ReviewState = 'review' | 'stalled'

/** Нода этапа задачи и её название для человека. */
export interface StageNodeInfo {
  type: WfNodeType
  name: string
}

type StageTask = Pick<Task, 'stage' | 'answerFor' | 'gateFor' | 'stageOf'>

/**
 * Нода, на которой стоит задача (`Task.stage`), — в том же графе, что берёт движок (`TaskStore.taskWorkflow`): путь
 * подзадачи этапа «Работа», граф прогона (`workflowScope: 'run'`) или граф по подзадачам старого движка. Нет позиции,
 * графа (старый main, типы ещё не пришли) или ноды в нём — undefined.
 */
export function stageNodeOf(
  task: StageTask,
  run: Partial<Pick<GlobalTask, 'workflowScope'>> | undefined,
  workflow: Workflow | undefined
): StageNodeInfo | undefined {
  const stage = task.stage
  if (!stage || !workflow) return undefined
  const owner = pathOwner(task, workflow)
  const path = owner ? pathGraph(task, workflow) : undefined
  if (owner && path) {
    const node = path.nodes.find((n) => n.id === stage.nodeId)
    return node ? { type: node.type, name: pathNodeName(node, owner) } : undefined
  }
  const graph = run?.workflowScope === 'run' ? workflow : toTaskScopeWorkflow(workflow)
  const node: WfNode | undefined = graph.nodes.find((n) => n.id === stage.nodeId)
  return node ? { type: node.type, name: nodeTitle(node) } : undefined
}

/**
 * Состояние задачи в колонке «Ревью». Нет (undefined) — не колонка «Ревью», задача-ответ или проверка, есть pending-запрос
 * (он сам пункт ленты). `review` — нода проверки (`gate`/`human`) или задача без этапа (старые задачи, вне воркфлоу): «Принять» —
 * решение по ревью. `stalled` — любая другая нода (`merge`, `git`, `end`, `work`): решать нечего, этап не завершён. Ноду
 * узнать не удалось (нет графа) — остановку видно только по `Task.stageBlock` этой ноды, иначе прежнее поведение (`review`).
 */
export function reviewStateOf(
  task: Pick<Task, 'answerFor' | 'gateFor' | 'stage' | 'stageBlock'>,
  column: ColumnKind | undefined,
  hasPending: boolean,
  node: Pick<StageNodeInfo, 'type'> | undefined
): ReviewState | undefined {
  if (column !== 'review' || task.answerFor || task.gateFor || hasPending) return undefined
  if (!task.stage) return 'review'
  if (node) return node.type === 'gate' || node.type === 'human' ? 'review' : 'stalled'
  return task.stageBlock?.nodeId === task.stage.nodeId ? 'stalled' : 'review'
}

/** У задачи есть pending-запрос к человеку: тогда пункт ленты — сам запрос, а не ревью задачи. */
export function hasPendingRequest(requests: readonly HumanRequest[], taskId: string): boolean {
  return requests.some((r) => r.taskId === taskId && isPendingRequest(r))
}

/**
 * Состояние задачи в «Ревью» по снимку — для мест вне ленты (счётчик ревью глобальной задачи, карточка задачи): тот же
 * `reviewStateOf`, нода — по графу прогона задачи.
 */
export function taskReviewState(
  task: Task,
  column: ColumnKind | undefined,
  requests: readonly HumanRequest[],
  run: Partial<Pick<GlobalTask, 'workflowScope'>> | undefined,
  workflow: Workflow | undefined
): ReviewState | undefined {
  if (column !== 'review') return undefined
  return reviewStateOf(task, column, hasPendingRequest(requests, task.id), stageNodeOf(task, run, workflow))
}

/**
 * Почему этап стоит — для заголовка пункта и блока в карточке: причина остановки (`Task.stageBlock`) этой ноды, а без неё
 * (старый main, прерванный рестартом эффект) — «Этап «Мерж» не завершён».
 */
export function stalledReason(task: Pick<Task, 'stage' | 'stageBlock'>, node: Pick<StageNodeInfo, 'name'> | undefined): string {
  const block = task.stageBlock
  if (block && block.nodeId === task.stage?.nodeId && block.reason.trim()) return block.reason
  const name = node?.name ?? task.stage?.nodeId
  return name ? t('shell.attention.stalledFallback', { stage: name }) : t('shell.attention.stalledUnknown')
}

/** Подпись «Принять» для остановленного этапа: на мерже — «Повторить мерж», на прочих нодах — «Продолжить этап». */
export function stalledRetryLabel(node: Pick<StageNodeInfo, 'type'> | undefined, stageNodeId: string | undefined): string {
  const merge = node ? node.type === 'merge' : stageNodeId === 'merge'
  return t(merge ? 'shell.feed.retryMerge' : 'shell.feed.retryStage')
}
