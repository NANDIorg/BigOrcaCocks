import type React from 'react'
import { useState } from 'react'
import type { BoardColumn, StatusChange } from '@orca-board/core'
import { useNow } from './useNow'
import { STATUS_HISTORY_COLLAPSED, statusDurationLabel, statusHistoryRows, visibleStatusRows } from './statusHistory'

interface Props {
  /** `Task.statusHistory` / `GlobalTask.statusHistory`; нет — снапшот от старого main. */
  history?: StatusChange[]
  columns: BoardColumn[]
  /** Текущий статус — показывается, когда истории нет. */
  status: string
}

function formatAt(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ColumnChip(props: { title: string; color?: string }): React.JSX.Element {
  const { title, color } = props
  return <span className="chip" style={color ? { borderColor: color, color } : undefined}>{title}</span>
}

/** Блок «История статуса» карточки задачи и глобальной задачи: переходы от старых к новым. */
export function StatusHistoryBlock(props: Props): React.JSX.Element {
  const { history, columns, status } = props
  const now = useNow()
  const [expanded, setExpanded] = useState(false)
  const rows = statusHistoryRows(history, columns, now)
  const visible = visibleStatusRows(rows, expanded)
  const hidden = rows.length - visible.length

  if (rows.length === 0) {
    const column = columns.find((c) => c.id === status)
    return (
      <div className="status-history-empty muted">
        <ColumnChip title={column?.title ?? status} color={column?.color} /> история переходов не записывалась
        {history === undefined ? ' — перезапустите приложение, чтобы она появилась' : ''}
      </div>
    )
  }

  return (
    <div className="status-history">
      {hidden > 0 && (
        <button type="button" className="btn-text status-history-toggle" onClick={() => setExpanded(true)}>
          Показать ранние переходы ({hidden})
        </button>
      )}
      <ol className="status-history-list">
        {visible.map((r) => (
          <li key={r.index} className={`status-history-row${r.current ? ' current' : ''}`}>
            <ColumnChip title={r.title} color={r.color} />
            <span
              className="mono status-history-at"
              title={r.migrated ? 'Записано при обновлении приложения: время последней правки задачи, а не момент перехода' : undefined}
            >
              {r.migrated ? '≈ ' : ''}{formatAt(r.at)}
            </span>
            <span className="muted">{r.source}</span>
            <span className="status-history-dur">{statusDurationLabel(r)}</span>
          </li>
        ))}
      </ol>
      {expanded && rows.length > STATUS_HISTORY_COLLAPSED && (
        <button type="button" className="btn-text status-history-toggle" onClick={() => setExpanded(false)}>
          Свернуть
        </button>
      )}
    </div>
  )
}
