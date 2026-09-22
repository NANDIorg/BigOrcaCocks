import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GlobalTask } from '@orca-board/core'
import { Icon } from './icons'
import { GlobalProgress, relativeTime } from './GlobalBoard'

interface Props {
  global: GlobalTask
  /** Живой координатор этой глобальной задачи (ptyId), если есть. */
  coordinatorPty?: string
  onBack(): void
  onEdit(): void
  onStartCoordinator(): void
  onShowCoordinator(ptyId: string): void
  /** Доска подзадач (Board), уже отфильтрованная по этой глобальной задаче. */
  children: React.ReactNode
}

/** Экран глобальной задачи: хлебные крошки, заголовок, описание и канбан только её подзадач. */
export function GlobalTaskView(props: Props): React.JSX.Element {
  const { global, coordinatorPty, onBack, onEdit, onStartCoordinator, onShowCoordinator, children } = props
  const [expanded, setExpanded] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)

  // Открыли с клавиатуры/мышью — фокус на «назад», чтобы Enter/Escape сразу вели обратно.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true })
    setExpanded(false)
  }, [global.id])

  // Escape — назад к общей доске, если фокус не в поле ввода и не открыта модалка (они ловят Escape сами).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el && (el.closest('input, textarea, select, [contenteditable]') || el.closest('.modal-backdrop'))) return
      if (document.querySelector('.modal-backdrop')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

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
            {!global.inbox &&
              (coordinatorPty ? (
                <button type="button" className="btn-sm" onClick={() => onShowCoordinator(coordinatorPty)}>
                  <span className="g-live-dot" aria-hidden /> Координатор работает
                </button>
              ) : (
                <button type="button" className="btn-sm" onClick={onStartCoordinator}><Icon.play /> Запустить координатора</button>
              ))}
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
          <span className="muted">Обновлено {relativeTime(global.activityAt)}</span>
          {global.closedAt !== undefined && <span className="muted">· закрыта</span>}
          {global.inbox && <span className="muted">· сюда попадают задачи без глобальной</span>}
        </div>
      </div>
      {children}
    </div>
  )
}
