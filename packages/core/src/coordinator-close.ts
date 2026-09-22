/**
 * Автозакрытие терминала координатора после завершения прогона.
 * Интерактивные CLI (Codex) после финального ответа ждут ввода и сами не выходят, поэтому
 * PTY координатора закрывает приложение. Здесь — чистое решение «кого закрыть сейчас» без Node:
 * вызывающий (main, `apps/desktop/src/main/index.ts`) периодически передаёт состояние доски и
 * время последнего вывода PTY и гасит возвращённые терминалы. Решение не хранит состояния,
 * поэтому повторные вызовы, повторные события и гонки с ручным закрытием безопасны.
 */
import type { OrcaEvent, Question, Run, Task } from './types'
import type { AgentKind } from './agents'

/**
 * Сколько терминал координатора должен молчать после run_done, чтобы считать, что он дописал
 * сводку и ждёт ввода. Пока агент думает или выполняет команду, TUI обновляет индикатор работы.
 */
export const COORDINATOR_IDLE_MS = 45_000

export interface CoordinatorCloseInput {
  runs: Run[]
  tasks: Task[]
  questions: Question[]
  events: OrcaEvent[]
  /** Статус (id колонки) относится к kind=done. */
  isDone(status: string): boolean
  /** Агент координатора сам не выходит после финального ответа — его терминал закрывает приложение. */
  lingers(agent: AgentKind | undefined): boolean
  /** Время последнего вывода PTY; undefined — PTY уже не жив. */
  lastOutputAt(ptyId: string): number | undefined
  now: number
  idleMs?: number
}

export interface CoordinatorToClose {
  runId: string
  ptyId: string
}

/**
 * Терминалы координаторов, которые пора закрыть. Прогон подходит, только если:
 * он закрыт событием run_done (ручное закрытие не в счёт), все его задачи и сейчас в kind=done,
 * по ним нет открытых вопросов, агент координатора из «незакрывающихся», PTY жив и молчит
 * `idleMs` с момента run_done (вывод до run_done не в счёт — сводка пишется после него).
 */
export function coordinatorsToClose(input: CoordinatorCloseInput): CoordinatorToClose[] {
  const idleMs = input.idleMs ?? COORDINATOR_IDLE_MS
  const out: CoordinatorToClose[] = []
  for (const run of input.runs) {
    const ptyId = run.coordinatorPtyId
    if (!ptyId || run.closedAt === undefined || !input.lingers(run.coordinatorAgent)) continue
    const runDone = input.events.find((e) => e.type === 'run_done' && e.payload.runId === run.id)
    if (!runDone) continue
    const tasks = input.tasks.filter((t) => t.runId === run.id)
    // Прогон «ожил» после run_done (новая задача, задачу вернули из done) — не закрываем.
    if (tasks.length === 0 || !tasks.every((t) => input.isDone(t.status))) continue
    const ids = new Set(tasks.map((t) => t.id))
    if (input.questions.some((q) => !q.answeredAt && ids.has(q.taskId))) continue
    const last = input.lastOutputAt(ptyId)
    if (last === undefined) continue
    if (input.now - Math.max(last, runDone.createdAt) < idleMs) continue
    out.push({ runId: run.id, ptyId })
  }
  return out
}
