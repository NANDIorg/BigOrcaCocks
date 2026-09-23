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
  if (!run) throw new Error(`глобальная задача не найдена: ${runId}`)
  const ptyId = run.coordinatorPtyId
  if (ptyId && alive(ptyId) && !stop) {
    throw new Error('координатор этой глобальной задачи ещё завершается — повторите через несколько секунд')
  }
  store.returnGlobalTask(runId, text)
  if (ptyId && alive(ptyId) && stop) stop(ptyId)
}
