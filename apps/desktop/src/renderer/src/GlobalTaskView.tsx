import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AgentSession, BoardColumn, ColumnKind, Dispatch, GlobalTask, HumanRequest, ImageAttachmentInput, RequestResolution, Task, Workflow } from '@orca-board/core'
import { AttentionFeed } from './AttentionFeed'
import type { AttentionItem } from './attention'
import { focusBoard, focusFeed, onRevealOnBoard } from './feedLink'
import { screenKey, tabKey } from './hotkeys'
import { GlobalTaskHeader } from './GlobalTaskHeader'
import { GlobalOverview } from './GlobalOverview'
import { CoordinatorPanel } from './CoordinatorPanel'
import { GlobalHistory } from './GlobalHistory'
import { GlobalStatsPanel } from './GlobalStatsPanel'
import type { StatsSnapshot } from './taskStatsFormat'
import {
  defaultTab, readTabChoice, resolveTab, stepTab, tabAt, tabTitle, visibleTabs, writeTabChoice, type GlobalTabId
} from './globalScreen'
import { useT } from './i18n'
import { runStageLabel } from './runStage'

interface Props {
  /** Проект: id для `stats:global`. */
  projectId: string
  global: GlobalTask
  /** Вид колонки глобального канбана, где сейчас задача (review — «Проверка»). */
  statusKind?: ColumnKind
  /** Живой координатор этой глобальной задачи (ptyId), если есть. */
  coordinatorPty?: string
  /** Запуски координатора (`Run.coordinatorSessions`) — пилюля в шапке и события «Истории». Со старым main поля нет. */
  coordinatorSessions?: AgentSession[]
  /** Колонки глобального канбана (`globalBoardColumns`) — шаги степпера статуса в шапке. */
  globalColumns?: BoardColumn[]
  onBack(): void
  onEdit(): void
  /** Клик по шагу степпера: перенести задачу в колонку. */
  onMove(status: string): void
  onStartCoordinator(): void
  onShowCoordinator(ptyId: string): void
  /** «■ Остановить» координатора (после подтверждения в шапке и на вкладке «Координатор»): закрыть его PTY. */
  onStopCoordinator(ptyId: string): void
  /** «⋯ → Удалить задачу…». */
  onRemove?(): void
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
  /** Снимок проекта для вкладки «Статистика»: когда её перечитывать и запасной расчёт при старом main. */
  statsSnapshot: StatsSnapshot
  onResolveRequest(request: HumanRequest, resolution: RequestResolution, images?: ImageAttachmentInput[]): Promise<void>
  /** «Открыть полностью» у ответа — модалка подзадачи. */
  onOpenTask(taskId: string): void
  onOpenTerminal(taskId: string): void
  /** Ответ на вопрос воркера без запроса (лента, как у карточки доски). */
  onAnswerQuestion(questionId: string, answer: string): Promise<void>
  /** «Принять» / «Вернуть» / «Уточнить» готовой задачи прямо в ленте (`review.accept` / `review.reject`). */
  onAcceptTask(taskId: string): Promise<void>
  onRejectTask(taskId: string, feedback: string, images?: ImageAttachmentInput[]): Promise<void>
  /** «↻ Перезапустить» упавшего воркера в ленте. */
  onStartTask(task: Task): void | Promise<void>
  /** Название типа задачи (`globalTypeTitle`) — чип рядом с приоритетом; нет — чипа нет. */
  typeTitle?: string
  /** Граф воркфлоу этой глобальной задачи (`workflowForRun`): этап в шапке и названия этапов в «Истории». Нет — этапов не видно. */
  workflow?: Workflow
  /** Доска подзадач (Board), уже отфильтрованная по этой глобальной задаче. */
  children: React.ReactNode
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * Экран глобальной задачи: шапка, лента «Ждут вас» (видна на любой вкладке) и вкладки «Доска · Итог и цель ·
 * Координатор · История · Статистика». Вкладка по умолчанию зависит от состояния (`defaultTab`), выбор человека запоминается
 * по id задачи. Доска остаётся смонтированной и на чужих вкладках (только скрыта): фильтры и выделение
 * не пропадают, а события ленты (`feedLink`) находят получателя.
 */
export function GlobalTaskView(props: Props): React.JSX.Element {
  const t = useT()
  const { global, statusKind, coordinatorPty, onBack, children } = props
  const { attention, tasks, dispatches, columns, typeTitle } = props
  const tabs = visibleTabs(global)
  const initial = (): GlobalTabId => resolveTab(readTabChoice(browserStorage(), global.id), statusKind, tabs)

  // Вкладка привязана к задаче: при смене `global.id` пересчитываем при рендере, а не в эффекте — иначе один кадр
  // покажет вкладку прежней задачи. Живая смена статуса вкладку не трогает: экран не должен прыгать под рукой.
  const [shown, setShown] = useState<{ id: string; tab: GlobalTabId }>(() => ({ id: global.id, tab: initial() }))
  let tab = shown.tab
  if (shown.id !== global.id) {
    tab = initial()
    setShown({ id: global.id, tab })
  }
  const tabRef = useRef(tab)
  tabRef.current = tab
  const tablistRef = useRef<HTMLDivElement>(null)

  /** Выбор человека: показать вкладку и запомнить его по id задачи (с вкладкой по умолчанию того момента). */
  const selectTab = (id: GlobalTabId, focusTab = false): void => {
    setShown({ id: global.id, tab: id })
    writeTabChoice(browserStorage(), global.id, { tab: id, base: defaultTab(statusKind) })
    if (focusTab) tablistRef.current?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus({ preventScroll: true })
  }

  /** Показать доску сразу, синхронно: следом ей шлют фокус и выделение карточки, а скрытая доска их не примет. */
  const showBoard = (): void => {
    if (tabRef.current === 'board') return
    flushSync(() => setShown({ id: global.id, tab: 'board' }))
  }

  // Клавиши экрана (`screenKey`, `tabKey`): Esc — назад к общей доске, G — фокус между лентой «Ждут вас» и доской
  // (на доске сперва открывается её вкладка), Alt+1…5 и 1…5 вне доски — вкладки. Один обработчик на всё: поля ввода,
  // модалки и уже обработанные клавиши (меню «Переместить в…», Esc в подробностях ленты) `hotkeys` отсекает.
  const keys = useRef({ onBack, attention: attention.length, tabs, selectTab, showBoard })
  keys.current = { onBack, attention: attention.length, tabs, selectTab, showBoard }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const modal = document.querySelector('.modal-backdrop') !== null
      const k = keys.current
      const index = tabKey(e, modal)
      if (index !== undefined) {
        const id = tabAt(k.tabs, index)
        if (id) {
          e.preventDefault()
          k.selectTab(id, true)
        }
        return
      }
      const key = screenKey(e, modal)
      if (!key) return
      if (key === 'back') {
        k.onBack()
        return
      }
      if (k.attention === 0) return
      e.preventDefault()
      if ((document.activeElement as HTMLElement | null)?.closest('.attn')) {
        k.showBoard()
        focusBoard()
      } else focusFeed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Имя задачи в карточке ленты выделяет карточку на доске: доска в этот момент может быть на скрытой вкладке.
  useEffect(() => onRevealOnBoard(() => keys.current.showBoard()), [])

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = stepTab(tabs, tab, e.key)
    if (!next) return
    e.preventDefault()
    selectTab(next, true)
  }

  return (
    <div className="gt-view">
      <GlobalTaskHeader
        global={global}
        statusKind={statusKind}
        columns={props.globalColumns}
        coordinatorPty={coordinatorPty}
        coordinatorSessions={props.coordinatorSessions}
        attentionCount={attention.length}
        typeTitle={typeTitle}
        stage={runStageLabel(global, props.workflow)}
        onBack={onBack}
        onEdit={props.onEdit}
        onMove={props.onMove}
        onStartCoordinator={props.onStartCoordinator}
        onShowCoordinator={props.onShowCoordinator}
        onStopCoordinator={props.onStopCoordinator}
        onRemove={props.onRemove}
        onAccept={props.onAccept}
        onReturn={props.onReturn}
      />
      <AttentionFeed
        items={attention}
        tasks={tasks}
        runId={global.id}
        dispatches={dispatches}
        onResolveRequest={props.onResolveRequest}
        onAnswerQuestion={props.onAnswerQuestion}
        onAcceptTask={props.onAcceptTask}
        onRejectTask={props.onRejectTask}
        onStartTask={props.onStartTask}
        onOpenTask={props.onOpenTask}
        onOpenTerminal={props.onOpenTerminal}
      />
      {tabs.length > 1 && (
        <div ref={tablistRef} className="gt-tabs" role="tablist" aria-label={t('global.tabs.aria')} onKeyDown={onTabKeyDown}>
          {tabs.map((id, i) => (
            <button
              key={id}
              id={`gt-tab-${id}`}
              type="button"
              role="tab"
              data-tab={id}
              className="gt-tab"
              aria-selected={tab === id}
              aria-controls={`gt-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              title={`Alt+${i + 1}`}
              onClick={() => selectTab(id)}
            >
              {id === 'coordinator' && coordinatorPty && <span className="g-live-dot" aria-label={t('global.tabs.live')} />}
              {tabTitle(id, statusKind)}
              {id === 'board' && tasks.length > 0 && <span className="gt-tab-n">{tasks.length}</span>}
            </button>
          ))}
        </div>
      )}
      <div id="gt-panel-board" className="gt-panel gt-panel-board" role="tabpanel" aria-labelledby="gt-tab-board" hidden={tab !== 'board'}>
        {children}
      </div>
      {tab === 'overview' && (
        <div id="gt-panel-overview" className="gt-panel" role="tabpanel" aria-labelledby="gt-tab-overview">
          <GlobalOverview
            global={global}
            statusKind={statusKind}
            coordinatorPty={coordinatorPty}
            typeTitle={typeTitle}
            tasks={tasks}
            columns={columns}
            dispatches={dispatches}
            onAccept={props.onAccept}
            onReturn={props.onReturn}
            onStartCoordinator={props.onStartCoordinator}
            onOpenTask={props.onOpenTask}
          />
        </div>
      )}
      {tab === 'coordinator' && (
        <div id="gt-panel-coordinator" className="gt-panel" role="tabpanel" aria-labelledby="gt-tab-coordinator">
          <CoordinatorPanel
            global={global}
            statusKind={statusKind}
            coordinatorPty={coordinatorPty}
            sessions={props.coordinatorSessions}
            onStartCoordinator={props.onStartCoordinator}
            onShowCoordinator={props.onShowCoordinator}
            onStopCoordinator={props.onStopCoordinator}
            onReturn={props.onReturn}
          />
        </div>
      )}
      {tab === 'history' && (
        <div id="gt-panel-history" className="gt-panel" role="tabpanel" aria-labelledby="gt-tab-history">
          <GlobalHistory global={global} columns={columns} coordinatorSessions={props.coordinatorSessions} workflow={props.workflow} />
        </div>
      )}
      {tab === 'stats' && (
        <div id="gt-panel-stats" className="gt-panel" role="tabpanel" aria-labelledby="gt-tab-stats">
          <GlobalStatsPanel
            key={global.id}
            projectId={props.projectId}
            global={global}
            columns={props.globalColumns ?? columns}
            tasks={tasks}
            dispatches={dispatches}
            coordinatorLive={coordinatorPty !== undefined}
            snapshot={props.statsSnapshot}
            onOpenTask={props.onOpenTask}
          />
        </div>
      )}
    </div>
  )
}
