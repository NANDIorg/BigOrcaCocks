import type { ColumnKind, GlobalTaskReturn } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'

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

/** Подсказка под полем уточнения в «Вернуть в работу»: что произойдёт после отправки. */
export function returnHint(closesCoordinator: boolean): string {
  const base = 'Задача уйдёт в «В работе», и откроется терминал координатора с этим уточнением.'
  return closesCoordinator ? `Прежний координатор ещё открыт — его терминал будет закрыт. ${base}` : base
}

export const STALE_REVIEW_MESSAGE =
  'Приложение запущено со старой версией main/preload, где ещё нет «Проверки» глобальных задач. Перезапустите приложение.'

/**
 * `accept` и `returnToWork` из `window.orca.globalTasks` или понятная ошибка. В `pnpm dev` renderer
 * обновляется по HMR, а preload остаётся старым — методов нет (правило 086a654).
 */
export function globalReviewApi(api: Partial<OrcaApi> | undefined): Pick<OrcaApi['globalTasks'], 'accept' | 'returnToWork'> {
  const g = api?.globalTasks as Partial<OrcaApi['globalTasks']> | undefined
  const accept = g?.accept
  const returnToWork = g?.returnToWork
  if (typeof accept !== 'function' || typeof returnToWork !== 'function') throw new Error(STALE_REVIEW_MESSAGE)
  return { accept: (id) => accept(id), returnToWork: (id, text, cols, rows) => returnToWork(id, text, cols, rows) }
}

export const STALE_RETURN_LIVE_MESSAGE =
  'Прежний координатор ещё открыт, а приложение запущено со старой версией main, которая не закрывает его при возврате. ' +
  'Закройте терминал координатора или перезапустите приложение и повторите.'

/**
 * Ошибка IPC для человека: preload новый, а main старый — «No handler registered» → «перезапустите».
 * Старый main отказывает в возврате при живом координаторе («ещё завершается») — объясняем, как обойти.
 */
export function reviewErrorMessage(message: string): string {
  if (/No handler registered for 'globalTasks:(accept|returnToWork)'/.test(message)) return STALE_REVIEW_MESSAGE
  if (/координатор этой глобальной задачи ещё завершается/.test(message)) return STALE_RETURN_LIVE_MESSAGE
  return message
}
