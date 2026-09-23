import type React from 'react'
import { useEffect, useState } from 'react'
import {
  AGENT_TITLES, modelLabel,
  type AgentInfo, type Task, type Question, type Dispatch, type BoardColumn, type Role
} from '@orca-board/core'
import type { TaskPatch } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { ReviewBlock } from './ReviewBlock'
import { AnswerBlock } from './AnswerBlock'
import { Markdown } from './Markdown'
import { Icon } from './icons'

interface Props {
  /** Актуальная задача из снимка: App находит её по id при каждом обновлении. */
  task: Task
  tasks: Task[]
  columns: BoardColumn[]
  roles: Role[]
  /** Агенты — для подписи модели роли; без них показывается сырой id модели. */
  agents?: AgentInfo[]
  dispatches: Dispatch[]
  questions: Question[]
  /** У задачи есть живой терминал. */
  running: boolean
  onClose(): void
  onUpdate(id: string, patch: TaskPatch): Promise<unknown>
  onStart(task: Task): Promise<void>
  onOpenTerminal(taskId: string): void
  onRemove(id: string): Promise<void>
  onAnswer(questionId: string, answer: string): Promise<void>
  onAccept(taskId: string): Promise<void>
  onReject(taskId: string, feedback: string): Promise<void>
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

/** Подпись исхода dispatch'а. Без outcome: ещё работает, если не завершён, иначе неизвестно. */
function outcomeLabel(d: Dispatch): { text: string; cls: string } {
  switch (d.outcome) {
    case 'done':
      return { text: 'готово', cls: 'ok' }
    case 'failed':
      return { text: 'упал', cls: 'warn' }
    case 'unknown':
      return { text: 'вышел без done', cls: 'warn' }
    default:
      return d.endedAt ? { text: 'без исхода', cls: '' } : { text: 'работает', cls: 'live' }
  }
}

/** Подпись задачи-ответа: кто читает ответ. */
export const ANSWER_FOR_TITLE = { human: 'ответ для человека', coordinator: 'ответ для координатора' } as const

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function TaskModal(props: Props): React.JSX.Element {
  const {
    task, tasks, columns, roles, agents, dispatches, questions, running,
    onClose, onUpdate, onStart, onOpenTerminal, onRemove, onAnswer, onAccept, onReject
  } = props
  const column = columns.find((c) => c.id === task.status)
  const kind = column?.kind
  const role = roles.find((r) => r.id === task.roleId)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const history = dispatches.filter((d) => d.taskId === task.id).sort((a, b) => b.startedAt - a.startedAt)
  const last = history[0]
  /** Последний сданный ответ задачи-ответа; прежние остаются в истории запусков. */
  const answered = history.find((d) => d.answer)
  const taskQuestions = questions.filter((q) => q.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt)
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

  // ---- ответы на вопросы ----
  const [freeAnswer, setFreeAnswer] = useState('')
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [answering, setAnswering] = useState(false)

  async function answer(q: Question, text: string): Promise<void> {
    if (!text.trim()) return
    setAnswering(true)
    setAnswerError(null)
    try {
      await onAnswer(q.id, text.trim())
      setFreeAnswer('')
    } catch (e) {
      setAnswerError(errorText(e))
    } finally {
      setAnswering(false)
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
    if (!window.confirm(`Удалить задачу «${task.title}»?`)) return
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
              placeholder="Название задачи"
              aria-label="Название"
            />
          ) : (
            <h3 className="task-modal-title" title={task.title}>{task.title}</h3>
          )}
          <button className="icon-btn task-modal-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon.close />
          </button>
        </div>

        <div className="task-modal-body">
          <div className="task-modal-meta">
            <div className="meta-row">
              <span className="meta-key">Роль</span>
              <span className="meta-val">
                {role?.title ?? task.roleId} · {AGENT_TITLES[task.agent]}{role?.model ? ` · ${modelLabel(agents?.find((a) => a.id === role.agent), role.model)}` : ''}
              </span>
            </div>
            {task.answerFor && (
              <div className="meta-row">
                <span className="meta-key">Результат</span>
                <span className="meta-val"><span className="chip answer">{ANSWER_FOR_TITLE[task.answerFor]}</span></span>
              </div>
            )}
            <div className="meta-row">
              <span className="meta-key">Колонка</span>
              <span className="meta-val">
                {column ? <span className="chip" style={{ borderColor: column.color, color: column.color }}>{column.title}</span> : task.status}
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Зависимости</span>
              <span className="meta-val chips">
                {task.deps.length === 0 && <span className="muted">нет</span>}
                {task.deps.map((dep) => (
                  <span key={dep} className="chip" title={byId.get(dep)?.title ?? dep}>← {byId.get(dep)?.title ?? dep}</span>
                ))}
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Ветка</span>
              <span className="meta-val mono">{task.branch ?? '—'}</span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Worktree</span>
              <span className="meta-val mono" title={task.worktree}>{task.worktree ?? '—'}</span>
            </div>
            {running && (
              <div className="meta-row">
                <span className="meta-key">Терминал</span>
                <span className="meta-val"><span className="chip live">● открыт</span></span>
              </div>
            )}
          </div>

          {task.answerFor && (
            <section className="task-modal-section">
              <h4>Ответ</h4>
              {answered?.answer ? (
                <AnswerBlock
                  answer={answered.answer}
                  summary={answered.summary}
                  answerFor={task.answerFor}
                  actionable={kind === 'needs_input' || kind === 'review'}
                  onAccept={async (decision) => {
                    // Решение идёт прямо в IPC: onAccept из App.tsx его не пробрасывает.
                    await (decision ? window.orca.review.accept(task.id, decision) : onAccept(task.id))
                    onClose()
                  }}
                  onClarify={async (text) => {
                    await onReject(task.id, text)
                    await onStart(task)
                    onClose()
                  }}
                />
              ) : (
                <div className="muted">{kind === 'in_progress' ? 'Воркер готовит ответ…' : 'Ответа ещё нет'}</div>
              )}
            </section>
          )}

          <section className="task-modal-section">
            <h4>Задание для агента</h4>
            {editable ? (
              <textarea
                className="task-modal-spec"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="Подробное описание, критерии готовности"
                aria-label="Задание для агента"
              />
            ) : (
              <pre className="task-modal-spec-view">{task.spec || 'Описания нет'}</pre>
            )}
            {editable ? (
              <div className="task-modal-save">
                {saveError && <span className="error-text">{saveError}</span>}
                <button className="btn-sm primary" disabled={!dirty || saving || !title.trim()} onClick={() => void save()}>
                  {saving ? '…' : 'Сохранить'}
                </button>
              </div>
            ) : (
              <div className="muted">Задача в работе — название и описание редактировать нельзя.</div>
            )}
          </section>

          {task.feedback && (
            <section className="task-modal-section">
              <h4>{task.answerFor ? 'Уточнение' : 'Замечания после ревью'}</h4>
              <pre className="task-modal-feedback">{task.feedback}</pre>
            </section>
          )}

          {kind === 'review' && !task.answerFor && (
            <section className="task-modal-section">
              <h4>Ревью</h4>
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

          {taskQuestions.length > 0 && (
            <section className="task-modal-section">
              <h4>Вопросы</h4>
              <div className="task-modal-questions">
                {taskQuestions.map((q) => (
                  <div key={q.id} className={`question ${q.answeredAt ? 'answered' : ''}`}>
                    <div className="q-text">{q.question}</div>
                    {q.answeredAt ? (
                      <div className="q-answer">
                        <span className="muted">Ответ ({formatDate(q.answeredAt)}):</span> {q.answer}
                      </div>
                    ) : (
                      <>
                        {q.options.length > 0 && (
                          <div className="q-options">
                            {q.options.map((o) => (
                              <button key={o.id} className="btn-sm" disabled={answering} title={o.hint} onClick={() => void answer(q, o.label)}>{o.label}</button>
                            ))}
                          </div>
                        )}
                        <div className="q-free">
                          <input
                            value={freeAnswer}
                            placeholder="Свой ответ"
                            disabled={answering}
                            onChange={(e) => setFreeAnswer(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void answer(q, freeAnswer)
                            }}
                          />
                          <button className="btn-sm primary" disabled={answering || !freeAnswer.trim()} onClick={() => void answer(q, freeAnswer)}>
                            Ответить
                          </button>
                        </div>
                        {answerError && <span className="error-text">{answerError}</span>}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="task-modal-section">
            <h4>История запусков</h4>
            {history.length === 0 && <div className="muted">Задача ещё не запускалась</div>}
            {history.map((d) => {
              const o = outcomeLabel(d)
              return (
                <div key={d.id} className="dispatch">
                  <div className="dispatch-head">
                    <span className="mono">{formatDate(d.startedAt)}</span>
                    {d.endedAt && <span className="muted">→ {formatDate(d.endedAt)}</span>}
                    <span className={`chip ${o.cls}`}>{o.text}</span>
                    {d.stuckNotified && !d.endedAt && <span className="chip warn">молчит</span>}
                  </div>
                  {d.summary && <pre className="dispatch-summary">{d.summary}</pre>}
                  {d.answer && d !== answered && (
                    <details className="dispatch-answer">
                      <summary>Прошлый ответ</summary>
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
            Удалить
          </button>
          <button className="btn-sm" disabled={busy} onClick={() => { onOpenTerminal(task.id); onClose() }}>
            Открыть терминал
          </button>
          {canStart && (
            <button className="btn-sm primary" disabled={busy} onClick={() => void run(async () => { await onStart(task); onClose() })}>
              {busy ? '…' : 'Запустить'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
