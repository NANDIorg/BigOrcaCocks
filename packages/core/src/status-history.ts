/**
 * История статусов задач и глобальных задач (docs/architecture.md, «История статусов»). Чистые функции без
 * Node: их использует store, а тип записи — renderer.
 */
import type { StatusChange, StatusSource, TaskStatus } from './types.ts'

/** Сколько последних переходов хранится: снапшот доски пишется на диск целиком при каждом commit. */
export const STATUS_HISTORY_LIMIT = 200

let current: StatusSource | undefined

/**
 * Выполнить `fn`, записывая переходы от имени `source`. Store не знает, кто его вызвал, — источник задаёт
 * вызывающий код: IPC renderer (human), сокет (cli/worker), исполнитель воркфлоу (workflow). Вложенный вызов
 * перекрывает внешний. Действует только синхронная часть `fn`: смены статуса после `await` уже идут как `app`.
 * Одна переменная на процесс, а не на store: вызывающему коду не нужно знать, какой store тронет вызов.
 */
export function withStatusSource<T>(source: StatusSource, fn: () => T): T {
  const prev = current
  current = source
  try {
    return fn()
  } finally {
    current = prev
  }
}

/** Источник текущего перехода; вне `withStatusSource` — само приложение. */
export function statusSource(): StatusSource {
  return current ?? 'app'
}

/**
 * Дописать переход в историю `entity`, если статус сменился (подряд одинаковых записей нет), и обрезать
 * историю до `STATUS_HISTORY_LIMIT` последних. Возвращает true, если запись добавлена.
 */
export function recordStatus(
  entity: { statusHistory?: StatusChange[] },
  status: TaskStatus,
  at: number,
  opts: { by?: StatusSource; stage?: string } = {}
): boolean {
  const history = entity.statusHistory ?? []
  if (history[history.length - 1]?.status === status) return false
  history.push({ status, at, by: opts.by ?? statusSource(), ...(opts.stage !== undefined ? { stage: opts.stage } : {}) })
  if (history.length > STATUS_HISTORY_LIMIT) history.splice(0, history.length - STATUS_HISTORY_LIMIT)
  entity.statusHistory = history
  return true
}
