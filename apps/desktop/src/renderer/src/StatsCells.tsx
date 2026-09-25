import type React from 'react'
import { Fragment } from 'react'
import type { StatsUsage } from '@orca-board/core'
import { costCell, formatTokens } from './statsFormat'
import { useT } from './i18n'
import { richParts } from './globalFormat'

/** «нет данных» вместо нуля — неизвестное не выдаём за ноль (docs, «Неизвестно ≠ 0»). */
export function NoData({ title }: { title?: string }): React.JSX.Element {
  const t = useT()
  return <span className="stats-unknown" title={title ?? t('global.stats.noDataTitle')}>{t('global.stats.noData')}</span>
}

/** Стоимость среза в ячейке: сумма (с «+?» — часть токенов без цены), «без цены» или «нет данных». */
export function Cost({ usage }: { usage: StatsUsage }): React.JSX.Element {
  const t = useT()
  const c = costCell(usage)
  if (c.kind === 'unknown') return <NoData />
  if (c.kind === 'unpriced') {
    return <span className="chip warn stats-chip" title={t('global.stats.unpricedTitle', { models: usage.unpricedModels.join(', ') })}>{t('global.stats.unpriced')}</span>
  }
  return (
    <>
      {c.text}
      {c.atLeast && <span className="stats-hint" title={t('global.stats.atLeastTitle', { tokens: formatTokens(usage.unpricedTokens) })}> +?</span>}
    </>
  )
}

/**
 * Переведённая строка с элементами внутри: `<Rich text={t('global.stats.avgActive')} slots={{ time: <b>…</b> }} />`.
 * Параметры `{name}` без значения `t()` оставляет в тексте — здесь они заменяются элементами (`richParts`).
 */
export function Rich({ text, slots }: { text: string; slots: Record<string, React.ReactNode> }): React.JSX.Element {
  return <>{richParts(text).map((p, i) => ('slot' in p ? <Fragment key={i}>{slots[p.slot] ?? `{${p.slot}}`}</Fragment> : p.text))}</>
}
