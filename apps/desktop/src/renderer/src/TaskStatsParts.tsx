import type React from 'react'
import type { StatsRow } from '@orca-board/core'
import { Icon } from './icons'
import { Cost, NoData } from './StatsCells'
import { formatAgentTime, formatTokens } from './statsFormat'
import { APPROX_TITLE, TASK_STATS_STALE_HINT, partLabel, partValue, roleRows, type StatCounter, type StatFact, type TimePart } from './taskStatsFormat'

/** Строка фактов: значение крупно, подпись над ним, пояснение под ним. Неизвестное — приглушённо курсивом. */
export function StatFacts({ facts }: { facts: StatFact[] }): React.JSX.Element {
  return (
    <div className="ts-facts">
      {facts.map((f) => (
        <div key={f.id} className={`ts-fact${f.live ? ' live' : ''}`} title={f.title}>
          <span className="ts-fact-label">{f.label}</span>
          <b className={f.unknown ? 'stats-unknown' : undefined}>
            {f.live && <i className="ts-live" aria-hidden="true" />}
            {f.value}
          </b>
          {f.hint && <em>{f.hint}</em>}
        </div>
      ))}
    </div>
  )
}

/** Полоса по частям (колонки, этапы) и легенда под ней. Части без времени в полосу не входят, но остаются в легенде. */
export function TimeBar({ title, parts, empty }: { title: string; parts: TimePart[]; empty: string }): React.JSX.Element {
  const shown = parts.filter((p) => p.ms > 0)
  return (
    <div className="ts-bar-block">
      <div className="ts-bar-title">{title}</div>
      {shown.length === 0 ? (
        <div className="stats-hint">{empty}</div>
      ) : (
        <div className="stats-stackbar" role="img" aria-label={title}>
          {shown.map((p) => <i key={p.key} title={partLabel(p)} style={{ flexGrow: p.ms, background: p.color }} />)}
        </div>
      )}
      {parts.length > 0 && (
        <ul className="ts-legend">
          {parts.map((p) => (
            <li key={p.key} className={p.ms === 0 ? 'zero' : undefined} title={p.approx ? APPROX_TITLE : undefined}>
              <i className="swatch" style={{ background: p.color }} />
              <span className="x">{p.title}</span>
              <b>{p.entries > 0 ? partValue(p) : '—'}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Таблица ролей: время агентов, токены, стоимость. Нет строк — заглушка. */
export function RolesTable({ rows }: { rows: StatsRow[] }): React.JSX.Element {
  if (rows.length === 0) return <div className="stats-hint">Агенты не запускались</div>
  return (
    <div className="ts-table-wrap">
      <table className="stats-table ts-table">
        <thead>
          <tr>
            <th>Роль</th>
            <th className="r">Время</th>
            <th className="r">Токены</th>
            <th className="r">Стоимость</th>
          </tr>
        </thead>
        <tbody>
          {roleRows(rows).map((r) => (
            <tr key={r.key}>
              <td className="t"><span className="x" title={r.title}>{r.title}</span></td>
              <td className="r">{formatAgentTime(r.agentMs)}</td>
              <td className="r">{r.tokens !== undefined ? formatTokens(r.tokens) : <NoData />}</td>
              <td className="r"><Cost usage={r.usage} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Чипы-счётчики: «запусков 3», «отказов ревью 1»… */
export function Counters({ items }: { items: StatCounter[] }): React.JSX.Element {
  return (
    <div className="stats-chips ts-counters">
      {items.map((c) => (
        <span key={c.id} className={`chip stats-chip${c.tone ? ` ${c.tone}` : ''}`} title={c.title}>{c.text}</span>
      ))}
    </div>
  )
}

/** Плашка «старый main»: время посчитано в приложении, токенов нет. */
export function StaleNote(): React.JSX.Element {
  return (
    <div className="ts-note" role="note">
      <Icon.info />
      <span>{TASK_STATS_STALE_HINT}</span>
    </div>
  )
}
