import type React from 'react'
import { useRef } from 'react'
import type { BoardColumn, Dispatch, GlobalTask, GlobalTaskStats, Task } from '@orca-board/core'
import { globalTaskTicking } from './duration'
import { Cost } from './StatsCells'
import { Counters, StaleNote, StatFacts, TimeBar, RolesTable } from './TaskStatsParts'
import { formatAgentTime } from './statsFormat'
import {
  advanceGlobalStats, columnParts, fallbackGlobalStats, globalFacts, globalSides, globalStatsKey, humanLine, isStatsRunning, returnsCounter, taskStatsApi, topTasks,
  type StatsSnapshot
} from './taskStatsFormat'
import { useNow } from './useNow'
import { useStatsLoad } from './useStatsLoad'
import { Icon } from './icons'
import { useT } from './i18n'

interface Props {
  projectId: string
  global: GlobalTask
  /** Колонки глобального канбана — цвета и названия полосы; нет — колонки проекта. */
  columns: BoardColumn[]
  /** Подзадачи прогона: какие строки топа можно открыть и сколько подзадач сейчас работает. */
  tasks: Task[]
  dispatches: Dispatch[]
  /** Жив ли координатор — его время растёт. */
  coordinatorLive: boolean
  snapshot: StatsSnapshot
  /** Клик по строке топа: открыть подзадачу. */
  onOpenTask(taskId: string): void
}

/**
 * Вкладка «Статистика» глобальной задачи: итог, координатор и подзадачи раздельно, топ подзадач и возвраты с
 * «Проверки». Данные — `stats:global`; идущие значения досчитываются по `generatedAt`.
 */
export function GlobalStatsPanel(props: Props): React.JSX.Element {
  const { projectId, global, columns, tasks, dispatches, coordinatorLive, snapshot, onOpenTask } = props
  const t = useT()
  const now = useNow()
  const snap = useRef(snapshot)
  snap.current = snapshot
  const load = useStatsLoad<GlobalTaskStats>({
    key: globalStatsKey(snapshot, global.id),
    load: () => taskStatsApi(window.orca).global(projectId, global.id),
    fallback: () => fallbackGlobalStats(snap.current, global.id, Date.now()),
    running: isStatsRunning
  })

  if (!load.stats) {
    return load.error ? (
      <div className="ts-state">
        <span className="stats-error">{t('global.stats.errorWith', { error: load.error })}</span>
        <button type="button" className="btn-sm" onClick={load.reload}>{t('global.retry')}</button>
      </div>
    ) : (
      <div className="stats-hint">{t('global.stats.loading')}</div>
    )
  }

  const ids = new Set(tasks.map((task) => task.id))
  // Каждая идущая сессия подзадачи или её проверки тикает отдельно.
  const subtasksRunning = dispatches.filter((d) => ids.has(d.taskId) && d.endedAt === undefined).length
  const stats = advanceGlobalStats(load.stats, now, {
    ownTicking: globalTaskTicking(global, 'own'), status: global.status, coordinatorLive, subtasksRunning
  })
  const human = humanLine(stats.human)
  const top = topTasks(stats.byTask, ids)
  const usage = stats.byTask.some((r) => r.costUsd !== undefined || r.tokens !== undefined)

  return (
    <div className={`gt-stack ts${load.loading ? ' refreshing' : ''}`}>
      {load.stale && <StaleNote />}
      {load.error && (
        <div className="ts-state">
          <span className="stats-error">{t('global.stats.refreshErrorWith', { error: load.error })}</span>
          <button type="button" className="btn-sm" onClick={load.reload}>{t('global.retry')}</button>
        </div>
      )}
      <section className="gt-box">
        <h3>{t('global.panel.total')}</h3>
        <StatFacts facts={globalFacts(stats)} />
        <TimeBar title={t('global.panel.byColumn')} parts={columnParts(stats.columns, columns)} empty={t('global.panel.byColumnEmpty')} />
        {human && <div className="stats-hint ts-human"><Icon.info /> {human}</div>}
      </section>

      <div className="ts-sides">
        {globalSides(stats).map((side) => (
          <section key={side.id} className="gt-box">
            <h3>{side.title}</h3>
            <StatFacts facts={side.facts} />
          </section>
        ))}
      </div>

      <section className="gt-box">
        <h3>{t('global.panel.top')}</h3>
        {top.length === 0 ? (
          <div className="stats-hint">{t('global.panel.topEmpty')}</div>
        ) : (
          <div className="ts-table-wrap">
            <table className="stats-table ts-table">
              <thead>
                <tr>
                  <th>{t('global.panel.subtask')}</th>
                  {usage && <th className="r">{t('global.stats.cost')}</th>}
                  <th className="r">{t('global.stats.agentTime')}</th>
                  <th className="share-col" title={t(usage ? 'global.stats.shareCost' : 'global.stats.shareTime')}>{t('global.stats.share')}</th>
                </tr>
              </thead>
              <tbody>
                {top.map((r) => (
                  <tr key={r.key || r.title}>
                    <td className="t">
                      {r.openable ? (
                        <button type="button" className="btn-text ts-open" title={t('global.panel.open', { title: r.title })} onClick={() => onOpenTask(r.key)}>
                          <span className="x">{r.title}</span>
                        </button>
                      ) : (
                        <span className="x" title={r.title}>{r.title}</span>
                      )}
                    </td>
                    {usage && <td className="r"><Cost usage={r.usage} /></td>}
                    <td className="r">{formatAgentTime(r.agentMs)}</td>
                    <td className="share-col"><div className="stats-share" aria-hidden="true"><i style={{ width: `${Math.max(2, r.share * 100)}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stats.byTask.length > top.length && <span className="stats-hint">{t('global.stats.more', { count: stats.byTask.length - top.length })}</span>}
          </div>
        )}
      </section>

      <div className="ts-sides">
        <section className="gt-box">
          <h3>{t('global.stats.roles')}</h3>
          <RolesTable rows={stats.byRole} />
        </section>
        <section className="gt-box">
          <h3>{t('global.panel.returns')}</h3>
          <Counters items={[returnsCounter(stats.returns)]} />
        </section>
      </div>
    </div>
  )
}
