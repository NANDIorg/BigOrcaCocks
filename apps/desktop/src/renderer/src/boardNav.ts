/**
 * Клавиатура локальной доски: перемещение фокуса по карточкам и выбор в меню «Переместить в…».
 * Чистые функции — сам фокус и DOM остаются в `Board.tsx` / `MoveMenu.tsx`.
 */

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

/**
 * Куда перевести фокус со стрелки: `grid` — id карточек по колонкам слева направо (сверху вниз внутри колонки).
 * Вверх/вниз — по колонке, у края остаёмся на месте. Влево/вправо — в соседнюю непустую колонку на ту же строку
 * (или на последнюю, если там карточек меньше). Текущей карточки нет в сетке — первая карточка. Пусто — undefined.
 */
export function moveFocus(grid: readonly (readonly string[])[], current: string | undefined, key: ArrowKey): string | undefined {
  const cols = grid.filter((c) => c.length > 0)
  if (cols.length === 0) return undefined
  const col = current === undefined ? -1 : cols.findIndex((c) => c.includes(current))
  if (col === -1) return cols[0]![0]
  const row = cols[col]!.indexOf(current!)
  if (key === 'ArrowUp') return cols[col]![Math.max(row - 1, 0)]
  if (key === 'ArrowDown') return cols[col]![Math.min(row + 1, cols[col]!.length - 1)]
  const next = cols[key === 'ArrowLeft' ? col - 1 : col + 1]
  if (!next) return current
  return next[Math.min(row, next.length - 1)]
}

/** Элемент, где печатают: горячие клавиши доски в нём не срабатывают. */
export interface KeyTarget {
  tagName: string
  isContentEditable?: boolean
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isEditableTarget(el: KeyTarget | null | undefined): boolean {
  return !!el && (EDITABLE_TAGS.has(el.tagName.toUpperCase()) || el.isContentEditable === true)
}

/** Пункт меню по клавише: цифра 1–9 — номер пункта, иначе undefined. Отключённые пункты не выбираются. */
export function menuIndexForKey(key: string, items: readonly { disabled?: boolean }[]): number | undefined {
  if (!/^[1-9]$/.test(key)) return undefined
  const i = Number(key) - 1
  return i < items.length && !items[i]!.disabled ? i : undefined
}

/** Следующий доступный пункт меню в направлении `dir` (с переходом через край); доступных нет — -1. */
export function stepMenu(items: readonly { disabled?: boolean }[], from: number, dir: 1 | -1): number {
  const n = items.length
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n
    if (!items[i]!.disabled) return i
  }
  return -1
}
