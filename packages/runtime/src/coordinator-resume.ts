import { resumeCoordinatorObjective, globalTaskTitle, type CoordinatorStage, type TaskStore, type Run } from '@orca-board/core'
import type { ExecutionMessages } from './execution-messages.ts'

export type PtyAlive = (ptyId: string) => boolean

/** Экземпляр общих ресурсов без глобального состояния Desktop. */
export function createCoordinatorResumeServices({ messages }: { messages: ExecutionMessages }) {

  /**
   * Жив ли терминал: в приложении — `isAlive` из `pty.ts`. Передаётся параметром, чтобы модуль не тянул
   * node-pty и electron: проверки повторного запуска и возврата тестируются в node без PTY
   * (`global-review.test.ts`).
   */

  /**
   * Проверка перед повторным запуском координатора на существующей глобальной задаче и его цель:
   * описание (нет — название) плюс уточнения человека после проверки и список уже созданных подзадач,
   * чтобы координатор продолжил их, а не создал заново. Второй живой координатор на одной глобальной
   * задаче — ошибка. Воркфлоу прогона (`workflowScope: 'run'`): вместо «Повторного запуска» — блок «# Этап»
   * (`resumeCoordinatorObjective` со `stage`): координатор — диспетчер и продолжает с того этапа «Работа», где стоит граф;
   * внутри разветвления — по блоку на каждую открытую «Работу» путей. На остальных этапах (проверка, человек, git…) координатору делать нечего — цель без блока: он ждёт `stage_started`.
   */
  function resumeObjective(store: TaskStore, runId: string, alive: PtyAlive): { run: Run; objective: string } {
    const run = store.getRun(runId)
    if (!run) throw messages.error('global.notFound', { id: runId })
    if (run.inbox) throw messages.error('coordinator.inboxNotTarget')
    if (run.coordinatorPtyId && alive(run.coordinatorPtyId)) {
      throw messages.error('coordinator.alreadyRunning', { pty: run.coordinatorPtyId })
    }
    const goal = run.objective.trim() || globalTaskTitle(run)
    const title = (status: string): string => store.columns().find((c) => c.id === status)?.title ?? status
    const tasks = store.listSubtasks(runId).map((t) => ({ id: t.id, title: t.title, status: title(t.status) }))
    if (run.workflowScope === 'run') {
      // Без блока этапа «Повторный запуск» по старой схеме (`runs finish`) прогону не подходит — цель как есть.
      const stages = workStages(store, run.id)
      return { run, objective: stages.length > 0 ? resumeCoordinatorObjective(goal, tasks, [], stages) : goal }
    }
    return { run, objective: resumeCoordinatorObjective(goal, tasks, run.returns) }
  }

  /**
   * Открытые этапы «Работа» глобальной задачи — для блоков «# Этап» цели координатора: у линейного прогона не больше
   * одного, внутри разветвления — по одному на путь, стоящий на «Работе» (пришедшие в слияние не в счёт). Остальные
   * ноды (проверка, человек, git…) координатору не нужны.
   */
  function workStages(store: TaskStore, runId: string): CoordinatorStage[] {
    return store.runStages(runId).filter((s) => s.type === 'work' && !s.arrived).map((stage) => ({
      title: stage.title, visit: stage.visit, nodeId: stage.nodeId,
      ...(stage.lane !== undefined ? { lane: stage.lane } : {}),
      ...(stage.laneTitle ? { laneTitle: stage.laneTitle } : {}),
      ...(stage.roleIds ? { roleIds: stage.roleIds } : {}),
      ...(stage.instructions ? { instructions: stage.instructions } : {}),
      ...(stage.feedback ? { feedback: stage.feedback } : {}),
      ...(stage.feedback && stage.images ? { images: stage.images } : {}),
      ...(stage.decision ? { decision: stage.decision } : {}),
      ...(stage.answers ? { answers: stage.answers } : {}),
      tasks: stage.tasks,
      tasksDone: stage.tasksDoneAt !== undefined
    }))
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
  function returnGlobalTaskToWork(
    store: TaskStore,
    runId: string,
    text: string,
    alive: PtyAlive,
    stop?: (ptyId: string) => void,
    images?: string[]
  ): void {
    const run = store.getRun(runId)
    if (!run) throw messages.error('global.notFound', { id: runId })
    const ptyId = run.coordinatorPtyId
    if (ptyId && alive(ptyId) && !stop) {
      throw messages.error('coordinator.finishing')
    }
    store.returnGlobalTask(runId, text, images)
    if (ptyId && alive(ptyId) && stop) stop(ptyId)
  }

  return { resumeObjective, returnGlobalTaskToWork }
}
