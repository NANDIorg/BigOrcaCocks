import type { ColumnKind, GlobalTaskReturn } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { t } from './i18n'

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
  return { accept: (id) => accept(id), returnToWork: (id, text, cols, rows) => returnToWork(id, text, cols, rows) }
}

/** Старый main отказал в возврате при живом координаторе — как обойти, на текущем языке. */
export function staleReturnLiveMessage(): string {
  return t('global.stale.returnLive')
}

/**
 * Ошибка IPC для человека: preload новый, а main старый — «No handler registered» → «перезапустите».
 * Старый main отказывает в возврате при живом координаторе («ещё завершается») — объясняем, как обойти. Текст ошибки
 * main не переводится (main пишет по-русски), поэтому сверяем с ним как есть.
 */
export function reviewErrorMessage(message: string): string {
  if (/No handler registered for 'globalTasks:(accept|returnToWork)'/.test(message)) return staleReviewMessage()
  if (/координатор этой глобальной задачи ещё завершается/.test(message)) return staleReturnLiveMessage()
  return message
}
