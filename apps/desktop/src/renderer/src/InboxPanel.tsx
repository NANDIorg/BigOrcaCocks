import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { globalTaskTitle, type Dispatch, type HumanRequest, type ImageAttachmentInput, type RequestResolution, type Run, type Task, type Workflow } from '@orca-board/core'
import { RequestCard, requestKindTitle, type RequestCardHandle } from './RequestCard'
import { Markdown } from './Markdown'
import { requestShowcase, requestShowcaseTaskId } from './showcase'
import { requestStageLabel, wfNodeTitles } from './cardState'
import { Icon } from './icons'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'
import { builtinText } from './defaultTitles'

interface Props {
  open: boolean
  /** Запросы активного проекта (snapshot.requests); показываются только pending. */
  requests: HumanRequest[]
  tasks: Task[]
  runs: Run[]
  /** Запуски воркеров: показ человеку у approval (`showcaseDispatchId`). */
  dispatches: Dispatch[]
  /** Граф воркфлоу прогона (`workflowForRun`) — для метки этапа у вопросов с этапа «Вопрос человеку»; нет — метки нет. */
  workflowOf?(runId: string): Workflow | undefined
  /** Открыть на этом запросе (клик по уведомлению); nonce — чтобы повторный клик по тому же сработал. */
  focus: { requestId: string; nonce: number } | null
  onClose(): void
  onOpenTerminal(taskId: string): void
}

/** Число ждущих человека запросов — бейдж «Входящие» в шапке. */
export const pendingRequests = (requests: HumanRequest[] | undefined): HumanRequest[] =>
  (requests ?? []).filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)

/** Горячие клавиши не перехватываются, пока ввод идёт в поле или поверх открыта модалка. */
function typingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Инбокс: выезжающая справа панель со всеми запросами к человеку проекта (HumanRequest pending).
 * Отвеченный запрос скрывается сразу (оптимистично) и выбор переходит на следующий; ошибка IPC
 * возвращает карточку с текстом ошибки. Панель остаётся смонтированной и когда закрыта — черновики
 * ответов в карточках не теряются. Клавиши: j/k, 1–9, A, C, R, Enter — в поле, Esc.
 */
export function InboxPanel({ open, requests, tasks, runs, dispatches, workflowOf, focus, onClose, onOpenTerminal }: Props): React.JSX.Element {
  const t = useT()
  const pending = pendingRequests(requests)
  /** Отправленные, но ещё не подтверждённые снимком: карточка скрыта, но смонтирована (черновик, откат). */
  const [sent, setSent] = useState<Set<string>>(() => new Set())
  const visible = pending.filter((r) => !sent.has(r.id))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [full, setFull] = useState<HumanRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const cards = useRef(new Map<string, RequestCardHandle>())
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const panelRef = useRef<HTMLElement>(null)

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const runById = new Map(runs.map((r) => [r.id, r]))
  const where = (r: HumanRequest): string => {
    const run = runById.get(r.runId)
    const task = r.taskId !== undefined ? taskById.get(r.taskId) : undefined
    // Approval уровня прогона задачи не имеет: после названия глобальной задачи — нода воркфлоу, на которой он ждёт.
    const node = r.taskId === undefined && r.nodeId ? wfNodeTitles(workflowOf?.(r.runId))[r.nodeId] : undefined
    return [run ? builtinText(globalTaskTitle(run)) : undefined, task?.title ?? r.taskId ?? node].filter(Boolean).join(' › ')
  }

  const stageOf = (r: HumanRequest): string | undefined =>
    r.nodeId && r.kind === 'question' ? requestStageLabel(r, wfNodeTitles(workflowOf?.(r.runId))) : undefined

  // Выбранная карточка пропала (решена, отменена) — выбор на первую видимую.
  const current = visible.find((r) => r.id === activeId) ?? visible[0]

  // Подтверждённые снимком (запрос больше не pending) из «отправленных» убираем.
  const pendingKey = pending.map((r) => r.id).join(',')
  useEffect(() => {
    setSent((prev) => {
      const ids = new Set(pending.map((r) => r.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey])

  // Клик по уведомлению: выбрать запрос, как только он есть в снимке (проект мог только что смениться).
  useEffect(() => {
    if (!focus || !pending.some((r) => r.id === focus.requestId)) return
    select(focus.requestId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, pendingKey])

  // Открыли панель — фокус на выбранную карточку, чтобы сразу работали клавиши.
  useEffect(() => {
    if (open) focusCard(current?.id)
    else setFull(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function focusCard(id: string | undefined): void {
    setTimeout(() => {
      const node = id ? nodes.current.get(id) : undefined
      if (node) {
        node.focus({ preventScroll: true })
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      } else panelRef.current?.focus()
    }, 0)
  }

  function select(id: string | undefined): void {
    if (!id) return
    setActiveId(id)
    focusCard(id)
  }

  function step(delta: number): void {
    if (!visible.length) return
    const i = current ? visible.indexOf(current) : -1
    select(visible[Math.min(visible.length - 1, Math.max(0, i + delta))].id)
  }

  async function resolve(r: HumanRequest, resolution: RequestResolution, images?: ImageAttachmentInput[]): Promise<void> {
    // Следующий — тот, что был ниже (или выше, если решали последний).
    const i = visible.findIndex((x) => x.id === r.id)
    const next = visible[i + 1] ?? visible[i - 1]
    setSent((prev) => new Set(prev).add(r.id))
    setNotice(null)
    if (current?.id === r.id) select(next?.id)
    try {
      const res = await window.orca.requests.resolve(r.id, resolution, images)
      if (res.startError) setNotice(t('shell.app.startError', { title: r.title, error: res.startError }))
    } catch (e) {
      setSent((prev) => {
        const nextSet = new Set(prev)
        nextSet.delete(r.id)
        return nextSet
      })
      select(r.id)
      throw new Error(ipcErrorMessage(e))
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (full) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setFull(null)
          focusCard(current?.id)
        }
        return
      }
      // Поверх Инбокса открыта модалка (задача, настройки) — клавиши её.
      if (document.querySelector('.modal-backdrop')) return
      if (typingTarget(e.target)) return
      // Enter на кнопке — её нажатие, а не переход в поле.
      if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'BUTTON') return
      const card = current ? cards.current.get(current.id) : undefined
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const handled = ((): boolean => {
        switch (key) {
          case 'Escape': onClose(); return true
          case 'j': case 'о': case 'ArrowDown': step(1); return true
          case 'k': case 'л': case 'ArrowUp': step(-1); return true
          case 'a': case 'ф': card?.accept(); return true
          case 'c': case 'с': card?.clarify(); return true
          case 'r': case 'к': card?.restart(); return true
          case 'Enter': card?.focusInput(); return true
          default:
            if (/^[1-9]$/.test(key)) {
              card?.option(Number(key))
              return true
            }
            return false
        }
      })()
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      {open && <div className="inbox-scrim" onClick={onClose} />}
      <aside ref={panelRef} tabIndex={-1} className={`inbox ${open ? 'open' : ''}`} aria-label={t('shell.inbox.title')} inert={!open}>
        <div className="inbox-head">
          <h3>{t('shell.inbox.title')}{visible.length > 0 && <span className="inbox-count">{visible.length}</span>}</h3>
          <kbd className="rq-kbd" title={t('shell.toggle')}>⌘J</kbd>
          <button className="icon-btn task-modal-close" title={t('shell.closeEsc')} aria-label={t('common.close')} onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        {notice && (
          <div className="inbox-notice">
            <span className="error-text">{notice}</span>
            <button className="btn-text" onClick={() => setNotice(null)}>{t('shell.inbox.ok')}</button>
          </div>
        )}
        <div className="inbox-list">
          {visible.length === 0 && <div className="empty">{t('shell.inbox.empty')}</div>}
          {pending.map((r) => (
            <div
              key={r.id}
              ref={(el) => {
                if (el) nodes.current.set(r.id, el)
                else nodes.current.delete(r.id)
              }}
              tabIndex={-1}
              className={`inbox-item${sent.has(r.id) ? ' sent' : ''}`}
            >
              <RequestCard
                ref={(h) => {
                  if (h) cards.current.set(r.id, h)
                  else cards.current.delete(r.id)
                }}
                request={r}
                showcase={requestShowcase(r, dispatches)}
                showcaseTaskId={requestShowcaseTaskId(r, dispatches)}
                where={where(r)}
                stage={stageOf(r)}
                active={open && current?.id === r.id}
                onSelect={() => setActiveId(r.id)}
                onResolve={(res, images) => resolve(r, res, images)}
                onOpenFull={setFull}
                onOpenTerminal={(taskId) => {
                  onClose()
                  onOpenTerminal(taskId)
                }}
                onEscape={() => focusCard(r.id)}
              />
            </div>
          ))}
        </div>
        <div className="inbox-foot muted">
          <kbd className="rq-kbd">j</kbd>/<kbd className="rq-kbd">k</kbd> {t('shell.inbox.footSelect')} · <kbd className="rq-kbd">1–9</kbd> {t('shell.inbox.footOption')} ·{' '}
          <kbd className="rq-kbd">↵</kbd> {t('shell.inbox.footInput')} · <kbd className="rq-kbd">Esc</kbd> {t('shell.inbox.footClose')}
        </div>
      </aside>

      {full && (
        <div className="inbox-full-backdrop" onClick={() => { setFull(null); focusCard(current?.id) }}>
          <div className="modal inbox-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={full.title}>
            <div className="task-modal-head">
              <div className="inbox-full-title">
                <div className="rq-kind">{requestKindTitle(full.kind)} · {where(full)}</div>
                <h3 title={full.title}>{full.title}</h3>
              </div>
              <button className="icon-btn task-modal-close" title={t('shell.closeEsc')} aria-label={t('common.close')} onClick={() => { setFull(null); focusCard(current?.id) }}>
                <Icon.close />
              </button>
            </div>
            <div className="task-modal-body">
              <Markdown text={full.body ?? ''} variant="doc" />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
