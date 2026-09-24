import type React from 'react'
import type { StatsUsage } from '@orca-board/core'
import { costCell, formatTokens } from './statsFormat'

export const NO_DATA_TITLE = 'Нет данных о токенах: агент не пишет транскрипт, транскрипт удалён или сессия от версии до статистики'

/** «нет данных» вместо нуля — неизвестное не выдаём за ноль (docs, «Неизвестно ≠ 0»). */
export function NoData({ title = NO_DATA_TITLE }: { title?: string }): React.JSX.Element {
  return <span className="stats-unknown" title={title}>нет данных</span>
}

/** Стоимость среза в ячейке: сумма (с «+?» — часть токенов без цены), «без цены» или «нет данных». */
export function Cost({ usage }: { usage: StatsUsage }): React.JSX.Element {
  const c = costCell(usage)
  if (c.kind === 'unknown') return <NoData />
  if (c.kind === 'unpriced') return <span className="chip warn stats-chip" title={`Модели нет в таблице цен: ${usage.unpricedModels.join(', ')}`}>без цены</span>
  return (
    <>
      {c.text}
      {c.atLeast && <span className="stats-hint" title={`Не менее: ${formatTokens(usage.unpricedTokens)} токенов моделей без цены не оценены`}> +?</span>}
    </>
  )
}
