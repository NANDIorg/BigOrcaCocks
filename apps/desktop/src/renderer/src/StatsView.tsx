import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardColumn, ProjectStats, StatsRange, StatsRow, StatsUsage } from '@orca-board/core'
import { Icon } from './icons'
import { Cost, NoData } from './StatsCells'
import { ipcErrorMessage } from './useAutoSave'
import {
  CHART_METRICS,
  RANGE_OPTIONS,
  STATS_STALE_MESSAGE,
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
  missingLabel,
  missingSessions,
  rangePhrase,
  seriesColor,
  sessionsLabel,
  shareItems,
  statsApi,
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
      setError(isStaleStatsError(msg) ? STATS_STALE_MESSAGE : msg)
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
    <div className="stats-period" role="radiogroup" aria-label="Период">
      {RANGE_OPTIONS.map((o) => (
        <button key={o.value} role="radio" aria-checked={range === o.value} className={range === o.value ? 'on' : ''} onClick={() => pickRange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )

  const shown = stats && stats.range === range ? stats : null
  const updated = shown && new Date(shown.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

  let body: React.JSX.Element
  if (error && !shown) {
    body = (
      <div className="stats-state">
        <b>Не удалось посчитать статистику</b>
        <span className="stats-error">{error}</span>
        {error !== STATS_STALE_MESSAGE && <button className="btn-sm" onClick={() => void load()}>Повторить</button>}
      </div>
    )
  } else if (!shown) {
    body = <div className="stats-state"><span className="stats-muted">Считаем статистику…</span></div>
  } else if (isEmptyStats(shown)) {
    body = (
      <div className="stats-state">
        <svg className="stats-state-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
        <b>{range === 'all' ? 'Статистики пока нет' : `За ${rangePhrase(range)} агенты не запускались`}</b>
        <span>Статистика появится после первого прогона координатора или воркера.{range !== 'all' && ' Выберите период побольше.'}</span>
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
            {updated ? `Обновлено в ${updated} · считается по запросу, не хранится` : 'Токены и стоимость — из транскриптов агентов, время и задачи — из доски'}
          </span>
          <span className="grow" />
          {error && shown && <span className="stats-error" title={error}>Не удалось обновить</span>}
          <button className="icon-btn stats-refresh" title="Пересчитать" aria-label="Пересчитать" onClick={() => void load()} disabled={loading}>
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
  const usage = hasUsage(stats)
  const t = stats.totals
  const tokens = totalTokens(t.tokens)
  const perTask = taskCost(stats)
  const missing = missingSessions(t)
  const m = effectiveMetric(metric, usage)
  const allowed = chartMetrics(usage)

  return (
    <>
      <section className="stats-panel">
        <div className="stats-hero">
          <div className="stats-big">
            <span className="stats-muted">Потрачено за {rangePhrase(stats.range)}</span>
            <span className="stats-big-value">
              {t.costUsd !== undefined ? (
                <>{t.unpricedTokens > 0 && <small>не менее </small>}{formatUsd(t.costUsd)}</>
              ) : (
                <NoData />
              )}
            </span>
            <span className="stats-hint">
              {!usage
                ? `${sessionsLabel(t.sessions)} без данных о токенах`
                : t.costUsd === undefined
                  ? `у моделей нет цены: ${t.unpricedModels.join(', ')}`
                  : missing > 0
                    ? missingLabel(missing)
                    : `${sessionsLabel(t.sessions)}, у всех есть данные`}
            </span>
            <div className="stats-facts">
              <div title={t.tokens && tokenBreakdown(t.tokens)}>
                <span>Токены</span>
                <b>{tokens !== undefined ? formatTokens(tokens) : <NoData />}</b>
                {t.tokens && <em>ответ {formatTokens(t.tokens.output)} · из кэша {tokens ? Math.round((t.tokens.cacheRead / tokens) * 100) : 0}%</em>}
              </div>
              <div>
                <span>Время агентов</span>
                <b>{formatAgentTime(t.agentMs)}</b>
                <em>{sessionsLabel(t.sessions)}</em>
              </div>
              <div>
                <span>Задач завершено</span>
                <b>{stats.tasks.done}</b>
                <em>из {stats.tasks.total} на доске</em>
              </div>
              <div>
                <span>Цена задачи</span>
                <b>{perTask !== undefined ? formatUsd(perTask) : <NoData title="Нет стоимости или ни одной завершённой задачи за период" />}</b>
                {stats.taskTime.avgActiveMs !== undefined && <em>в работе ~{formatAgentTime(stats.taskTime.avgActiveMs)}</em>}
              </div>
            </div>
          </div>
          <div className="stats-chart-box">
            <div className="stats-chart-head">
              <span className="stats-muted grow">{stats.range === 'all' ? 'За всё время' : 'По дням'}</span>
              <div className="stats-subtabs" role="tablist" aria-label="Метрика графика">
                {CHART_METRICS.filter((x) => allowed.includes(x.value)).map((x) => (
                  <button key={x.value} role="tab" aria-selected={m === x.value} className={m === x.value ? 'on' : ''} onClick={() => onMetric(x.value)}>
                    {x.label}
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
          <h3>Модели</h3>
          <ShareList rows={stats.byModel} byCost={usage} colorRows={stats.byModel} empty="Нет данных о моделях" />
        </section>
        <section className="stats-panel">
          <h3>Роли</h3>
          <ShareList rows={stats.byRole} byCost={usage} colorRows={stats.byRole} empty="Агенты не запускались" />
        </section>
        <section className="stats-panel">
          <h3>Задачи на доске</h3>
          <BoardBlock stats={stats} columns={columns} />
        </section>
      </div>

      <div className="stats-grid2">
        <section className="stats-panel">
          <h3>Самые дорогие глобальные задачи</h3>
          <TopTable rows={stats.byGlobalTask} head="Глобальная задача" usage={usage} />
        </section>
        <section className="stats-panel">
          <h3>Самые дорогие задачи</h3>
          <TopTable rows={stats.byTask} head="Задача" usage={usage} />
        </section>
      </div>
    </>
  )
}

/** Сколько «неизвестного» в итоге: сессии без токенов и модели без цены. Всё известно — блока нет. */
function UnknownNotice({ stats }: { stats: ProjectStats }): React.JSX.Element | null {
  const t = stats.totals
  const missing = missingSessions(t)
  if (missing === 0 && t.unpricedModels.length === 0) return null
  return (
    <div className="stats-notice" role="note">
      <Icon.info />
      <div>
        {missing > 0 && (
          <p>
            <b>Нет данных о токенах по {missing} из {sessionsLabel(t.sessions)}.</b> Агент не пишет транскрипт с токенами,
            транскрипт удалён или сессия запущена до появления статистики. В итоги они входят временем, но не токенами и стоимостью.
          </p>
        )}
        {t.unpricedModels.length > 0 && (
          <p>
            <b>Нет цены для {t.unpricedModels.length > 1 ? 'моделей' : 'модели'} {t.unpricedModels.join(', ')}</b> — {formatTokens(t.unpricedTokens)} токенов
            не вошли в стоимость. Цены — таблица <code>MODEL_PRICES</code> в <code>packages/core/src/pricing.ts</code>.
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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${CHART_METRICS.find((x) => x.value === metric)?.label ?? ''} по ${chart.bucket === 'day' ? 'дням' : chart.bucket === 'week' ? 'неделям' : 'месяцам'}`}>
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
            <span className="stats-muted">нет активности</span>
          ) : (
            <>
              {metric === 'cost' && hovered.segments.map((s) => (
                <div className="r" key={s.key}>
                  <span><i className="swatch" style={{ background: color(s.key) }} />{stats.byModel.find((r) => r.key === s.key)?.title ?? s.key}</span>
                  <span>{formatUsd(s.value)}</span>
                </div>
              ))}
              <div className="r"><span>{CHART_METRICS.find((x) => x.value === metric)?.label}</span><span>{formatMetric(hovered.total, metric)}</span></div>
              {metric !== 'done' && <div className="r"><span>Задач завершено</span><span>{hovered.days.reduce((a, d) => a + d.tasksDone, 0)}</span></div>}
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
      {rows.length > items.length && <span className="stats-hint">и ещё {rows.length - items.length}</span>}
    </div>
  )
}

function BoardBlock({ stats, columns }: { stats: ProjectStats; columns: BoardColumn[] }): React.JSX.Element {
  const parts = statusParts(stats.tasks.byStatus, columns)
  const total = parts.reduce((a, p) => a + p.count, 0)
  const d = stats.dispatches
  const tt = stats.taskTime
  return (
    <>
      {total > 0 && (
        <div className="stats-stackbar" role="img" aria-label="Задачи по колонкам">
          {parts.filter((p) => p.count > 0).map((p) => <i key={p.id || 'other'} title={`${p.title}: ${p.count}`} style={{ width: `${(p.count / total) * 100}%`, background: p.color }} />)}
        </div>
      )}
      <div className="stats-cols-legend">
        {parts.map((p) => (
          <span key={p.id || 'other'}><i className="swatch" style={{ background: p.color }} /><span className="x" title={p.title}>{p.title}</span><b>{p.count}</b></span>
        ))}
      </div>
      <div className="stats-hint">Прогоны агентов за период: {d.total}{stats.coordinatorLaunches > 0 && ` · запусков координатора ${stats.coordinatorLaunches}`}</div>
      {d.total > 0 && (
        <div className="stats-chips">
          <span className="chip ok stats-chip">сдано {d.done}</span>
          {d.failed > 0 && <span className="chip warn stats-chip">упало {d.failed}</span>}
          {d.unknown > 0 && <span className="chip stats-chip" title="Сессия закрылась без orca-board done">исход неизвестен {d.unknown}</span>}
          {d.running > 0 && <span className="chip live stats-chip">идут сейчас {d.running}</span>}
        </div>
      )}
      <div className="stats-muted">
        {tt.samples > 0 ? (
          <>
            {tt.avgActiveMs !== undefined && <>В работе в среднем <b>{formatAgentTime(tt.avgActiveMs)}</b></>}
            {tt.avgActiveMs !== undefined && tt.avgLeadMs !== undefined && ', '}
            {tt.avgLeadMs !== undefined && <>от старта до «Готово» — <b>{formatAgentTime(tt.avgLeadMs)}</b></>}
            {` (${tt.samples} ${tt.samples === 1 ? 'задача' : 'задач'})`}
          </>
        ) : (
          'Время задач — когда за период завершится хоть одна'
        )}
      </div>
      <div className="stats-muted">
        Глобальных задач: <b>{stats.globalTasks.total}</b>, закрыто за период <b>{stats.globalTasks.done}</b>
      </div>
    </>
  )
}

const TOP_ROWS = 8

/** Топ по стоимости (main уже отсортировал): задача, стоимость, время агентов, доля. Без токенов — только время. */
function TopTable({ rows, head, usage }: { rows: StatsRow[]; head: string; usage: boolean }): React.JSX.Element {
  if (rows.length === 0) return <div className="stats-muted">За период агенты по задачам не запускались</div>
  const items = shareItems(rows, usage, TOP_ROWS)
  return (
    <div className="stats-tbl-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>{head}</th>
            {usage && <th className="r">Стоимость</th>}
            <th className="r">Время агентов</th>
            <th className="share-col" title={`Доля ${usage ? 'стоимости' : 'времени агентов'}`}>доля</th>
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
                    <span className="stats-hint stats-sess" title="Сессий с данными о токенах"> ({row.sessionsWithUsage}/{row.sessions})</span>
                  )}
                </td>
              )}
              <td className="r">{formatAgentTime(row.agentMs)}</td>
              <td className="share-col"><div className="stats-share" aria-hidden="true"><i style={{ width: `${Math.max(2, share * 100)}%` }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > items.length && <span className="stats-hint">и ещё {rows.length - items.length}</span>}
    </div>
  )
}
