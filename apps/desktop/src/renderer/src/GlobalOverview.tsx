import type React from 'react'
import type { BoardColumn, ColumnKind, Dispatch, GlobalTask, Task } from '@orca-board/core'
import { PRIORITY_TITLES } from '@orca-board/core'
import { Icon } from './icons'
import { GlobalDuration, relativeTime } from './GlobalBoard'
import { formatStamp } from './boardSort'
import { globalTaskActions, returnsNewestFirst } from './globalReview'
import { globalDoneReport } from './globalDoneReport'
import { launchChecklist, showsLaunchHint, showsSummary } from './globalScreen'
import { taskPriorityOf } from './taskPriority'
import { Markdown } from './Markdown'

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
  const actions = globalTaskActions(global, statusKind, coordinatorPty !== undefined)
  const summary = showsSummary(statusKind, global.inbox)
  const draft = showsLaunchHint(statusKind, global.inbox)
  const goal = global.description.trim()

  const goalBox = (
    <section className="gt-box" aria-label="Цель">
      <h3>Цель</h3>
      {goal ? <Markdown text={goal} className="gt-goal" /> : <p className="muted">Цель не описана — добавьте её в «Изменить».</p>}
    </section>
  )
  const detailsBox = (
    <section className="gt-box" aria-label="Детали">
      <h3>Детали</h3>
      <dl className="gt-kv">
        {typeTitle && (<><dt>Тип</dt><dd>{typeTitle}</dd></>)}
        <dt>Приоритет</dt>
        <dd>{PRIORITY_TITLES[taskPriorityOf(global)]}</dd>
        {!global.inbox && (<><dt>Время</dt><dd><GlobalDuration global={global} variant="line" /></dd></>)}
        <dt>Создана</dt>
        <dd>{formatStamp(global.createdAt)}{global.closedAt !== undefined ? ` · закрыта ${formatStamp(global.closedAt)}` : ''}</dd>
        <dt>Обновлена</dt>
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
              <button type="button" className="btn-sm primary" onClick={onAccept} title="Результат принят — в «Сделано»">✓ Подтвердить</button>
            )}
            {actions.returnToWork && (
              <button type="button" className="btn-sm" onClick={onReturn} title="Написать, что доделать, и перезапустить координатора">
                Вернуть в работу…
              </button>
            )}
          </div>
        )}
      </GlobalDoneReportBlock>
      {returnsBox}
    </>
  )

  const launchBox = draft && (
    <section className="gt-box" aria-label="Перед запуском">
      <h3>Перед запуском</h3>
      <ul className="gt-checks">
        {launchChecklist(global, typeTitle).map((c) => (
          <li key={c.text} className={c.ok ? 'ok' : 'todo'}>{c.text}</li>
        ))}
      </ul>
      <p className="muted gt-hint">Цель и тип можно поправить в «Изменить», пока задача не начата.</p>
      {actions.startCoordinator && (
        <button type="button" className="btn-sm primary" onClick={onStartCoordinator}><Icon.play /> Запустить координатора</button>
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
  const returns = returnsNewestFirst(global)
  if (returns.length === 0) return null
  return (
    <details className="g-returns" open={returns.length === 1}>
      <summary>Возвращали с проверки: {returns.length}</summary>
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
  const isDone = (status: string): boolean => columns.find((c) => c.id === status)?.kind === 'done'
  const report = globalDoneReport(global, tasks, dispatches, isDone)
  return (
    <section className="gt-box gt-report" aria-label="Что сделал">
      <h3>
        Что сделал
        {report.kind === 'coordinator' ? (
          <span className="muted gt-sub">сводка координатора · {formatStamp(report.at)}</span>
        ) : (
          <span className="muted gt-sub">координатор не оставил сводку — сделанные подзадачи</span>
        )}
      </h3>
      {report.kind === 'coordinator' && <Markdown text={report.text} className="gt-report-md" />}
      {report.kind === 'subtasks' && report.items.length === 0 && <div className="muted">Сделанных подзадач нет.</div>}
      {report.kind === 'subtasks' && report.items.length > 0 && (
        <ul className="gt-report-list">
          {report.items.map((item) => (
            <li key={item.taskId}>
              <button type="button" className="btn-text gt-report-task" onClick={() => onOpenTask(item.taskId)} title="Открыть подзадачу">
                {item.title}
              </button>
              {item.summary ? <div className="gt-report-text">{item.summary}</div> : <div className="muted">без сводки</div>}
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  )
}
