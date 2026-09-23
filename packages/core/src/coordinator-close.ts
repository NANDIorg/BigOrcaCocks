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
  /**
   * Агент координатора сам не выходит после финального ответа: без сигнала `runs finish` его терминал
   * закрывается по страховке `abandonedMs`. С сигналом или при ручном done закрывается любой агент.
   */
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
 * Терминалы координаторов, которые пора закрыть. Прогон подходит, только если он закрыт событием
 * run_done или получил run_done и ещё не закрыт (`runDoneAt`: координатор решает, нужна ли новая работа;
 * закрытие `runs close` без события не в счёт) и PTY координатора жив. Дальше два случая:
 * - run_done `manual` — человек перенёс глобальную задачу в «Сделано» или «Проверку»: решение за ним, подзадачи и вопросы
 *   не проверяются (прогон снова открыт → `closedAt` снят, сюда не попадёт); закрыть для любого агента,
 *   когда терминал молчит `graceMs` с run_done, сигнала `runs finish` и последней активности;
 * - автоматический run_done — все задачи и сейчас в kind=done, по ним нет открытых вопросов. Координатор
 *   прислал `runs finish` после run_done — закрыть для любого агента, когда терминал молчит `graceMs`;
 *   сигнала нет — только «незакрывающийся» агент (`lingers`) и только после `abandonedMs` тишины (страховка;
 *   после неё прогон с `runDoneAt` закрывает `settleIdleRuns` — карточка уходит на «Проверку»).
 * Активность до run_done не в счёт — сводка пишется после него.
 */
export function coordinatorsToClose(input: CoordinatorCloseInput): CoordinatorToClose[] {
  const graceMs = input.graceMs ?? COORDINATOR_FINISH_GRACE_MS
  const abandonedMs = input.abandonedMs ?? COORDINATOR_ABANDONED_MS
  const out: CoordinatorToClose[] = []
  for (const run of input.runs) {
    const ptyId = run.coordinatorPtyId
    if (!ptyId || (run.closedAt === undefined && run.runDoneAt === undefined)) continue
    // Последний run_done: прогон мог переоткрываться (повторный запуск координатора на глобальной задаче).
    const runDone = input.events.filter((e) => e.type === 'run_done' && e.payload.runId === run.id).pop()
    if (!runDone) continue
    const manual = runDone.payload.manual === true
    if (!manual) {
      const tasks = input.tasks.filter((t) => t.runId === run.id)
      // Прогон «ожил» после run_done (новая задача, задачу вернули из done) — не закрываем.
      if (tasks.length === 0 || !tasks.every((t) => input.isDone(t.status))) continue
      const ids = new Set(tasks.map((t) => t.id))
      if (input.questions.some((q) => !q.answeredAt && ids.has(q.taskId))) continue
    }
    const finished = run.finishedAt !== undefined && run.finishedAt >= runDone.createdAt ? run.finishedAt : undefined
    const quick = manual || finished !== undefined
    if (!quick && !input.lingers(run.coordinatorAgent)) continue
    const active = input.lastActivityAt(ptyId)
    if (active === undefined) continue
    const since = Math.max(active, runDone.createdAt, finished ?? 0)
    if (input.now - since < (quick ? graceMs : abandonedMs)) continue
    out.push({ runId: run.id, ptyId })
  }
  return out
}
