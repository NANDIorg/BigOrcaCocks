import { resumeCoordinatorObjective, globalTaskTitle, type TaskStore, type Run } from '@orca-board/core'

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
 * задаче — ошибка.
 */
export function resumeObjective(store: TaskStore, runId: string, alive: PtyAlive): { run: Run; objective: string } {
  const run = store.getRun(runId)
  if (!run) throw new Error(`глобальная задача не найдена: ${runId}`)
  if (run.inbox) throw new Error('«Входящие» — не цель для координатора: создай глобальную задачу')
  if (run.coordinatorPtyId && alive(run.coordinatorPtyId)) {
    throw new Error(`координатор этой глобальной задачи уже работает (терминал ${run.coordinatorPtyId})`)
  }
  const goal = run.objective.trim() || globalTaskTitle(run)
  const title = (status: string): string => store.columns().find((c) => c.id === status)?.title ?? status
  const tasks = store.listSubtasks(runId).map((t) => ({ id: t.id, title: t.title, status: title(t.status) }))
  return { run, objective: resumeCoordinatorObjective(goal, tasks, run.returns) }
}

/**
 * Правка стора при «Вернуть в работу» — до запуска координатора. Живой координатор проверяется до
 * `returnGlobalTask`: после `runs finish` его терминал закрывается не сразу (`coordinatorsToClose`), и возврат
 * в это окно не должен оставить задачу «В работе» с уточнением, но без нового координатора.
 */
export function returnGlobalTaskToWork(store: TaskStore, runId: string, text: string, alive: PtyAlive): void {
  const run = store.getRun(runId)
  if (!run) throw new Error(`глобальная задача не найдена: ${runId}`)
  if (run.coordinatorPtyId && alive(run.coordinatorPtyId)) {
    throw new Error('координатор этой глобальной задачи ещё завершается — повторите через несколько секунд')
  }
  store.returnGlobalTask(runId, text)
}
