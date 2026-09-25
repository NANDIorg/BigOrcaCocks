import { isPendingRequest, type ColumnKind, type GlobalTask, type GlobalTaskReturn, type HumanRequest } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { t } from './i18n'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'

/**
 * Что можно сделать с глобальной задачей на карточке и в деталях. «Проверка» — колонка kind=review
 * глобального канбана: работа закрыта и ждёт приёмки человеком.
 */
export interface GlobalTaskActions {
  /** «Запустить координатора»: на «Проверке» скрыта — там вместо неё «Вернуть в работу…» с уточнением. */
  startCoordinator: boolean
  /** «Подтвердить»: с «Проверки» в «Сделано». */
  accept: boolean
  /**
   * «Вернуть в работу…»: с «Проверки» в работу с уточнением и повторным запуском координатора. Доступна и при
   * живом прежнем координаторе: после `runs finish` или ручного переноса на «Проверку» его терминал закрывается
   * лишь после тишины, а ввод человека в терминал продлевает окно. Выключенная кнопка оставляла человека
   * без поля для уточнения на всё это время; возврат закрывает терминал сам.
   */
  returnToWork: boolean
  /** Прежний координатор ещё жив: возврат закроет его терминал (main, `returnGlobalTaskToWork`). */
  returnClosesCoordinator?: boolean
}

/**
 * Доступные действия. kind — вид колонки, в которой карточка показана (с учётом «Нужен ответ»);
 * live — у задачи есть живой координатор. У «Входящих» нет координатора и они не бывают на проверке.
 */
export function globalTaskActions(g: { inbox?: boolean }, kind: ColumnKind | undefined, live: boolean): GlobalTaskActions {
  if (g.inbox) return { startCoordinator: false, accept: false, returnToWork: false }
  const review = kind === 'review'
  return {
    startCoordinator: !review && !live,
    accept: review,
    returnToWork: review,
    ...(review && live ? { returnClosesCoordinator: true } : {})
  }
}

/** История уточнений для показа: новые сверху. У задачи без возвратов — пусто. */
export function returnsNewestFirst(g: { returns?: GlobalTaskReturn[] }): GlobalTaskReturn[] {
  return [...(g.returns ?? [])].sort((a, b) => b.at - a.at)
}

/**
 * Прогон с воркфлоу глобальной задачи (`workflowScope: 'run'`): «Проверка» — это approval ноды `human`. «Подтвердить»
 * у него с полем «Решение / что делать дальше», «Вернуть» идёт по переходу графа, а не перезапуском координатора.
 * Нет поля (прогон старого формата, «Входящие», старый main) — прежняя «Проверка».
 */
export function isRunWorkflow(g: Partial<Pick<GlobalTask, 'workflowScope' | 'inbox'>>): boolean {
  return g.workflowScope === 'run' && g.inbox !== true
}

/** Ждущий approval уровня прогона (нода `human`, без задачи): что человек подтверждает. Нет — undefined. */
export function runApprovalRequest(requests: readonly HumanRequest[] | undefined, runId: string): HumanRequest | undefined {
  return (requests ?? [])
    .filter((r) => r.runId === runId && r.taskId === undefined && r.kind === 'approval' && isPendingRequest(r))
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

/** Подсказка под полем уточнения в «Вернуть в работу»: что произойдёт после отправки. */
export function returnHint(closesCoordinator: boolean, runWorkflow = false): string {
  if (runWorkflow) return t('global.return.hintRun')
  return t(closesCoordinator ? 'global.return.hintCloses' : 'global.return.hint')
}

/** Ошибка «старый main/preload без «Проверки»» на текущем языке интерфейса. */
export function staleReviewMessage(): string {
  return t('global.stale.review')
}

/**
 * `accept` и `returnToWork` из `window.orca.globalTasks` или понятная ошибка. В `pnpm dev` renderer
 * обновляется по HMR, а preload остаётся старым — методов нет (правило 086a654).
 */
export function globalReviewApi(api: Partial<OrcaApi> | undefined): Pick<OrcaApi['globalTasks'], 'accept' | 'returnToWork'> {
  const g = api?.globalTasks as Partial<OrcaApi['globalTasks']> | undefined
  const accept = g?.accept
  const returnToWork = g?.returnToWork
  if (typeof accept !== 'function' || typeof returnToWork !== 'function') throw new Error(staleReviewMessage())
  return { accept: (id, decision) => accept(id, decision), returnToWork: (id, text, cols, rows) => returnToWork(id, text, cols, rows) }
}

/** Старый main отказал в возврате при живом координаторе — как обойти, на текущем языке. */
export function staleReturnLiveMessage(): string {
  return t('global.stale.returnLive')
}

/**
 * Ошибка IPC для человека (`e` — ошибка invoke или её текст): preload новый, а main старый — «No handler registered»
 * → «перезапустите». Отказ в возврате при живом координаторе («ещё завершается») — объясняем, как обойти. Main
 * с переводом присылает код `coordinator.finishing`; main до перевода — только русский текст, его сверяем как есть.
 */
export function reviewErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/No handler registered for 'globalTasks:(accept|returnToWork)'/.test(raw)) return staleReviewMessage()
  if (ipcErrorCode(e) === 'coordinator.finishing' || /координатор этой глобальной задачи ещё завершается/.test(raw)) {
    return staleReturnLiveMessage()
  }
  return ipcErrorMessage(e)
}
