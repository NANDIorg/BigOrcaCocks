import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AssistantChatMessage } from '../../shared/ipc'
import { Terminal } from './Terminal'
import { Markdown } from './Markdown'
import { Icon } from './icons'
import type { AssistantTerminal } from './assistantPty'
import {
  applyChatUpdate, checkChatSupport, chatStateFromSnapshot, emptyChatState, groupMessages, isStuckThinking,
  readAssistantViewMode, writeAssistantViewMode, type AssistantViewMode, type ChatState, type ChatSupport
} from './assistantChat'
import { ipcErrorMessage } from './ipcError'
import { useT, type TFunction, type TKey } from './i18n'

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

/** Enter — отправить, Shift+Enter — перенос строки, Esc — выйти из поля (не закрывая панель). */
function composeKeys(send: () => void): (e: React.KeyboardEvent<HTMLTextAreaElement>) => void {
  return (e) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }
}

/** Одна реплика ленты: tool-вызовы — свёрнутой строкой (имя + краткие аргументы + статус), текст — через Markdown. */
function ChatMessageRow({ message, t }: { message: AssistantChatMessage; t: TFunction }): React.JSX.Element {
  return (
    <div className={`chat-msg chat-msg-${message.role}`}>
      {message.toolCalls?.map((c, i) => (
        <div key={i} className={`chat-tool chat-tool-${c.status}`} title={c.input}>
          <span className="chat-tool-status">
            {c.status === 'running' ? <span className="update-spin"><Icon.spinner /></span> : c.status === 'ok' ? <Icon.check /> : <Icon.info />}
          </span>
          <span className="chat-tool-name">{c.name}</span>
          <span className="chat-tool-input">{c.input}</span>
          <span className="chat-tool-label muted">{t(`shell.assistant.tool.${c.status}` as TKey)}</span>
        </div>
      ))}
      {message.text && <Markdown text={message.text} />}
      {message.hasImage && <div className="chat-image muted">{t('shell.assistant.hasImage')}</div>}
    </div>
  )
}

/**
 * Ассистент доски: выезжающая справа панель. Чат (по умолчанию) — сообщения из транскрипта агента поверх того же
 * PTY (docs/assistant-chat.md), терминал (xterm) — под капотом и как фолбэк, когда чат недоступен. Переключатель
 * в шапке запоминает выбор; терминалы не размонтируются при переключении и закрытии панели — вывод и история xterm
 * сохраняются.
 * Esc закрывает панель, только если фокус не в терминале и не в поле чата: в xterm Esc нужен агенту (прервать
 * ответ), в поле чата — просто снять фокус.
 */
export function AssistantPanel({ open, terminals, activePty, status, onClose, onReset, onOpenInTerminals }: Props): React.JSX.Element {
  const t = useT()
  const panelRef = useRef<HTMLElement>(null)
  const [mode, setMode] = useState<AssistantViewMode>(readAssistantViewMode)
  const [chatSupport, setChatSupport] = useState<ChatSupport>('checking')
  const [chat, setChat] = useState<ChatState>(emptyChatState)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const feedRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const composeRef = useRef<HTMLTextAreaElement>(null)

  function chooseMode(next: AssistantViewMode): void {
    setMode(next)
    writeAssistantViewMode(next)
  }

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

  // Доступность чата и подписка на транскрипт этого PTY: короткий повтор, пока файл сессии не появился
  // (первые секунды после старта) или пока preload/main не подтвердят поддержку.
  useEffect(() => {
    setChat(emptyChatState())
    setSendError(null)
    setChatSupport(activePty ? 'checking' : 'unavailable')
    if (!activePty) return
    let cancelled = false
    let subscribed = false
    let unsubscribe: (() => void) | undefined

    async function tick(): Promise<void> {
      const support = await checkChatSupport(window.orca, activePty!)
      if (cancelled) return
      setChatSupport(support)
      if (support !== 'available' || subscribed) return
      try {
        const snapshot = await window.orca.assistantChat.getMessages(activePty!)
        if (cancelled) return
        subscribed = true
        setChat(chatStateFromSnapshot(snapshot))
        unsubscribe = window.orca.assistantChat.onMessage(activePty!, (u) => setChat((prev) => applyChatUpdate(prev, u)))
      } catch {
        // Гонка с завершением PTY — следующий тик перечитает available().
      }
    }

    void tick()
    const timer = setInterval(() => {
      if (!subscribed) void tick()
    }, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe?.()
    }
  }, [activePty])

  // «Зависшее» ожидание пересчитывается по таймеру, а не только по новым сообщениям — иначе индикатор
  // не появится, пока лента молчит.
  useEffect(() => {
    if (chat.status !== 'thinking') return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [chat.status])

  const showChat = mode === 'chat' && chatSupport === 'available'
  const groups = groupMessages(chat.messages)
  const lastAt = chat.messages.length ? chat.messages[chat.messages.length - 1].at : undefined
  const stuck = isStuckThinking(chat.status, lastAt, now)

  // Открытие панели в режиме чата и переключение Терминал→Чат — фокус сразу на поле ввода (⌘K → печатать).
  useEffect(() => {
    if (open && showChat) composeRef.current?.focus()
  }, [open, showChat])

  useLayoutEffect(() => {
    if (!showChat) return
    const el = feedRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [showChat, chat.messages, chat.status])

  function onFeedScroll(): void {
    const el = feedRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || !activePty || sending) return
    setSending(true)
    setSendError(null)
    stickToBottomRef.current = true
    try {
      await window.orca.assistantChat.send(activePty, text)
      setDraft('')
    } catch (e) {
      setSendError(t('shell.assistant.sendError', { error: ipcErrorMessage(e) }))
    } finally {
      setSending(false)
      composeRef.current?.focus()
    }
  }

  const chatButtonTitle =
    chatSupport === 'stale' ? t('shell.assistant.chatStaleApp') : chatSupport === 'available' ? t('shell.assistant.mode.chatHint') : t('shell.assistant.mode.chatUnavailable')

  return (
    <>
      {open && <div className="inbox-scrim" onClick={onClose} />}
      <aside ref={panelRef} tabIndex={-1} className={`inbox assistant ${open ? 'open' : ''}`} aria-label={t('shell.assistant.title')} inert={!open}>
        <div className="inbox-head">
          <h3>
            <span className="assistant-title">{t('shell.assistant.title')}</span>
          </h3>
          <div className="assistant-modebar" role="group" aria-label={t('shell.assistant.title')}>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={mode === 'chat'}
              disabled={chatSupport !== 'available'}
              title={chatButtonTitle}
              onClick={() => chooseMode('chat')}
            >
              <Icon.chat />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={mode === 'terminal'}
              title={t('shell.assistant.mode.terminalHint')}
              onClick={() => chooseMode('terminal')}
            >
              <Icon.terminal />
            </button>
          </div>
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
        {chatSupport === 'stale' && (
          <div className="inbox-notice">
            <span className="error-text">{t('shell.assistant.chatStaleApp')}</span>
          </div>
        )}
        <div className="assistant-body">
          {showChat && activePty && (
            <div className="assistant-chat">
              <div className="chat-feed" ref={feedRef} onScroll={onFeedScroll}>
                {groups.length === 0 && chat.status !== 'thinking' && <div className="chat-empty muted">{t('shell.assistant.chatEmpty')}</div>}
                {groups.map((g, i) => (
                  <div key={i} className={`chat-group chat-${g.speaker}`}>
                    <div className="chat-speaker">{t(g.speaker === 'human' ? 'shell.assistant.chatYou' : 'shell.assistant.chatAgent')}</div>
                    {g.messages.map((m) => <ChatMessageRow key={m.id} message={m} t={t} />)}
                  </div>
                ))}
                {chat.status === 'thinking' && (
                  <div className="chat-thinking muted">
                    <span className="update-spin"><Icon.spinner /></span>{t('shell.assistant.thinking')}
                  </div>
                )}
              </div>
              {stuck && (
                <div className="chat-hint">
                  <span>{t('shell.assistant.stuckHint')}</span>
                  <button className="btn-text" onClick={() => chooseMode('terminal')}>{t('shell.assistant.mode.terminal')}</button>
                </div>
              )}
              {sendError && (
                <div className="chat-error">
                  <span className="error-text">{sendError}</span>
                </div>
              )}
              <div className="chat-compose">
                <textarea
                  ref={composeRef}
                  value={draft}
                  placeholder={t('shell.assistant.composePlaceholder')}
                  aria-label={t('shell.assistant.composeLabel')}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={composeKeys(() => void send())}
                />
                <button className="btn-sm primary" disabled={sending || !draft.trim()} onClick={() => void send()} title={t('shell.assistant.sendHint')}>
                  {sending ? '…' : t('shell.assistant.send')}
                </button>
              </div>
            </div>
          )}
          <div className={`terms${showChat ? ' hidden' : ''}`}>
            {terminals.map((term) => (
              <div key={term.ptyId} className={`term ${term.ptyId === activePty ? '' : 'hidden'}`}>
                <Terminal ptyId={term.ptyId} initialTail={term.tail} visible={open && !showChat && term.ptyId === activePty} />
              </div>
            ))}
          </div>
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
