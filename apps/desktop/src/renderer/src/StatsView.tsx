import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardColumn, ProjectStats, StatsRange, StatsRow, StatsUsage } from '@orca-board/core'
import { Icon } from './icons'
import { Cost, NoData, Rich } from './StatsCells'
import { useT } from './i18n'
import { formatDateTime } from './i18n/format'
import { ipcErrorMessage } from './useAutoSave'
import {
  CHART_METRICS,
  RANGE_OPTIONS,
  axisLabelBudget,
  axisLabelIndexes,
  buildChart,
  chartMetrics,
  effectiveMetric,
  formatAgentTime,
  formatAxis,
  formatMetric,
  formatTokens,
  formatUsd,
  hasUsage,
  isEmptyStats,
  isStaleStatsError,
  metricLabel,
  missingLabel,
  missingSessions,
  rangeLabel,
  rangePhrase,
  seriesColor,
  sessionsLabel,
  shareItems,
  statsApi,
  statsStaleMessage,
  statusParts,
  taskCost,
  tokenBreakdown,
  totalTokens,
  type ChartMetric
} from './statsFormat'

const RANGE_KEY = 'orca.stats.range'
const METRIC_KEY = 'orca.stats.metric'

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage недоступен — выбор просто не переживёт перезапуск
  }
}

/**
 * Вкладка проекта «Статистика» (вариант B): дашборд по `ProjectStats`. Данные — один запрос при открытии и
 * смене периода, по событиям не обновляются (docs/architecture.md → «Статистика → Интерфейс»).
 */
export function StatsView({ projectId, columns }: { projectId: string; columns: BoardColumn[] }): React.JSX.Element {
  const t = useT()
  const [range, setRange] = useState<StatsRange>(() => stored(RANGE_KEY, ['7d', '30d', 'all'], '30d'))
  const [metric, setMetric] = useState<ChartMetric>(() => stored(METRIC_KEY, ['cost', 'tokens', 'time', 'done'], 'cost'))
  const [stats, setStats] = useState<ProjectStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Номер последнего запроса: ответ на устаревший (сменили период или проект) не затирает свежий. */
  const req = useRef(0)

  const load = useCallback(async () => {
    const id = ++req.current
    setLoading(true)
    setError(null)
    try {
      const s = await statsApi(window.orca).project(projectId, range)
      if (id === req.current) setStats(s)
    } catch (e) {
      if (id !== req.current) return
      const msg = ipcErrorMessage(e)
      setError(isStaleStatsError(msg) ? statsStaleMessage() : msg)
    } finally {
      if (id === req.current) setLoading(false)
    }
  }, [projectId, range])

  useEffect(() => {
    // Данные другого проекта не показываем даже на время загрузки.
    setStats((s) => (s && s.projectId === projectId ? s : null))
    void load()
  }, [load, projectId])

  function pickRange(r: StatsRange): void {
    setRange(r)
    store(RANGE_KEY, r)
  }

  function pickMetric(m: ChartMetric): void {
    setMetric(m)
    store(METRIC_KEY, m)
  }

  const period = (
    <div className="stats-period" role="radiogroup" aria-label={t('global.stats.period')}>
      {RANGE_OPTIONS.map((r) => (
        <button key={r} role="radio" aria-checked={range === r} className={range === r ? 'on' : ''} onClick={() => pickRange(r)}>
          {rangeLabel(r)}
        </button>
      ))}
    </div>
  )

  const shown = stats && stats.range === range ? stats : null
  const updated = shown && formatDateTime(shown.generatedAt, { hour: '2-digit', minute: '2-digit' })

  let body: React.JSX.Element
  if (error && !shown) {
    body = (
      <div className="stats-state">
        <b>{t('global.stats.error')}</b>
        <span className="stats-error">{error}</span>
        {!isStaleStatsError(error) && <button className="btn-sm" onClick={() => void load()}>{t('global.retry')}</button>}
      </div>
    )
  } else if (!shown) {
    body = <div className="stats-state"><span className="stats-muted">{t('global.stats.loading')}</span></div>
  } else if (isEmptyStats(shown)) {
    body = (
      <div className="stats-state">
        <svg className="stats-state-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
        <b>{range === 'all' ? t('global.stats.emptyAll') : t('global.stats.emptyRange', { range: rangePhrase(range) })}</b>
        <span>{t('global.stats.emptyHint')}{range !== 'all' && ` ${t('global.stats.pickLonger')}`}</span>
      </div>
    )
  } else {
    body = <Dashboard stats={shown} columns={columns} metric={metric} onMetric={pickMetric} />
  }

  return (
    <div className="stats-page">
      <div className={`stats-dash ${loading && shown ? 'refreshing' : ''}`}>
        <div className="stats-top">
          <span className="stats-muted">
            {updated ? t('global.stats.updated', { time: updated }) : t('global.stats.source')}
          </span>
          <span className="grow" />
          {error && shown && <span className="stats-error" title={error}>{t('global.stats.refreshError')}</span>}
          <button className="icon-btn stats-refresh" title={t('global.stats.refresh')} aria-label={t('global.stats.refresh')} onClick={() => void load()} disabled={loading}>
            <Icon.refresh />
          </button>
          {period}
        </div>
        {body}
      </div>
    </div>
  )
}

function Dashboard({ stats, columns, metric, onMetric }: { stats: ProjectStats; columns: BoardColumn[]; metric: ChartMetric; onMetric: (m: ChartMetric) => void }): React.JSX.Element {
  const t = useT()
  const usage = hasUsage(stats)
  const tot = stats.totals
  const tokens = totalTokens(tot.tokens)
  const perTask = taskCost(stats)
  const missing = missingSessions(tot)
  const m = effectiveMetric(metric, usage)
  const allowed = chartMetrics(usage)

  return (
    <>
      <section className="stats-panel">
        <div className="stats-hero">
          <div className="stats-big">
            <span className="stats-muted">{t('global.stats.spent', { range: rangePhrase(stats.range) })}</span>
            <span className="stats-big-value">
              {tot.costUsd !== undefined ? (
                <>{tot.unpricedTokens > 0 && <small>{t('global.stats.atLeast')} </small>}{formatUsd(tot.costUsd)}</>
              ) : (
                <NoData />
              )}
            </span>
            <span className="stats-hint">
              {!usage
                ? t('global.stats.noUsage', { sessions: sessionsLabel(tot.sessions) })
                : tot.costUsd === undefined
                  ? t('global.stats.noPrice', { models: tot.unpricedModels.join(', ') })
                  : missing > 0
                    ? missingLabel(missing)
                    : t('global.stats.allKnown', { sessions: sessionsLabel(tot.sessions) })}
            </span>
            <div className="stats-facts">
              <div title={tot.tokens && tokenBreakdown(tot.tokens)}>
                <span>{t('global.stats.tokens')}</span>
                <b>{tokens !== undefined ? formatTokens(tokens) : <NoData />}</b>
                {tot.tokens && (
                  <em>{t('global.stats.tokensSub', { output: formatTokens(tot.tokens.output), pct: tokens ? Math.round((tot.tokens.cacheRead / tokens) * 100) : 0 })}</em>
                )}
              </div>
              <div>
                <span>{t('global.stats.agentTime')}</span>
                <b>{formatAgentTime(tot.agentMs)}</b>
                <em>{sessionsLabel(tot.sessions)}</em>
              </div>
              <div>
                <span>{t('global.stats.tasksDone')}</span>
                <b>{stats.tasks.done}</b>
                <em>{t('global.stats.ofBoard', { total: stats.tasks.total })}</em>
              </div>
              <div>
                <span>{t('global.stats.taskCost')}</span>
                <b>{perTask !== undefined ? formatUsd(perTask) : <NoData title={t('global.stats.taskCostNone')} />}</b>
                {stats.taskTime.avgActiveMs !== undefined && <em>{t('global.stats.inWork', { time: formatAgentTime(stats.taskTime.avgActiveMs) })}</em>}
              </div>
            </div>
          </div>
          <div className="stats-chart-box">
            <div className="stats-chart-head">
              <span className="stats-muted grow">{stats.range === 'all' ? t('global.stats.allTime') : t('global.stats.byDay')}</span>
              <div className="stats-subtabs" role="tablist" aria-label={t('global.stats.metricAria')}>
                {CHART_METRICS.filter((x) => allowed.includes(x)).map((x) => (
                  <button key={x} role="tab" aria-selected={m === x} className={m === x ? 'on' : ''} onClick={() => onMetric(x)}>
                    {metricLabel(x)}
                  </button>
                ))}
              </div>
            </div>
            <DayChart stats={stats} metric={m} />
          </div>
        </div>
      </section>

      <UnknownNotice stats={stats} />

      <div className="stats-grid3">
        <section className="stats-panel">
          <h3>{t('global.stats.models')}</h3>
          <ShareList rows={stats.byModel} byCost={usage} colorRows={stats.byModel} empty={t('global.stats.modelsEmpty')} />
        </section>
        <section className="stats-panel">
          <h3>{t('global.stats.roles')}</h3>
          <ShareList rows={stats.byRole} byCost={usage} colorRows={stats.byRole} empty={t('global.stats.rolesEmpty')} />
        </section>
        <section className="stats-panel">
          <h3>{t('global.stats.board')}</h3>
          <BoardBlock stats={stats} columns={columns} />
        </section>
      </div>

      <div className="stats-grid2">
        <section className="stats-panel">
          <h3>{t('global.stats.topGlobal')}</h3>
          <TopTable rows={stats.byGlobalTask} head={t('global.stats.topGlobalHead')} usage={usage} />
        </section>
        <section className="stats-panel">
          <h3>{t('global.stats.topTasks')}</h3>
          <TopTable rows={stats.byTask} head={t('global.stats.topTasksHead')} usage={usage} />
        </section>
      </div>
    </>
  )
}

/** Сколько «неизвестного» в итоге: сессии без токенов и модели без цены. Всё известно — блока нет. */
function UnknownNotice({ stats }: { stats: ProjectStats }): React.JSX.Element | null {
  const t = useT()
  const tot = stats.totals
  const missing = missingSessions(tot)
  if (missing === 0 && tot.unpricedModels.length === 0) return null
  return (
    <div className="stats-notice" role="note">
      <Icon.info />
      <div>
        {missing > 0 && (
          <p>
            <b>{t('global.stats.missingTitle', { missing, sessions: sessionsLabel(tot.sessions) })}</b> {t('global.stats.missingText')}
          </p>
        )}
        {tot.unpricedModels.length > 0 && (
          <p>
            <b>{t('global.stats.noPriceModel', { count: tot.unpricedModels.length, models: tot.unpricedModels.join(', ') })}</b>
            {' — '}{t('global.stats.noPriceTokens', { tokens: formatTokens(tot.unpricedTokens) })}{' '}
            <Rich text={t('global.stats.pricesAt')} slots={{ table: <code>MODEL_PRICES</code>, file: <code>packages/core/src/pricing.ts</code> }} />
          </p>
        )}
      </div>
    </div>
  )
}

const CH = { W: 640, H: 190, pl: 52, pr: 8, pt: 8, pb: 22 }

/**
 * Ширина контейнера графика. viewBox совпадает с ней в px, чтобы подписи осей оставались 11px:
 * при фиксированном viewBox и width: 100% SVG ужимался целиком и на узком окне текст становился нечитаемым.
 */
function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => { if (el.clientWidth > 0) setWidth(el.clientWidth) }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/** Столбики по периоду простым SVG: стоимость — стопкой по моделям, остальное — одной серией. */
function DayChart({ stats, metric }: { stats: ProjectStats; metric: ChartMetric }): React.JSX.Element {
  const t = useT()
  const [hover, setHover] = useState<number | null>(null)
  const chart = buildChart(stats, metric)
  const [boxRef, W] = useWidth(CH.W)
  const { H, pl, pr, pt, pb } = CH
  const n = chart.columns.length
  const slot = (W - pl - pr) / n
  const bw = Math.max(3, Math.min(22, slot - (slot > 8 ? 6 : 1)))
  const y = (v: number): number => pt + (H - pt - pb) * (1 - v / chart.top)
  const ticks: number[] = []
  for (let v = 0; v <= chart.top + chart.step / 1000; v += chart.step) ticks.push(v)
  const labels = new Set(axisLabelIndexes(n, axisLabelBudget(n, W - pl - pr)))
  const color = (key: string): string => (metric === 'cost' ? seriesColor(stats.byModel, key) : 'var(--accent)')
  const hovered = hover === null ? null : chart.columns[hover]
  const legend = metric === 'cost' ? stats.byModel.filter((r) => chart.columns.some((c) => c.segments.some((s) => s.key === r.key))) : []

  return (
    <div className="stats-chart" ref={boxRef} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t(`global.stats.chart.${chart.bucket}`, { metric: metricLabel(metric) })}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} />
            <text className="ax" x={pl - 6} y={y(v) + 4} textAnchor="end">{formatAxis(v, metric)}</text>
          </g>
        ))}
        {chart.columns.map((c, i) => {
          const x = pl + i * slot + (slot - bw) / 2
          let acc = 0
          return (
            <g key={c.date} className={`day ${hover === i ? 'on' : ''}`} onMouseEnter={() => setHover(i)}>
              <rect className="hit" x={pl + i * slot} y={pt} width={slot} height={H - pt - pb} />
              {c.segments.map((s, j) => {
                const y0 = y(acc)
                acc += s.value
                const h = Math.max(0, y0 - y(acc) - (j > 0 ? 1 : 0))
                if (h <= 0) return null
                const last = j === c.segments.length - 1
                return last ? (
                  <path key={s.key || j} className="bar" fill={color(s.key)} d={roundTop(x, y0 - (j > 0 ? 1 : 0) - h, bw, h)} />
                ) : (
                  <rect key={s.key || j} className="bar" fill={color(s.key)} x={x} y={y0 - (j > 0 ? 1 : 0) - h} width={bw} height={h} />
                )
              })}
              {labels.has(i) && <text className="ax" x={x + bw / 2} y={H - 6} textAnchor="middle">{c.label}</text>}
            </g>
          )
        })}
        <line className="base" x1={pl} x2={W - pr} y1={y(0)} y2={y(0)} />
      </svg>
      {hovered && hover !== null && (
        <div className={`stats-tip ${hover > n / 2 ? 'left' : ''}`} style={{ left: `${((pl + (hover + 0.5) * slot) / W) * 100}%` }}>
          <b>{hovered.title}</b>
          {!hovered.active ? (
            <span className="stats-muted">{t('global.stats.noActivity')}</span>
          ) : (
            <>
              {metric === 'cost' && hovered.segments.map((s) => (
                <div className="r" key={s.key}>
                  <span><i className="swatch" style={{ background: color(s.key) }} />{stats.byModel.find((r) => r.key === s.key)?.title ?? s.key}</span>
                  <span>{formatUsd(s.value)}</span>
                </div>
              ))}
              <div className="r"><span>{metricLabel(metric)}</span><span>{formatMetric(hovered.total, metric)}</span></div>
              {metric !== 'done' && <div className="r"><span>{t('global.stats.tasksDone')}</span><span>{hovered.days.reduce((a, d) => a + d.tasksDone, 0)}</span></div>}
            </>
          )}
        </div>
      )}
      {legend.length > 0 && (
        <div className="stats-legend">
          {legend.map((r) => (
            <span key={r.key}><i className="swatch" style={{ background: seriesColor(stats.byModel, r.key) }} /><span className={r.key === 'unknown' ? 'stats-unknown' : ''}>{r.title}</span></span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Прямоугольник со скруглённым верхом — верхний сегмент столбца. */
function roundTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/** Блок долей «Модели» / «Роли»: первые 5 строк, полоса — стоимость, без токенов — время агентов. */
function ShareList({ rows, byCost, colorRows, empty }: { rows: StatsRow[]; byCost: boolean; colorRows: StatsRow[]; empty: string }): React.JSX.Element {
  const t = useT()
  const items = shareItems(rows, byCost)
  if (items.length === 0) return <div className="stats-muted">{empty}</div>
  return (
    <div className="stats-split">
      {items.map(({ row, share }) => (
        <div className="it" key={row.key}>
          <div className="n">
            <i className="swatch" style={{ background: seriesColor(colorRows, row.key) }} />
            <span className={`x ${row.key === 'unknown' ? 'stats-unknown' : ''}`} title={row.title}>{row.title}</span>
          </div>
          <b>{byCost ? <Cost usage={row} /> : formatAgentTime(row.agentMs)}</b>
          <div className="stats-share" aria-hidden="true"><i style={{ width: `${Math.max(2, share * 100)}%`, background: seriesColor(colorRows, row.key) }} /></div>
        </div>
      ))}
      {rows.length > items.length && <span className="stats-hint">{t('global.stats.more', { count: rows.length - items.length })}</span>}
    </div>
  )
}

function BoardBlock({ stats, columns }: { stats: ProjectStats; columns: BoardColumn[] }): React.JSX.Element {
  const t = useT()
  const parts = statusParts(stats.tasks.byStatus, columns)
  const total = parts.reduce((a, p) => a + p.count, 0)
  const d = stats.dispatches
  const tt = stats.taskTime
  return (
    <>
      {total > 0 && (
        <div className="stats-stackbar" role="img" aria-label={t('global.stats.boardAria')}>
          {parts.filter((p) => p.count > 0).map((p) => <i key={p.id || 'other'} title={`${p.title}: ${p.count}`} style={{ width: `${(p.count / total) * 100}%`, background: p.color }} />)}
        </div>
      )}
      <div className="stats-cols-legend">
        {parts.map((p) => (
          <span key={p.id || 'other'}><i className="swatch" style={{ background: p.color }} /><span className="x" title={p.title}>{p.title}</span><b>{p.count}</b></span>
        ))}
      </div>
      <div className="stats-hint">
        {t('global.stats.runs', { count: d.total })}
        {stats.coordinatorLaunches > 0 && ` · ${t('global.stats.coordLaunches', { count: stats.coordinatorLaunches })}`}
      </div>
      {d.total > 0 && (
        <div className="stats-chips">
          <span className="chip ok stats-chip">{t('global.stats.runDone', { count: d.done })}</span>
          {d.failed > 0 && <span className="chip warn stats-chip">{t('global.stats.runFailed', { count: d.failed })}</span>}
          {d.unknown > 0 && <span className="chip stats-chip" title={t('global.stats.runUnknownTitle')}>{t('global.stats.runUnknown', { count: d.unknown })}</span>}
          {d.running > 0 && <span className="chip live stats-chip">{t('global.stats.runRunning', { count: d.running })}</span>}
        </div>
      )}
      <div className="stats-muted">
        {tt.samples > 0 ? (
          <>
            {tt.avgActiveMs !== undefined && <Rich text={t('global.stats.avgActive')} slots={{ time: <b>{formatAgentTime(tt.avgActiveMs)}</b> }} />}
            {tt.avgActiveMs !== undefined && tt.avgLeadMs !== undefined && ', '}
            {tt.avgLeadMs !== undefined && <Rich text={t('global.stats.avgLead')} slots={{ time: <b>{formatAgentTime(tt.avgLeadMs)}</b> }} />}
            {` ${t('global.stats.samples', { count: tt.samples })}`}
          </>
        ) : (
          t('global.stats.taskTimeNone')
        )}
      </div>
      <div className="stats-muted">
        <Rich text={t('global.stats.globals')} slots={{ total: <b>{stats.globalTasks.total}</b>, done: <b>{stats.globalTasks.done}</b> }} />
      </div>
    </>
  )
}

const TOP_ROWS = 8

/** Топ по стоимости (main уже отсортировал): задача, стоимость, время агентов, доля. Без токенов — только время. */
function TopTable({ rows, head, usage }: { rows: StatsRow[]; head: string; usage: boolean }): React.JSX.Element {
  const t = useT()
  if (rows.length === 0) return <div className="stats-muted">{t('global.stats.topEmpty')}</div>
  const items = shareItems(rows, usage, TOP_ROWS)
  return (
    <div className="stats-tbl-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>{head}</th>
            {usage && <th className="r">{t('global.stats.cost')}</th>}
            <th className="r">{t('global.stats.agentTime')}</th>
            <th className="share-col" title={t(usage ? 'global.stats.shareCost' : 'global.stats.shareTime')}>{t('global.stats.share')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ row, share }) => (
            <tr key={row.key}>
              <td className="t"><span className="x" title={row.title}>{row.title}</span></td>
              {usage && (
                <td className="r">
                  <Cost usage={row} />
                  {row.sessionsWithUsage > 0 && row.sessionsWithUsage < row.sessions && (
                    <span className="stats-hint stats-sess" title={t('global.stats.sessionsWithUsage')}> ({row.sessionsWithUsage}/{row.sessions})</span>
                  )}
                </td>
              )}
              <td className="r">{formatAgentTime(row.agentMs)}</td>
              <td className="share-col"><div className="stats-share" aria-hidden="true"><i style={{ width: `${Math.max(2, share * 100)}%` }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > items.length && <span className="stats-hint">{t('global.stats.more', { count: rows.length - items.length })}</span>}
    </div>
  )
}
