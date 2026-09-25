import type React from 'react'
import type { BoardColumn, Run, Task } from '@orca-board/core'
import { useT } from './i18n'
import { formatDateTime } from './i18n/format'

/** Число цветов палитры прогонов: классы `.run-c0` … `.run-c7` в styles.css. */
const RUN_COLORS = 8

/** Фильтр доски по прогону: все, без прогона или id прогона. */
export type RunFilter = 'all' | 'none' | string

/** Первые слова цели прогона для метки; длинное — с многоточием. */
export function runShortLabel(run: Run, words = 3, maxChars = 24): string {
  const parts = run.objective.trim().split(/\s+/).filter(Boolean)
  let text = parts.slice(0, words).join(' ') || run.id
  const cut = parts.length > words
  if (text.length > maxChars) return `${text.slice(0, maxChars - 1).trimEnd()}…`
  if (cut) text += '…'
  return text
}

/** Индекс цвета по позиции прогона в списке по createdAt (снимок уже отсортирован, но не полагаемся). */
export function runColorIndex(runs: Run[], runId: string): number {
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt)
  const idx = sorted.findIndex((r) => r.id === runId)
  return (idx < 0 ? 0 : idx) % RUN_COLORS
}

function formatDate(ts: number): string {
  return formatDateTime(ts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Метка прогона на карточке: цвет из палитры, закрытый прогон — приглушённый. */
export function RunBadge({ run, runs }: { run: Run; runs: Run[] }): React.JSX.Element {
  const t = useT()
  const closed = run.closedAt !== undefined
  return (
    <span
      className={`chip run-badge run-c${runColorIndex(runs, run.id)} ${closed ? 'closed' : ''}`}
      title={t(closed ? 'shell.runs.badgeClosed' : 'shell.runs.badge', { objective: run.objective })}
    >
      {runShortLabel(run)}
    </span>
  )
}

/** «О проекте» → «Прогоны»: цель, дата, задач/закрыто, статус, кнопка «Закрыть» у идущих. */
export function RunsSection(props: {
  runs: Run[]
  tasks: Task[]
  columns: BoardColumn[]
  onClose(id: string): Promise<void>
}): React.JSX.Element {
  const { runs, tasks, columns, onClose } = props
  const t = useT()
  const doneIds = new Set(columns.filter((c) => c.kind === 'done').map((c) => c.id))
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <>
      {sorted.length === 0 ? (
        <p className="muted">{t('shell.runs.empty')}</p>
      ) : (
        <div className="runs-list">
          {sorted.map((run) => {
            const own = tasks.filter((task) => task.runId === run.id)
            const done = own.filter((task) => doneIds.has(task.status)).length
            return (
              <div key={run.id} className="run-row">
                <div className="run-row-head">
                  <RunBadge run={run} runs={runs} />
                  <span className="run-meta">{formatDate(run.createdAt)}</span>
                  <span className="run-meta">{t('shell.runs.meta', { total: own.length, done })}</span>
                  <span className={`run-status ${run.closedAt !== undefined ? 'closed' : 'live'}`}>
                    {run.closedAt !== undefined ? t('shell.runs.closedAt', { date: formatDate(run.closedAt) }) : t('shell.runs.live')}
                  </span>
                  {run.closedAt === undefined && (
                    <button
                      className="btn-sm"
                      onClick={() => {
                        if (confirm(t('shell.runs.confirmClose', { label: runShortLabel(run) }))) void onClose(run.id)
                      }}
                    >
                      {t('common.close')}
                    </button>
                  )}
                </div>
                <div className="run-objective">{run.objective}</div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
