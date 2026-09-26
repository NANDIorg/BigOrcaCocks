import type React from 'react'
import { useState } from 'react'
import type { GlobalTask, Task, Workflow } from '@orca-board/core'
import { useNow } from './useNow'
import { useT } from './i18n'
import { formatDateTime } from './i18n/format'
import { formatDuration } from './duration'
import { STATUS_HISTORY_COLLAPSED } from './statusHistory'
import { pathHistoryRows, pathSummary, stageHold, visiblePathRows } from './subtaskPath'

interface Props {
  task: Task
  /** Граф глобальной задачи: путь подзадачи лежит в его ноде «Работа». */
  workflow: Workflow | undefined
  /** Глобальная задача: позиция на графе нужна, чтобы сказать, держит ли подзадача этап. */
  run: Partial<Pick<GlobalTask, 'stage' | 'workflowScope'>> | undefined
  isDone: boolean
}

function formatAt(ts: number): string {
  return formatDateTime(ts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Блок «Путь подзадачи» карточки задачи: этап прогона, шаг пути, на котором стоит подзадача, «держит этап» и история шагов
 * (`Task.stageHistory`). Нет пути (задача вне этапа «Работа», старый main, прогон старого формата) — блока нет.
 */
export function SubtaskPathBlock(props: Props): React.JSX.Element | null {
  const { task, workflow, run, isDone } = props
  const t = useT()
  const now = useNow()
  const [expanded, setExpanded] = useState(false)
  const summary = run?.workflowScope === 'run' ? pathSummary(task, workflow) : null
  if (!summary) return null
  const hold = stageHold(task, run, workflow, () => isDone)
  const rows = pathHistoryRows(task, workflow, now)
  const visible = visiblePathRows(rows, expanded)
  const hidden = rows.length - visible.length

  return (
    <div className="path-block">
      <div className="path-head">
        <span className="chip">{summary.visit > 1 ? t('board.stage.visit', { name: t('board.task.pathStage', { stage: summary.stage }), n: summary.visit }) : t('board.task.pathStage', { stage: summary.stage })}</span>
        <span className="muted">{summary.step ? t('board.task.pathStep', { step: summary.step }) : t('board.task.pathNotEntered')}</span>
        {hold && <span className={`tag hold ${hold.reason}`} title={hold.title}>{hold.text}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="status-history-empty muted">{t('board.task.pathEmpty')}</div>
      ) : (
        <div className="status-history">
          <div className="path-history-title muted">{t('board.task.pathHistory')}</div>
          {hidden > 0 && (
            <button type="button" className="btn-text status-history-toggle" onClick={() => setExpanded(true)}>
              {t('board.history.showEarlierSteps', { n: hidden })}
            </button>
          )}
          <ol className="status-history-list">
            {visible.map((r) => {
              const note = [r.visit ? t('board.history.visit', { n: r.visit }) : undefined, r.outcome, r.source].filter(Boolean).join(' · ')
              return (
                <li key={r.index} className={`status-history-row${r.current ? ' current' : ''}`}>
                  <span className="chip">{r.name}</span>
                  <span className="mono status-history-at" title={r.migrated ? t('board.history.migrated') : undefined}>
                    {r.migrated ? '≈ ' : ''}{formatAt(r.at)}
                  </span>
                  <span className="muted">{note}</span>
                  <span className="status-history-dur">
                    {r.type === 'end' ? '' : r.current && !isDone ? t('board.history.now', { value: formatDuration(r.durationMs) }) : formatDuration(r.durationMs)}
                  </span>
                </li>
              )
            })}
          </ol>
          {expanded && rows.length > STATUS_HISTORY_COLLAPSED && (
            <button type="button" className="btn-text status-history-toggle" onClick={() => setExpanded(false)}>
              {t('board.history.collapse')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
