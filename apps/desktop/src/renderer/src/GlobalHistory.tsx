import type React from 'react'
import { useMemo, useState } from 'react'
import { globalBoardColumns, type AgentSession, type BoardColumn, type GlobalTask } from '@orca-board/core'
import { useNow } from './useNow'
import { formatClock, globalTimeline, groupByDay, TIMELINE_COLLAPSED, visibleTimeline } from './globalTimeline'

export interface GlobalHistoryProps {
  global: GlobalTask
  /** Колонки проекта: названия и цвета статусов в ленте. Нет — статусы показываются по id. */
  columns?: BoardColumn[]
  /**
   * Запуски координатора (`Run.coordinatorSessions`): в `GlobalTask` их нет, `App` берёт их из снапшота прогонов.
   * Нет (старый main или прогон до статистики) — запусков в ленте нет.
   */
  coordinatorSessions?: AgentSession[]
}

/**
 * Вкладка «История»: единая лента событий задачи по дням, новые сверху — создание, смены статуса, уточнения
 * после проверки (выделены), сводка и запуски координатора, закрытие (`globalTimeline`). Всё, что она читает,
 * необязательно: со старым main ленты может не быть — тогда подсказка перезапустить приложение.
 */
export function GlobalHistory({ global, columns = [], coordinatorSessions }: GlobalHistoryProps): React.JSX.Element {
  const now = useNow()
  const [expanded, setExpanded] = useState(false)
  // Названия — как на глобальной доске («Проверка»), остальные колонки проекта — запасом для статусов вне неё.
  const all = useMemo(() => [...globalBoardColumns(columns), ...columns], [columns])
  const events = globalTimeline({ ...global, coordinatorSessions }, all, now)
  const shown = visibleTimeline(events, expanded)
  const hidden = events.length - shown.length
  const days = groupByDay(shown, now)

  return (
    <section className="gt-box gt-hist" aria-label="История">
      <h3>
        История
        {events.length > 0 && <span className="muted gt-sub">{events.length}</span>}
      </h3>
      {events.length === 0 ? (
        <p className="muted gt-stub">
          История пока пуста
          {global.statusHistory === undefined ? ' — если задача не новая, перезапустите приложение: старая версия не присылает историю.' : '.'}
        </p>
      ) : (
        <>
          {days.map((day) => (
            <div key={day.key} className="gt-hist-day">
              <h4 className="gt-hist-day-title">{day.label}</h4>
              <ol className="gt-hist-list">
                {day.events.map((e) => (
                  <li key={e.key} className={`gt-hist-row gt-hist-${e.kind}${e.highlight ? ' is-return' : ''}`}>
                    <span className="gt-hist-at" title={new Date(e.at).toLocaleString('ru-RU')}>
                      {e.approx ? '≈ ' : ''}{formatClock(e.at)}
                    </span>
                    <span className="gt-hist-pt" style={e.color ? ({ '--c': e.color } as React.CSSProperties) : undefined} aria-hidden />
                    <div className="gt-hist-what">
                      <div>
                        <b>{e.title}</b>
                        {e.detail && <span className="gt-hist-detail"> — {e.detail}</span>}
                      </div>
                      {e.sub && <div className="muted gt-hist-sub">{e.sub}</div>}
                      {e.text && <div className={e.highlight ? 'gt-hist-quote' : 'muted gt-hist-excerpt'}>{e.text}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" className="btn-text gt-hist-more" onClick={() => setExpanded(true)}>
              Показать ранние события ({hidden})
            </button>
          )}
          {expanded && events.length > TIMELINE_COLLAPSED && (
            <button type="button" className="btn-text gt-hist-more" onClick={() => setExpanded(false)}>Свернуть</button>
          )}
        </>
      )}
    </section>
  )
}
