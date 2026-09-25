import type React from 'react'
import { useRef } from 'react'
import type { BoardColumn, Task, TaskStats } from '@orca-board/core'
import { Icon } from './icons'
import { taskTicking } from './duration'
import { Counters, RolesTable, StaleNote, StatFacts, TimeBar } from './TaskStatsParts'
import {
  advanceTaskStats, columnParts, fallbackTaskStats, humanLine, isStatsRunning, stageParts, taskCounters, taskFacts, taskStatsApi, taskStatsKey,
  type StatsSnapshot
} from './taskStatsFormat'
import { useNow } from './useNow'
import { useStatsLoad } from './useStatsLoad'
import { useT } from './i18n'

interface Props {
  projectId: string
  task: Task
  columns: BoardColumn[]
  /** Снимок проекта: ключ перечитывания и запасной расчёт при старом main. */
  snapshot: StatsSnapshot
}

/**
 * Секция «Статистика» карточки задачи: факты, полосы по колонкам и этапам, роли, счётчики. Данные — `stats:task`
 * (перечитываются при смене статуса, запусков и запросов задачи), идущие значения досчитываются по `generatedAt`.
 */
export function TaskStatsBlock({ projectId, task, columns, snapshot }: Props): React.JSX.Element {
  const t = useT()
  const now = useNow()
  const snap = useRef(snapshot)
  snap.current = snapshot
  const load = useStatsLoad<TaskStats>({
    key: taskStatsKey(snapshot, task.id),
    load: () => taskStatsApi(window.orca).task(projectId, task.id),
    fallback: () => fallbackTaskStats(snap.current, task.id, Date.now()),
    running: isStatsRunning
  })

  if (!load.stats) {
    return load.error ? (
      <div className="ts-state">
        <span className="stats-error">{t('board.stats.loadError', { error: load.error })}</span>
        <button type="button" className="btn-sm" onClick={load.reload}>{t('board.retry')}</button>
      </div>
    ) : (
      <div className="stats-hint">{t('board.stats.loading')}</div>
    )
  }

  const stats = advanceTaskStats(load.stats, now, { activeTicking: taskTicking(task), status: task.status })
  const human = humanLine(stats.human)
  const stages = stageParts(stats.stages)
  return (
    <div className={`ts${load.loading ? ' refreshing' : ''}`}>
      {load.stale && <StaleNote />}
      {load.error && (
        <div className="ts-state">
          <span className="stats-error">{t('board.stats.refreshError', { error: load.error })}</span>
          <button type="button" className="btn-sm" onClick={load.reload}>{t('board.retry')}</button>
        </div>
      )}
      <StatFacts facts={taskFacts(stats)} />
      <TimeBar title={t('board.stats.byColumn')} parts={columnParts(stats.columns, columns)} empty={t('board.stats.byColumnEmpty')} />
      {stages.length > 0 && <TimeBar title={t('board.stats.byStage')} parts={stages} empty={t('board.stats.byStageEmpty')} />}
      <RolesTable rows={stats.byRole} />
      <Counters items={taskCounters(stats)} />
      {human && <div className="stats-hint ts-human"><Icon.info /> {human}</div>}
    </div>
  )
}
