import type React from 'react'
import type { BoardColumn, ColumnKind, Dispatch, GlobalTask, Task } from '@orca-board/core'
import { Icon } from './icons'
import { GlobalDuration, relativeTime } from './GlobalBoard'
import { formatStamp } from './boardSort'
import { globalTaskActions, returnsNewestFirst } from './globalReview'
import { globalDoneReport } from './globalDoneReport'
import { launchChecklist, showsLaunchHint, showsSummary } from './globalScreen'
import { priorityTitle, taskPriorityOf } from './taskPriority'
import { Markdown } from './Markdown'
import { useT } from './i18n'

interface Props {
  global: GlobalTask
  /** Вид колонки глобального канбана, где сейчас задача. */
  statusKind?: ColumnKind
  coordinatorPty?: string
  /** Название типа задачи (`globalTypeTitle`); нет — тип не показываем. */
  typeTitle?: string
  /** Подзадачи этой глобальной задачи — для фоллбэка сводки «что сделали подзадачи». */
  tasks: Task[]
  columns: BoardColumn[]
  dispatches: Dispatch[]
  onAccept(): void
  onReturn(): void
  onStartCoordinator(): void
  onOpenTask(taskId: string): void
}

/**
 * Вкладка «Итог и цель» («Цель и детали» до проверки). На «Проверке» и в «Сделано» слева сводка целиком, справа
 * цель и детали; на «Проверке» под сводкой — кнопки решения (те же, что в шапке). В черновике — подсказка
 * «Перед запуском». Уточнения после проверки — везде, где они были.
 */
export function GlobalOverview(props: Props): React.JSX.Element {
  const { global, statusKind, coordinatorPty, typeTitle, tasks, columns, dispatches, onAccept, onReturn, onStartCoordinator, onOpenTask } = props
  const t = useT()
  const actions = globalTaskActions(global, statusKind, coordinatorPty !== undefined)
  const summary = showsSummary(statusKind, global.inbox)
  const draft = showsLaunchHint(statusKind, global.inbox)
  const goal = global.description.trim()

  const goalBox = (
    <section className="gt-box" aria-label={t('global.overview.goal')}>
      <h3>{t('global.overview.goal')}</h3>
      {goal ? <Markdown text={goal} className="gt-goal" /> : <p className="muted">{t('global.overview.goalEmpty')}</p>}
    </section>
  )
  const detailsBox = (
    <section className="gt-box" aria-label={t('global.overview.details')}>
      <h3>{t('global.overview.details')}</h3>
      <dl className="gt-kv">
        {typeTitle && (<><dt>{t('global.overview.type')}</dt><dd>{typeTitle}</dd></>)}
        <dt>{t('global.overview.priority')}</dt>
        <dd>{priorityTitle(taskPriorityOf(global))}</dd>
        {!global.inbox && (<><dt>{t('global.overview.time')}</dt><dd><GlobalDuration global={global} variant="line" /></dd></>)}
        <dt>{t('global.overview.created')}</dt>
        <dd>{formatStamp(global.createdAt)}{global.closedAt !== undefined ? ` · ${t('global.overview.closed', { date: formatStamp(global.closedAt) })}` : ''}</dd>
        <dt>{t('global.overview.updated')}</dt>
        <dd>{relativeTime(global.activityAt)}</dd>
      </dl>
    </section>
  )
  const returnsBox = <GlobalReturns global={global} />

  const summaryBox = (
    <>
      <GlobalDoneReportBlock global={global} tasks={tasks} columns={columns} dispatches={dispatches} onOpenTask={onOpenTask}>
        {(actions.accept || actions.returnToWork) && (
          <div className="gt-decision">
            {actions.accept && (
              <button type="button" className="btn-sm primary" onClick={onAccept} title={t('global.action.acceptTitle')}>✓ {t('global.action.accept')}</button>
            )}
            {actions.returnToWork && (
              <button type="button" className="btn-sm" onClick={onReturn} title={t('global.action.returnTitle')}>
                {t('global.action.return')}
              </button>
            )}
          </div>
        )}
      </GlobalDoneReportBlock>
      {returnsBox}
    </>
  )

  const launchBox = draft && (
    <section className="gt-box" aria-label={t('global.overview.launch')}>
      <h3>{t('global.overview.launch')}</h3>
      <ul className="gt-checks">
        {launchChecklist(global, typeTitle).map((c) => (
          <li key={c.text} className={c.ok ? 'ok' : 'todo'}>{c.text}</li>
        ))}
      </ul>
      <p className="muted gt-hint">{t('global.overview.launchHint')}</p>
      {actions.startCoordinator && (
        <button type="button" className="btn-sm primary" onClick={onStartCoordinator}><Icon.play /> {t('global.action.start')}</button>
      )}
    </section>
  )

  return (
    <div className="gt-grid">
      {summary ? (
        <>
          <div className="gt-stack">{summaryBox}</div>
          <div className="gt-stack">{goalBox}{detailsBox}</div>
        </>
      ) : (
        <>
          <div className="gt-stack">{goalBox}{returnsBox}</div>
          <div className="gt-stack">{launchBox}{detailsBox}</div>
        </>
      )}
    </div>
  )
}

/** История уточнений при возвратах с «Проверки» в работу (`GlobalTask.returns`), новые сверху. */
export function GlobalReturns({ global }: { global: GlobalTask }): React.JSX.Element | null {
  const t = useT()
  const returns = returnsNewestFirst(global)
  if (returns.length === 0) return null
  return (
    <details className="g-returns" open={returns.length === 1}>
      <summary>{t('global.overview.returns', { count: returns.length })}</summary>
      <ol className="g-returns-list">
        {returns.map((r) => (
          <li key={`${r.at}-${r.text}`}>
            <span className="muted g-returns-at">{formatStamp(r.at)}</span>
            <div className="g-returns-text">{r.text}</div>
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * «Что сделал»: итоговая сводка координатора (`runs finish --summary`), а без неё — сделанные подзадачи со
 * сводками воркеров (`globalDoneReport`). Показывается на «Проверке» и в «Сделано»; `children` — кнопки решения.
 */
function GlobalDoneReportBlock(props: {
  global: GlobalTask
  tasks: Task[]
  columns: BoardColumn[]
  dispatches: Dispatch[]
  onOpenTask(taskId: string): void
  children?: React.ReactNode
}): React.JSX.Element {
  const { global, tasks, columns, dispatches, onOpenTask, children } = props
  const t = useT()
  const isDone = (status: string): boolean => columns.find((c) => c.id === status)?.kind === 'done'
  const report = globalDoneReport(global, tasks, dispatches, isDone)
  return (
    <section className="gt-box gt-report" aria-label={t('global.report.title')}>
      <h3>
        {t('global.report.title')}
        {report.kind === 'coordinator' ? (
          <span className="muted gt-sub">{t('global.report.coordinator', { date: formatStamp(report.at) })}</span>
        ) : (
          <span className="muted gt-sub">{t('global.report.subtasks')}</span>
        )}
      </h3>
      {report.kind === 'coordinator' && <Markdown text={report.text} className="gt-report-md" />}
      {report.kind === 'subtasks' && report.items.length === 0 && <div className="muted">{t('global.report.empty')}</div>}
      {report.kind === 'subtasks' && report.items.length > 0 && (
        <ul className="gt-report-list">
          {report.items.map((item) => (
            <li key={item.taskId}>
              <button type="button" className="btn-text gt-report-task" onClick={() => onOpenTask(item.taskId)} title={t('global.report.openTask')}>
                {item.title}
              </button>
              {item.summary ? <div className="gt-report-text">{item.summary}</div> : <div className="muted">{t('global.report.noSummary')}</div>}
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  )
}
