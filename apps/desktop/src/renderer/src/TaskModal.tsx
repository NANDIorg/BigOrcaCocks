import type React from 'react'
import { useEffect, useState } from 'react'
import {
  AGENT_TITLES, isTaskPriority, modelLabel,
  type AgentInfo, type Task, type Question, type Dispatch, type BoardColumn, type Role, type HumanRequest,
  type RequestResolution
} from '@orca-board/core'
import type { TaskPatch } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { ReviewBlock } from './ReviewBlock'
import { AnswerBlock } from './AnswerBlock'
import { RequestCard, REQUEST_KIND_TITLE } from './RequestCard'
import { Markdown } from './Markdown'
import { ShowcaseBlock } from './ShowcaseBlock'
import { latestShowcase, requestShowcase } from './showcase'
import { Icon } from './icons'
import { formatDuration, taskDuration, taskTicking } from './duration'
import { useNow } from './useNow'
import { priorityEditable, priorityTitle, stalePriorityMessage, taskPriorityOf } from './taskPriority'
import { PriorityOptions } from './Priority'
import { StatusHistoryBlock } from './StatusHistoryBlock'
import { TaskStatsBlock } from './TaskStatsBlock'
import type { StatsSnapshot } from './taskStatsFormat'
import { answerForTitle, formatTaskDate as formatDate, outcomeLabel, resolutionText } from './taskModalText'
import { useT } from './i18n'

interface Props {
  /** Проект: id для `stats:task`. */
  projectId: string
  /** Актуальная задача из снимка: App находит её по id при каждом обновлении. */
  task: Task
  tasks: Task[]
  columns: BoardColumn[]
  /** Роли типа глобальной задачи этой задачи (`rolesForRun`). */
  roles: Role[]
  /** Агенты — для подписи модели роли; без них показывается сырой id модели. */
  agents?: AgentInfo[]
  dispatches: Dispatch[]
  questions: Question[]
  /** Запросы к человеку проекта: pending этой задачи — «Нужен ваш ответ», решённые — история. */
  requests: HumanRequest[]
  /** Снимок проекта для «Статистики»: когда её перечитывать и запасной расчёт при старом main. */
  statsSnapshot: StatsSnapshot
  /** У задачи есть живой терминал. */
  running: boolean
  onClose(): void
  onUpdate(id: string, patch: TaskPatch): Promise<unknown>
  onStart(task: Task): Promise<void>
  onOpenTerminal(taskId: string): void
  onRemove(id: string): Promise<void>
  /** Ответ на вопрос, приёмка и уточнение ответа, перезапуск эскалации — всё через requests.resolve. */
  onResolveRequest(request: HumanRequest, resolution: RequestResolution): Promise<void>
  /** Ревью кода (не задачи-ответа). */
  onAccept(taskId: string): Promise<void>
  onReject(taskId: string, feedback: string): Promise<void>
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function TaskModal(props: Props): React.JSX.Element {
  const {
    projectId, task, tasks, columns, roles, agents, dispatches, questions, requests, statsSnapshot, running,
    onClose, onUpdate, onStart, onOpenTerminal, onRemove, onResolveRequest, onAccept, onReject
  } = props
  const t = useT()
  const column = columns.find((c) => c.id === task.status)
  const kind = column?.kind
  const role = roles.find((r) => r.id === task.roleId)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const now = useNow()
  const duration = taskDuration(task, now)
  const history = dispatches.filter((d) => d.taskId === task.id).sort((a, b) => b.startedAt - a.startedAt)
  const last = history[0]
  /** Последний сданный ответ задачи-ответа; прежние остаются в истории запусков. */
  const answered = history.find((d) => d.answer)
  const taskRequests = requests.filter((r) => r.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt)
  const pending = taskRequests.filter((r) => r.status === 'pending')
  const resolved = taskRequests.filter((r) => r.status !== 'pending')
  /** Вопросы без запроса к человеку — их решает координатор; с запросом — в «Нужен ваш ответ» / истории. */
  const withRequest = new Set(taskRequests.map((r) => r.questionId).filter(Boolean))
  const coordinatorQuestions = questions
    .filter((q) => q.taskId === task.id && !withRequest.has(q.id))
    .sort((a, b) => a.createdAt - b.createdAt)
  const answerPending = pending.some((r) => r.kind === 'answer')
  /** Последний показ задачи; если его уже выводит ждущий approval — второй раз не нужен. */
  const showcased = latestShowcase(dispatches, task.id)
  const showcaseInRequest = pending.some((r) => r.showcaseDispatchId === showcased?.id && requestShowcase(r, dispatches))
  const editable = kind !== 'in_progress'
  const canStart =
    (kind === 'ready' || kind === 'backlog' || last?.outcome === 'unknown' || last?.outcome === 'failed') && !running

  // ---- редактирование названия и описания ----
  const [title, setTitle] = useState(task.title)
  const [spec, setSpec] = useState(task.spec)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = title !== task.title || spec !== task.spec
  // Задача обновилась снаружи (или открыли другую) — подхватываем, пока нет несохранённых правок.
  useEffect(() => {
    setTitle(task.title)
    setSpec(task.spec)
    setSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.title, task.spec])

  async function save(): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      await onUpdate(task.id, { title: title.trim(), spec })
    } catch (e) {
      setSaveError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  // ---- приоритет: сохраняется сразу, в любой колонке ----
  const priority = taskPriorityOf(task)
  const [priorityError, setPriorityError] = useState<string | null>(null)
  const [prioritySaving, setPrioritySaving] = useState(false)

  async function changePriority(next: string): Promise<void> {
    if (!isTaskPriority(next) || next === priority) return
    setPrioritySaving(true)
    setPriorityError(null)
    try {
      await onUpdate(task.id, { priority: next })
    } catch (e) {
      setPriorityError(errorText(e))
    } finally {
      setPrioritySaving(false)
    }
  }

  // ---- нижние кнопки ----
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(t('board.confirmRemove', { title: task.title }))) return
    await run(async () => {
      await onRemove(task.id)
      onClose()
    })
  }

  // Esc закрывает модалку.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={task.title}>
        <div className="task-modal-head">
          <AgentLogo agent={task.agent} size={28} />
          {editable ? (
            <input
              className="task-modal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('board.task.titlePlaceholder')}
              aria-label={t('board.task.titleAria')}
            />
          ) : (
            <h3 className="task-modal-title" title={task.title}>{task.title}</h3>
          )}
          <button className="icon-btn task-modal-close" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}>
            <Icon.close />
          </button>
        </div>

        <div className="task-modal-body">
          {pending.length > 0 && (
            <section className="task-modal-section task-modal-requests">
              <h4>{t('board.task.needsYou')}</h4>
              {pending.map((r) => (
                <RequestCard
                  key={r.id}
                  request={r}
                  showcase={requestShowcase(r, dispatches)}
                  onResolve={(res) => onResolveRequest(r, res)}
                  onOpenTerminal={(taskId) => {
                    onOpenTerminal(taskId)
                    onClose()
                  }}
                />
              ))}
            </section>
          )}

          <div className="task-modal-meta">
            <div className="meta-row">
              <span className="meta-key">{t('board.task.role')}</span>
              <span className="meta-val">
                {role?.title ?? task.roleId} · {AGENT_TITLES[task.agent]}{role?.model ? ` · ${modelLabel(agents?.find((a) => a.id === role.agent), role.model)}` : ''}
              </span>
            </div>
            {task.answerFor && (
              <div className="meta-row">
                <span className="meta-key">{t('board.task.result')}</span>
                <span className="meta-val"><span className="chip answer">{answerForTitle(task.answerFor)}</span></span>
              </div>
            )}
            <div className="meta-row">
              <span className="meta-key">{t('board.task.priority')}</span>
              <span className="meta-val">
                {priorityEditable(task) ? (
                  <select
                    className="task-modal-priority"
                    value={priority}
                    disabled={prioritySaving}
                    aria-label={t('board.task.priority')}
                    onChange={(e) => void changePriority(e.target.value)}
                  >
                    <PriorityOptions />
                  </select>
                ) : (
                  // Задача без поля — main старый и приоритет не сохранит.
                  <span className="muted" title={stalePriorityMessage()}>{priorityTitle(priority)}</span>
                )}
                {priorityError && <span className="error-text">{priorityError}</span>}
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-key">{t('board.task.column')}</span>
              <span className="meta-val">
                {column ? <span className="chip" style={{ borderColor: column.color, color: column.color }}>{column.title}</span> : task.status}
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-key">{t('board.task.deps')}</span>
              <span className="meta-val chips">
                {task.deps.length === 0 && <span className="muted">{t('board.task.noDeps')}</span>}
                {task.deps.map((dep) => (
                  <span key={dep} className="chip" title={byId.get(dep)?.title ?? dep}>← {byId.get(dep)?.title ?? dep}</span>
                ))}
              </span>
            </div>
            {duration !== undefined && (
              <div className="meta-row">
                <span className="meta-key">{t('board.task.workTime')}</span>
                <span className="meta-val" title={t('board.task.workTimeTitle')}>
                  {taskTicking(task) ? `⏱ ${formatDuration(duration)}` : formatDuration(duration)}
                </span>
              </div>
            )}
            <div className="meta-row">
              <span className="meta-key">{t('board.task.branch')}</span>
              <span className="meta-val mono">{task.branch ?? '—'}</span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Worktree</span>
              <span className="meta-val mono" title={task.worktree}>{task.worktree ?? '—'}</span>
            </div>
            {running && (
              <div className="meta-row">
                <span className="meta-key">{t('board.task.terminal')}</span>
                <span className="meta-val"><span className="chip live">● {t('board.task.terminalOpen')}</span></span>
              </div>
            )}
          </div>

          {task.answerFor && (
            <section className="task-modal-section">
              <h4>{t('board.task.answer')}</h4>
              {answered?.answer ? (
                <AnswerBlock
                  answer={answered.answer}
                  summary={answered.summary}
                  note={
                    answerPending
                      ? t('board.task.answerAcceptNote')
                      : task.answerFor === 'coordinator' && (kind === 'needs_input' || kind === 'review')
                        ? t('board.task.answerCoordNote')
                        : undefined
                  }
                />
              ) : (
                <div className="muted">{kind === 'in_progress' ? t('board.task.answerPreparing') : t('board.task.noAnswer')}</div>
              )}
            </section>
          )}

          <section className="task-modal-section">
            <h4>{t('board.task.spec')}</h4>
            {editable ? (
              <textarea
                className="task-modal-spec"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder={t('board.task.specPlaceholder')}
                aria-label={t('board.task.spec')}
              />
            ) : (
              <pre className="task-modal-spec-view">{task.spec || t('board.task.noSpec')}</pre>
            )}
            {editable ? (
              <div className="task-modal-save">
                {saveError && <span className="error-text">{saveError}</span>}
                <button className="btn-sm primary" disabled={!dirty || saving || !title.trim()} onClick={() => void save()}>
                  {saving ? '…' : t('board.task.save')}
                </button>
              </div>
            ) : (
              <div className="muted">{t('board.task.lockedNote')}</div>
            )}
          </section>

          {task.feedback && (
            <section className="task-modal-section">
              <h4>{task.answerFor ? t('board.task.clarification') : t('board.task.reviewNotes')}</h4>
              <pre className="task-modal-feedback">{task.feedback}</pre>
            </section>
          )}

          {kind === 'review' && !task.answerFor && (
            <section className="task-modal-section">
              <h4>{t('board.task.review')}</h4>
              <ReviewBlock
                taskId={task.id}
                summary={last?.summary}
                onAccept={async () => {
                  await onAccept(task.id)
                  onClose()
                }}
                onReject={async (fb) => {
                  await onReject(task.id, fb)
                  onClose()
                }}
              />
            </section>
          )}

          {resolved.length > 0 && (
            <section className="task-modal-section">
              <h4>{t('board.task.yourAnswers')}</h4>
              <div className="task-modal-questions">
                {resolved.map((r) => (
                  <div key={r.id} className="question answered">
                    <div className="q-text"><span className="muted">{REQUEST_KIND_TITLE[r.kind]}:</span> {r.title}</div>
                    <div className="q-answer">
                      {r.resolvedAt && <span className="muted">{formatDate(r.resolvedAt)}:</span>} {resolutionText(r)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {coordinatorQuestions.length > 0 && (
            <section className="task-modal-section">
              <h4>{t('board.task.coordQuestions')}</h4>
              <div className="task-modal-questions">
                {coordinatorQuestions.map((q) => (
                  <div key={q.id} className={`question ${q.answeredAt ? 'answered' : ''}`}>
                    <div className="q-text">{q.question}</div>
                    {q.answeredAt ? (
                      <div className="q-answer">
                        <span className="muted">{t('board.task.coordAnswer', { at: formatDate(q.answeredAt) })}</span> {q.answer}
                      </div>
                    ) : (
                      <div className="muted">{t('board.task.coordWaiting')}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="task-modal-section" id="task-stats">
            <h4>{t('board.task.stats')}</h4>
            <TaskStatsBlock key={task.id} projectId={projectId} task={task} columns={columns} snapshot={statsSnapshot} />
          </section>

          <section className="task-modal-section">
            <h4>{t('board.task.statusHistory')}</h4>
            <StatusHistoryBlock history={task.statusHistory} columns={columns} status={task.status} />
          </section>

          {showcased?.showcase && !showcaseInRequest && (
            <section className="task-modal-section">
              <h4>{t('board.showcase.title')} <span className="muted">· {t('board.task.showcaseRun', { at: formatDate(showcased.startedAt) })}</span></h4>
              <ShowcaseBlock taskId={task.id} showcase={showcased.showcase} bare />
            </section>
          )}

          <section className="task-modal-section">
            <h4>{t('board.task.runs')}</h4>
            {history.length === 0 && <div className="muted">{t('board.task.noRuns')}</div>}
            {history.map((d) => {
              const o = outcomeLabel(d)
              return (
                <div key={d.id} className="dispatch">
                  <div className="dispatch-head">
                    <span className="mono">{formatDate(d.startedAt)}</span>
                    {d.endedAt && <span className="muted">→ {formatDate(d.endedAt)}</span>}
                    <span className="muted">{d.endedAt ? '' : '⏱ '}{formatDuration((d.endedAt ?? now) - d.startedAt)}</span>
                    <span className={`chip ${o.cls}`}>{o.text}</span>
                    {d.stuckNotified && !d.endedAt && <span className="chip warn">{t('board.task.stuck')}</span>}
                  </div>
                  {d.summary && <pre className="dispatch-summary">{d.summary}</pre>}
                  {d.answer && d !== answered && (
                    <details className="dispatch-answer">
                      <summary>{t('board.task.prevAnswer')}</summary>
                      <Markdown text={d.answer} />
                    </details>
                  )}
                  {d.files && d.files.length > 0 && (
                    <ul className="dispatch-files">
                      {d.files.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                  )}
                </div>
              )
            })}
          </section>
        </div>

        <div className="task-modal-foot">
          {actionError && <span className="error-text">{actionError}</span>}
          <div className="grow" />
          <button className="btn-sm danger" disabled={busy} onClick={() => void remove()}>
            {t('board.remove')}
          </button>
          <button className="btn-sm" disabled={busy} onClick={() => { onOpenTerminal(task.id); onClose() }}>
            {t('board.task.openTerminal')}
          </button>
          {canStart && (
            <button className="btn-sm primary" disabled={busy} onClick={() => void run(async () => { await onStart(task); onClose() })}>
              {busy ? '…' : t('board.card.start')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
