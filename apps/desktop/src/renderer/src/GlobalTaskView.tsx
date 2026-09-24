import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BoardColumn, ColumnKind, Dispatch, GlobalTask, HumanRequest, RequestResolution, Task } from '@orca-board/core'
import { Icon } from './icons'
import { AttentionFeed } from './AttentionFeed'
import type { AttentionItem } from './attention'
import { focusBoard, focusFeed } from './feedLink'
import { screenKey } from './hotkeys'
import { GlobalDuration, GlobalProgress, relativeTime } from './GlobalBoard'
import { formatStamp } from './boardSort'
import { PriorityBadge } from './Priority'
import { globalTaskActions, returnsNewestFirst } from './globalReview'
import { globalDoneReport } from './globalDoneReport'
import { Markdown } from './Markdown'

interface Props {
  global: GlobalTask
  /** Вид колонки глобального канбана, где сейчас задача (review — «Проверка»). */
  statusKind?: ColumnKind
  /** Живой координатор этой глобальной задачи (ptyId), если есть. */
  coordinatorPty?: string
  onBack(): void
  onEdit(): void
  onStartCoordinator(): void
  onShowCoordinator(ptyId: string): void
  /** «Подтвердить» на «Проверке». */
  onAccept(): void
  /** «Вернуть в работу…» на «Проверке» — модалка с уточнением. */
  onReturn(): void
  /**
   * Пункты ленты «Ждут вас» (`buildAttention`). Считает `App` и отдаёт и сюда, и доске (`attentionTaskIds`):
   * лента и фильтр «Ждут вас» на доске берут один и тот же список.
   */
  attention: AttentionItem[]
  /** Подзадачи этой глобальной задачи — подпись, чей запрос. */
  tasks: Task[]
  /** Колонки проекта (доски подзадач): какие подзадачи сделаны — для фоллбэка «Что сделал». */
  columns: BoardColumn[]
  /** Запуски воркеров: сводка последнего запуска сделанной подзадачи — фоллбэк «Что сделал». */
  dispatches: Dispatch[]
  onResolveRequest(request: HumanRequest, resolution: RequestResolution): Promise<void>
  /** «Открыть полностью» у ответа — модалка подзадачи. */
  onOpenTask(taskId: string): void
  onOpenTerminal(taskId: string): void
  /** Ответ на вопрос воркера без запроса (лента, как у карточки доски). */
  onAnswerQuestion(questionId: string, answer: string): Promise<void>
  /** «Принять» / «Вернуть» / «Уточнить» готовой задачи прямо в ленте (`review.accept` / `review.reject`). */
  onAcceptTask(taskId: string): Promise<void>
  onRejectTask(taskId: string, feedback: string): Promise<void>
  /** «↻ Перезапустить» упавшего воркера в ленте. */
  onStartTask(task: Task): void | Promise<void>
  /** Название типа задачи (`globalTypeTitle`) — чип рядом с приоритетом; нет — чипа нет. */
  typeTitle?: string
  /** Доска подзадач (Board), уже отфильтрованная по этой глобальной задаче. */
  children: React.ReactNode
}

/** Экран глобальной задачи: хлебные крошки, заголовок, описание и канбан только её подзадач. */
export function GlobalTaskView(props: Props): React.JSX.Element {
  const { global, statusKind, coordinatorPty, onBack, onEdit, onStartCoordinator, onShowCoordinator, onAccept, onReturn, children } = props
  const { columns, onResolveRequest, onOpenTask, onOpenTerminal, typeTitle } = props
  const { attention, tasks, dispatches } = props
  const actions = globalTaskActions(global, statusKind, coordinatorPty !== undefined)
  const [expanded, setExpanded] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)

  // Открыли с клавиатуры/мышью — фокус на «назад», чтобы Enter/Escape сразу вели обратно.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true })
    setExpanded(false)
  }, [global.id])

  // Клавиши экрана (`screenKey`): Esc — назад к общей доске, G — фокус между лентой «Ждут вас» и доской. Один
  // обработчик на всё: поля ввода, модалки и уже обработанные клавиши (меню «Переместить в…», Esc в подробностях
  // ленты) `screenKey` отсекает. G с фокусом в ленте возвращает на доску, откуда бы ни пришли.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const key = screenKey(e, document.querySelector('.modal-backdrop') !== null)
      if (!key) return
      if (key === 'back') {
        onBack()
        return
      }
      if (attention.length === 0) return
      e.preventDefault()
      if ((document.activeElement as HTMLElement | null)?.closest('.attn')) focusBoard()
      else focusFeed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, attention.length])

  const description = global.description.trim()
  const long = description.length > 220 || description.split('\n').length > 3

  return (
    <div className="g-view">
      <div className="g-view-head">
        <nav className="g-crumbs" aria-label="Навигация">
          <button ref={backRef} type="button" className="g-back" onClick={onBack} title="К общей доске (Esc)">
            <span aria-hidden>←</span> Глобальные задачи
          </button>
          <span className="g-crumb-sep" aria-hidden>/</span>
          <span className="g-crumb-current" title={global.title}>{global.title}</span>
        </nav>
        <div className="g-view-title-row">
          <h2 className="g-view-title" title={global.title}>{global.title}</h2>
          <div className="g-view-actions">
            <button type="button" className="btn-sm" onClick={onEdit}><Icon.edit /> Изменить</button>
            {actions.accept && (
              <button type="button" className="btn-sm primary" onClick={onAccept} title="Результат принят — в «Сделано»">Подтвердить</button>
            )}
            {actions.returnToWork && (
              <button type="button" className="btn-sm" title="Написать, что доделать, и перезапустить координатора" onClick={onReturn}>
                Вернуть в работу…
              </button>
            )}
            {!global.inbox && coordinatorPty && (
              <button type="button" className="btn-sm" onClick={() => onShowCoordinator(coordinatorPty)}>
                <span className="g-live-dot" aria-hidden /> Координатор работает
              </button>
            )}
            {actions.startCoordinator && (
              <button type="button" className="btn-sm" onClick={onStartCoordinator}><Icon.play /> Запустить координатора</button>
            )}
          </div>
        </div>
        {description && description !== global.title && (
          <div className={`g-view-desc ${long && !expanded ? 'clamped' : ''}`}>{description}</div>
        )}
        {long && (
          <button type="button" className="btn-text g-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Свернуть' : 'Показать полностью'}
          </button>
        )}
        <div className="g-view-meta">
          <div className="g-view-progress"><GlobalProgress global={global} /></div>
          {/* Правка — в «Изменить» (GlobalTaskModal); здесь только бейдж, normal без него, как на карточке. */}
          <PriorityBadge item={global} className="g-chip" />
          {typeTitle && <span className="g-chip task-type-chip" title="Тип задачи: роли, воркфлоу и правила агентов">{typeTitle}</span>}
          <span className="muted">Обновлено {relativeTime(global.activityAt)}</span>
          {!global.inbox && (
            <span className="muted" title={`Создана ${formatStamp(global.createdAt)}${global.closedAt !== undefined ? `, закрыта ${formatStamp(global.closedAt)}` : ''}`}>
              · <GlobalDuration global={global} variant="line" />
            </span>
          )}
          {global.closedAt !== undefined && <span className="muted">· закрыта</span>}
          {global.inbox && <span className="muted">· сюда попадают задачи без глобальной</span>}
        </div>
        {statusKind === 'review' && <div className="g-review-note">Все подзадачи сделаны — проверьте результат: подтвердите или верните в работу с уточнением.</div>}
        {statusKind === 'review' && (
          <GlobalDoneReportBlock global={global} tasks={tasks} columns={columns} dispatches={dispatches} onOpenTask={onOpenTask} />
        )}
        <GlobalReturns global={global} />
      </div>
      <AttentionFeed
        items={attention}
        tasks={tasks}
        runId={global.id}
        dispatches={dispatches}
        onResolveRequest={onResolveRequest}
        onAnswerQuestion={props.onAnswerQuestion}
        onAcceptTask={props.onAcceptTask}
        onRejectTask={props.onRejectTask}
        onStartTask={props.onStartTask}
        onOpenTask={onOpenTask}
        onOpenTerminal={onOpenTerminal}
      />
      {children}
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
 * «Что сделал» на «Проверке»: итоговая сводка координатора (`runs finish --summary`), а без неё — сделанные
 * подзадачи со сводками воркеров (`globalDoneReport`).
 */
function GlobalDoneReportBlock(props: {
  global: GlobalTask
  tasks: Task[]
  columns: BoardColumn[]
  dispatches: Dispatch[]
  onOpenTask(taskId: string): void
}): React.JSX.Element {
  const { global, tasks, columns, dispatches, onOpenTask } = props
  const isDone = (status: string): boolean => columns.find((c) => c.id === status)?.kind === 'done'
  const report = globalDoneReport(global, tasks, dispatches, isDone)
  return (
    <section className="g-done-report" aria-label="Что сделал">
      <h3 className="g-done-report-title">
        Что сделал
        {report.kind === 'coordinator' ? (
          <span className="muted g-done-report-sub">сводка координатора · {formatStamp(report.at)}</span>
        ) : (
          <span className="muted g-done-report-sub">координатор не оставил сводку — сделанные подзадачи</span>
        )}
      </h3>
      {report.kind === 'coordinator' && <Markdown text={report.text} className="g-done-report-md" />}
      {report.kind === 'subtasks' && report.items.length === 0 && <div className="muted">Сделанных подзадач нет.</div>}
      {report.kind === 'subtasks' && report.items.length > 0 && (
        <ul className="g-done-report-list">
          {report.items.map((item) => (
            <li key={item.taskId}>
              <button type="button" className="btn-text g-done-report-task" onClick={() => onOpenTask(item.taskId)} title="Открыть подзадачу">
                {item.title}
              </button>
              {item.summary ? <div className="g-done-report-text">{item.summary}</div> : <div className="muted">без сводки</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
