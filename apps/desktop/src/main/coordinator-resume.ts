import { resumeCoordinatorObjective, runResumeCoordinatorObjective, globalTaskTitle, type CoordinatorStageInfo, type TaskStore, type Run } from '@orca-board/core'
import { OrcaError } from './i18n'

/**
 * Жив ли терминал: в приложении — `isAlive` из `pty.ts`. Передаётся параметром, чтобы модуль не тянул
 * node-pty и electron: проверки повторного запуска и возврата тестируются в node без PTY
 * (`global-review.test.ts`).
 */
export type PtyAlive = (ptyId: string) => boolean

/**
 * Проверка перед повторным запуском координатора на существующей глобальной задаче и его цель:
 * описание (нет — название) плюс уточнения человека после проверки и список уже созданных подзадач,
 * чтобы координатор продолжил их, а не создал заново. Второй живой координатор на одной глобальной
 * задаче — ошибка. Воркфлоу прогона (`workflowScope: 'run'`): вместо «Повторного запуска» — блок «# Этап»
 * (`runResumeCoordinatorObjective`): координатор — диспетчер и продолжает с того этапа, где стоит граф.
 */
export function resumeObjective(store: TaskStore, runId: string, alive: PtyAlive): { run: Run; objective: string } {
  const run = store.getRun(runId)
  if (!run) throw new OrcaError('global.notFound', { id: runId })
  if (run.inbox) throw new OrcaError('coordinator.inboxNotTarget')
  if (run.coordinatorPtyId && alive(run.coordinatorPtyId)) {
    throw new OrcaError('coordinator.alreadyRunning', { pty: run.coordinatorPtyId })
  }
  const goal = run.objective.trim() || globalTaskTitle(run)
  const title = (status: string): string => store.columns().find((c) => c.id === status)?.title ?? status
  if (run.workflowScope === 'run') return { run, objective: runResumeCoordinatorObjective(goal, stageInfo(store, run, title)) }
  const tasks = store.listSubtasks(runId).map((t) => ({ id: t.id, title: t.title, status: title(t.status) }))
  return { run, objective: resumeCoordinatorObjective(goal, tasks, run.returns) }
}

/** Где стоит граф глобальной задачи и какие подзадачи есть в текущем заходе — для блока «# Этап» цели координатора. */
function stageInfo(store: TaskStore, run: Run, columnTitle: (status: string) => string): CoordinatorStageInfo | undefined {
  const stage = store.runStage(run.id)
  if (!stage) return undefined
  const tasks = stage.tasks.flatMap((id) => {
    const t = store.getTask(id)
    return t ? [{ id: t.id, title: t.title, status: columnTitle(t.status) }] : []
  })
  return {
    nodeId: stage.nodeId, type: stage.type, title: stage.title, visit: stage.visit,
    ...(stage.roleIds ? { roleIds: stage.roleIds } : {}),
    ...(stage.instructions ? { instructions: stage.instructions } : {}),
    ...(stage.feedback ? { feedback: stage.feedback } : {}),
    ...(stage.decision ? { decision: stage.decision } : {}),
    ...(stage.answers ? { answers: stage.answers } : {}),
    tasks,
    tasksDone: stage.tasksDoneAt !== undefined
  }
}

/**
 * Правка стора при «Вернуть в работу» — до запуска координатора. На «Проверке» прежний координатор может быть
 * ещё жив: после `runs finish` или ручного переноса карточки `coordinatorsToClose` закрывает терминал только
 * после `COORDINATOR_FINISH_GRACE_MS` тишины, а каждый ввод человека в терминал сдвигает отсчёт. Отказ
 * «ещё завершается» в это окно заставлял человека ждать или закрывать терминал руками, хотя уточнение уже
 * написано. Поэтому сначала стор (его проверки —
 * пустой текст, «Входящие», не на проверке — не трогают терминал), затем прежний терминал закрывается `stop`,
 * чтобы повторный запуск (`resumeObjective`) не упал на «координатор уже работает». Без `stop` (или если
 * терминал пережил его) — прежняя ошибка, стор не меняется.
 */
export function returnGlobalTaskToWork(
  store: TaskStore,
  runId: string,
  text: string,
  alive: PtyAlive,
  stop?: (ptyId: string) => void
): void {
  const run = store.getRun(runId)
  if (!run) throw new OrcaError('global.notFound', { id: runId })
  const ptyId = run.coordinatorPtyId
  if (ptyId && alive(ptyId) && !stop) {
    throw new OrcaError('coordinator.finishing')
  }
  store.returnGlobalTask(runId, text)
  if (ptyId && alive(ptyId) && stop) stop(ptyId)
}
