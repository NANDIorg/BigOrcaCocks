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
  /** «Вернуть в работу…»: с «Проверки» в работу с уточнением и повторным запуском координатора. */
  returnToWork: boolean
  /**
   * Почему «Вернуть в работу…» сейчас недоступна (кнопка видна, но выключена). Координатор ещё жив —
   * окно в несколько секунд после `runs finish`, пока приложение не закрыло его терминал; main откажет.
   */
  returnBlocked?: string
}

export const RETURN_BLOCKED_LIVE = 'Координатор ещё завершается — повторите через несколько секунд'

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
    ...(review && live ? { returnBlocked: RETURN_BLOCKED_LIVE } : {})
  }
}

/** История уточнений для показа: новые сверху. У задачи без возвратов — пусто. */
export function returnsNewestFirst(g: { returns?: GlobalTaskReturn[] }): GlobalTaskReturn[] {
  return [...(g.returns ?? [])].sort((a, b) => b.at - a.at)
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

/** Ошибка IPC для человека: preload новый, а main старый — «No handler registered» → «перезапустите». */
export function reviewErrorMessage(message: string): string {
  return /No handler registered for 'globalTasks:(accept|returnToWork)'/.test(message) ? STALE_REVIEW_MESSAGE : message
}
