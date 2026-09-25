import type React from 'react'
import { useEffect, useRef } from 'react'
import { Terminal } from './Terminal'
import { Icon } from './icons'
import type { AssistantTerminal } from './assistantPty'
import { useT } from './i18n'


interface Props {
  open: boolean
  /** Терминалы ассистента (после «Новый диалог» или со старым main их бывает несколько); виден только activePty. */
  terminals: AssistantTerminal[]
  activePty: string | null
  /** Запуск идёт (assistant.open / reset) или сорвался — текст вместо терминала. */
  status: { busy: boolean; error: string | null }
  onClose(): void
  onReset(): void
  onOpenInTerminals(): void
}

/**
 * Ассистент доски: выезжающая справа панель с терминалом агента — одного на приложение, он работает со всеми
 * проектами через orca-board --project (skills/assistant.md).
 * Терминалы не размонтируются при закрытии панели и смене проекта — вывод и история xterm сохраняются.
 * Esc закрывает панель, только если фокус не в терминале: в xterm Esc нужен агенту (прервать ответ).
 */
export function AssistantPanel({ open, terminals, activePty, status, onClose, onReset, onOpenInTerminals }: Props): React.JSX.Element {
  const t = useT()
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.modal-backdrop')) return
      const target = e.target as HTMLElement | null
      if (target?.closest('.xterm')) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Терминала ещё нет (запускается) — фокус на панель, чтобы работал Esc; xterm фокусирует себя сам (visible).
  useEffect(() => {
    if (open && !activePty) panelRef.current?.focus()
  }, [open, activePty])

  return (
    <>
      {open && <div className="inbox-scrim" onClick={onClose} />}
      <aside ref={panelRef} tabIndex={-1} className={`inbox assistant ${open ? 'open' : ''}`} aria-label={t('shell.assistant.title')} inert={!open}>
        <div className="inbox-head">
          <h3>
            <span className="assistant-title">{t('shell.assistant.title')}</span>
          </h3>
          <kbd className="rq-kbd" title={t('shell.toggle')}>⌘K</kbd>
          <button className="icon-btn" title={t('shell.assistant.reset')} aria-label={t('shell.assistant.resetLabel')} onClick={onReset} disabled={status.busy}>
            <Icon.refresh />
          </button>
          <button className="icon-btn" title={t('shell.assistant.openInTerminals')} aria-label={t('shell.assistant.openInTerminalsLabel')} onClick={onOpenInTerminals} disabled={!activePty}>
            <Icon.external />
          </button>
          <button className="icon-btn task-modal-close" title={t('shell.closeEsc')} aria-label={t('common.close')} onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        {status.error && activePty && (
          <div className="inbox-notice">
            <span className="error-text">{status.error}</span>
          </div>
        )}
        <div className="assistant-body">
          {terminals.map((term) => (
            <div key={term.ptyId} className={`term ${term.ptyId === activePty ? '' : 'hidden'}`}>
              <Terminal ptyId={term.ptyId} initialTail={term.tail} visible={open && term.ptyId === activePty} />
            </div>
          ))}
          {!activePty && (
            <div className="empty">{status.error ? <span className="error-text">{status.error}</span> : t('shell.assistant.starting')}</div>
          )}
        </div>
        <div className="inbox-foot muted">
          <kbd className="rq-kbd">⌘K</kbd> {t('shell.assistant.footToggle')} · <kbd className="rq-kbd">Esc</kbd> {t('shell.assistant.footEsc')}
        </div>
      </aside>
    </>
  )
}
