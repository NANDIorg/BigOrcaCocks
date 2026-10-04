import type { Dispatch, GlobalTaskReturn, GlobalTaskSummary, Task } from '@orca-board/core'

/** Сделанная подзадача в фоллбэке «Что сделал»: сводка — из последнего запуска воркера, как в TaskModal. */
export interface DoneSubtask {
  taskId: string
  title: string
  summary?: string
}

/**
 * Что показать в блоке «Что сделал» на «Проверке» глобальной задачи. `coordinator` — итоговая сводка
 * координатора (`runs finish --summary`, markdown). `subtasks` — сводки нет: старый координатор или main,
 * ручной перенос, координатор умер до `runs finish`, — человеку хотя бы видно, что сдали подзадачи.
 */
export type GlobalDoneReport =
  | { kind: 'coordinator'; text: string; at: number }
  | { kind: 'subtasks'; items: DoneSubtask[] }

/**
 * Выбрать текст блока «Что сделал». Сводка координатора старше последнего возврата с «Проверки» описывает
 * прошлый заход, а не то, что сейчас на проверке (новый координатор мог уйти без `runs finish --summary`), —
 * тогда тоже фоллбэк. Поля `summary` может не быть: renderer работает и со снапшотом старого main.
 */
export function globalDoneReport(
  global: { summary?: GlobalTaskSummary; returns?: GlobalTaskReturn[] },
  tasks: ReadonlyArray<Pick<Task, 'id' | 'title' | 'status' | 'createdAt'>>,
  dispatches: ReadonlyArray<Pick<Dispatch, 'taskId' | 'startedAt' | 'summary'>>,
  isDone: (status: string) => boolean
): GlobalDoneReport {
  const summary = global.summary
  const lastReturnAt = (global.returns ?? []).reduce((max, r) => Math.max(max, r.at), -Infinity)
  if (summary && summary.text.trim() && summary.at >= lastReturnAt) return { kind: 'coordinator', text: summary.text, at: summary.at }
  const items = tasks
    .filter((t) => isDone(t.status))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t): DoneSubtask => {
      const last = dispatches.filter((d) => d.taskId === t.id).sort((a, b) => b.startedAt - a.startedAt)[0]
      const text = last?.summary?.trim()
      return { taskId: t.id, title: t.title, ...(text ? { summary: text } : {}) }
    })
  return { kind: 'subtasks', items }
}
