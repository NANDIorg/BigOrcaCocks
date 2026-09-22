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
 * Пауза после сигнала координатора `runs finish` (и после последней активности терминала), прежде чем
 * закрыть его: агент успевает дорисовать финальный ответ. Ввод человека сдвигает отсчёт.
 */
export const COORDINATOR_FINISH_GRACE_MS = 15_000

/**
 * Страховка, если координатор не прислал `runs finish`: терминал закрывается только после долгой
 * тишины (ни вывода, ни ввода) с момента run_done. Тишина ≠ завершение — агент может ждать
 * подтверждения команды или человек читает ответ, — поэтому порог много больше любой паузы в работе.
 */
export const COORDINATOR_ABANDONED_MS = 30 * 60_000

export interface CoordinatorCloseInput {
  runs: Run[]
  tasks: Task[]
  questions: Question[]
  events: OrcaEvent[]
  /** Статус (id колонки) относится к kind=done. */
  isDone(status: string): boolean
  /** Агент координатора сам не выходит после финального ответа — его терминал закрывает приложение. */
  lingers(agent: AgentKind | undefined): boolean
  /** Время последней активности PTY (вывод или ввод человека); undefined — PTY уже не жив. */
  lastActivityAt(ptyId: string): number | undefined
  now: number
  graceMs?: number
  abandonedMs?: number
}

export interface CoordinatorToClose {
  runId: string
  ptyId: string
}

/**
 * Терминалы координаторов, которые пора закрыть. Прогон подходит, только если:
 * он закрыт событием run_done (ручное закрытие не в счёт), все его задачи и сейчас в kind=done,
 * по ним нет открытых вопросов, агент координатора из «незакрывающихся» и PTY жив. Дальше:
 * - координатор прислал `runs finish` после run_done — закрыть, когда терминал молчит `graceMs`
 *   с момента сигнала и последней активности;
 * - сигнала нет — закрыть, только если терминал молчит `abandonedMs` с run_done (страховка).
 * Активность до run_done не в счёт — сводка пишется после него.
 */
export function coordinatorsToClose(input: CoordinatorCloseInput): CoordinatorToClose[] {
  const graceMs = input.graceMs ?? COORDINATOR_FINISH_GRACE_MS
  const abandonedMs = input.abandonedMs ?? COORDINATOR_ABANDONED_MS
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
    const active = input.lastActivityAt(ptyId)
    if (active === undefined) continue
    const finished = run.finishedAt !== undefined && run.finishedAt >= runDone.createdAt ? run.finishedAt : undefined
    const since = Math.max(active, runDone.createdAt, finished ?? 0)
    if (input.now - since < (finished !== undefined ? graceMs : abandonedMs)) continue
    out.push({ runId: run.id, ptyId })
  }
  return out
}
