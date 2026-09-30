import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AssistantChatMessage } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { agentTitle } from './defaultTitles'
import { Markdown } from './Markdown'
import { Icon } from './icons'
import { AssistantInteraction } from './AssistantInteraction'
import { emptyChatState, groupMessages, subscribeAssistantChat, type ChatState } from './assistantChat'
import { ipcErrorMessage } from './ipcError'
import { useModalFocus } from './useModalFocus'
import { useT, type TFunction, type TKey } from './i18n'

interface Props {
  open: boolean
  suspended: boolean
  activePty: string | null
  status: { busy: boolean; error: string | null }
  onClose(): void
  onReset(): void
  onSettings(): void
  onOpenInTerminals(): void
}

function ChatMessageRow({ message, t }: { message: AssistantChatMessage; t: TFunction }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer) }, [copied])
  return (
    <article className={`chat-msg chat-msg-${message.role}`}>
      {message.toolCalls?.map((call, index) => (
        <details key={call.id ?? index} className={`chat-tool chat-tool-${call.status}`}>
          <summary><span className="chat-tool-status">{call.status === 'running' ? <span className="update-spin"><Icon.spinner /></span> : call.status === 'ok' ? <Icon.check /> : <Icon.info />}</span><span className="chat-tool-name">{call.name}</span><span className="chat-tool-label">{t(`shell.assistant.tool.${call.status}` as TKey)}</span><Icon.down /></summary>
          <pre>{call.input}</pre>
        </details>
      ))}
      {message.text && (message.role === 'human' ? <div className="chat-human-text">{message.text}</div> : <Markdown text={message.text} />)}
      {message.hasImage && <div className="muted">{t('shell.assistant.hasImage')}</div>}
      {message.text && <button className="chat-copy" type="button" aria-label={t('shell.assistant.copy')} title={t('shell.assistant.copy')} onClick={() => {
        void navigator.clipboard.writeText(message.text).then(() => { if (mounted.current) { setCopied(true); setCopyError(false) } }, () => { if (mounted.current) setCopyError(true) })
      }}>{copied ? <Icon.check /> : <Icon.copy />}<span>{t(copied ? 'shell.assistant.copied' : 'shell.assistant.copy')}</span></button>}
      {copyError && <span className="error-text" role="alert">{t('shell.assistant.copyError')}</span>}
    </article>
  )
}

/** Сессия и черновик живут при закрытой панели; встроенного терминала здесь нет. */
export function AssistantPanel({ open, suspended, activePty, status, onClose, onReset, onSettings, onOpenInTerminals }: Props): React.JSX.Element {
  const t = useT()
  const layerRef = useRef<HTMLDivElement>(null)
  const composeRef = useRef<HTMLTextAreaElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef(activePty)
  sessionRef.current = activePty
  const stickRef = useRef(true)
  const actionBusy = useRef(false)
  const [chat, setChat] = useState<ChatState>(emptyChatState)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [away, setAway] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { queueMicrotask(() => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }) }) }
  }, [open])
  useModalFocus(layerRef, !open || suspended)
  useEffect(() => {
    if (!open || suspended) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, suspended, onClose])
  useEffect(() => {
    setChat(emptyChatState(activePty ?? ''))
    setDraft('')
    setError(null)
    setSending(false)
    setStopping(false)
    setLoading(Boolean(activePty))
    stickRef.current = true
    setAway(false)
    actionBusy.current = false
    if (!activePty) return
    const connection = subscribeAssistantChat(window.orca, activePty, (state) => { setChat(state); setLoading(false) }, (failure) => { setError(failure === 'stale' ? t('shell.assistant.chatStaleApp') : ipcErrorMessage(failure)); setLoading(false) })
    return connection.dispose
    // Смена языка не пересоздаёт сессию и не удаляет черновик.
  }, [activePty])
  const terminal = chat.transport === 'terminal'
  const working = chat.status === 'thinking' || chat.status === 'waiting'
  const canSend = Boolean(activePty) && !terminal && !loading && !status.busy && !working && chat.status !== 'starting' && chat.status !== 'error'
  const groups = groupMessages(chat.messages)
  useLayoutEffect(() => {
    if (!open || !stickRef.current) return
    const feed = feedRef.current
    if (feed) feed.scrollTop = feed.scrollHeight
  }, [open, chat.messages, chat.interactions, chat.status])
  useLayoutEffect(() => {
    const compose = composeRef.current
    if (!compose) return
    compose.style.height = '0px'
    compose.style.height = `${Math.min(160, Math.max(64, compose.scrollHeight))}px`
  }, [draft, open])
  async function send(): Promise<void> {
    const text = draft.trim()
    const session = activePty
    if (!session || !text || !canSend || actionBusy.current) return
    actionBusy.current = true
    const submitted = draft
    setSending(true)
    setError(null)
    stickRef.current = true
    setAway(false)
    try {
      await window.orca.assistantChat.send(session, text)
      if (sessionRef.current === session) setDraft((current) => current === submitted ? '' : current)
    } catch (failure) {
      if (sessionRef.current === session) setError(t('shell.assistant.sendError', { error: ipcErrorMessage(failure) }))
    } finally {
      if (sessionRef.current === session) { actionBusy.current = false; setSending(false) }
    }
  }
  async function stop(): Promise<void> {
    if (!activePty || stopping) return
    const session = activePty
    setStopping(true)
    setError(null)
    try { await window.orca.assistantChat.interrupt(session) }
    catch (failure) { if (sessionRef.current === session) setError(ipcErrorMessage(failure)) }
    finally { if (sessionRef.current === session) setStopping(false) }
  }
  const failure = status.error ?? error ?? chat.error
  return (
    <div className={`assistant-layer${open ? ' open' : ''}`} ref={layerRef} inert={!open}>
      <div className="inbox-scrim" onClick={onClose} aria-hidden="true" />
      <aside tabIndex={-1} className={`inbox assistant${open ? ' open' : ''}`} role="dialog" aria-modal={open && !suspended ? true : undefined} aria-label={t('shell.assistant.title')}>
        <header className="assistant-head">
          <div className="assistant-avatar">{chat.agent ? <AgentLogo agent={chat.agent} size={23} /> : <Icon.chat />}</div>
          <div className="assistant-identity"><h3>{t('shell.assistant.title')}</h3><span role="status">{chat.agent ? agentTitle(chat.agent) : t('shell.assistant.chatAgent')}<span className="assistant-status-dot" />{t(`shell.assistant.status.${status.busy || loading ? 'starting' : chat.status}` as TKey)}</span></div>
          <button className="icon-btn" type="button" title={t('shell.assistant.reset')} aria-label={t('shell.assistant.resetLabel')} disabled={status.busy} onClick={onReset}><Icon.plus /></button>
          <button className="icon-btn" type="button" title={t('shell.assistant.settings')} aria-label={t('shell.assistant.settings')} onClick={onSettings}><Icon.gear /></button>
          <button className="icon-btn" type="button" title={t('shell.closeEsc')} aria-label={t('common.close')} onClick={onClose}><Icon.close /></button>
        </header>
        <div className="assistant-body">
          <div className="chat-feed" ref={feedRef} onScroll={() => {
            const feed = feedRef.current
            if (!feed) return
            const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64
            stickRef.current = near
            setAway(!near)
          }}>
            {terminal ? <div className="chat-welcome"><span className="chat-welcome-icon"><Icon.terminal /></span><h2>{t('shell.assistant.terminalTitle', { agent: agentTitle(chat.agent ?? 'shell') })}</h2><p>{t('shell.assistant.terminalDescription')}</p><button className="btn-sm primary" type="button" onClick={onOpenInTerminals}><Icon.external />{t('shell.assistant.openInTerminals')}</button></div> : <>
              {groups.length === 0 && !working && !failure && <div className="chat-welcome"><span className="chat-welcome-icon"><Icon.chat /></span><h2>{t('shell.assistant.welcomeTitle')}</h2><p>{t('shell.assistant.welcomeDescription')}</p><div className="chat-suggestions">{(['tasks', 'projects', 'settings'] as const).map((key) => <button type="button" key={key} onClick={() => { setDraft(t(`shell.assistant.suggestion.${key}.prompt`)); composeRef.current?.focus() }}><span>{key === 'tasks' ? <Icon.board /> : key === 'projects' ? <Icon.folder /> : <Icon.gear />}</span>{t(`shell.assistant.suggestion.${key}.label`)}<Icon.chevron /></button>)}</div></div>}
              {groups.map((group) => <div key={group.messages[0].id} className={`chat-group chat-${group.speaker}`}><div className="chat-speaker">{t(group.speaker === 'human' ? 'shell.assistant.chatYou' : 'shell.assistant.chatAgent')}</div>{group.messages.map((message) => <ChatMessageRow key={message.id} message={message} t={t} />)}</div>)}
              {chat.interactions.map((interaction) => <AssistantInteraction key={`${activePty}-${interaction.id}`} interaction={interaction} onAnswer={(answer) => window.orca.assistantChat.respond(activePty!, interaction.id, answer)} />)}
              {(chat.status === 'thinking' || chat.status === 'starting' || loading || status.busy) && <div className="chat-thinking" role="status"><span className="chat-typing" aria-hidden="true"><i /><i /><i /></span>{t(chat.status === 'thinking' ? 'shell.assistant.thinking' : 'shell.assistant.starting')}</div>}
              {chat.status === 'interrupted' && <div className="chat-turn-note" role="status">{t('shell.assistant.interrupted')}</div>}
            </>}
            {failure && <div className="chat-failure" role="alert"><Icon.info /><div><strong>{t('shell.assistant.errorTitle')}</strong><p>{failure}</p><button className="btn-text" type="button" disabled={status.busy} onClick={onReset}>{t('shell.assistant.retry')}</button></div></div>}
          </div>
          {away && <button className="chat-jump btn-sm" type="button" onClick={() => { stickRef.current = true; setAway(false); const feed = feedRef.current; if (feed) feed.scrollTop = feed.scrollHeight }}><Icon.down />{t('shell.assistant.latest')}</button>}
        </div>
        {!terminal && <footer className="chat-footer"><div className="chat-compose"><textarea className="resize-none" ref={composeRef} data-modal-autofocus value={draft} placeholder={t('shell.assistant.composePlaceholder')} aria-label={t('shell.assistant.composeLabel')} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><div className="chat-compose-actions"><span>{t('shell.assistant.scope')}</span>{working ? <button className="chat-send stopping" type="button" disabled={stopping} onClick={() => void stop()} title={t('shell.assistant.stop')} aria-label={t('shell.assistant.stop')}><Icon.stop /></button> : <button className="chat-send" type="button" disabled={!canSend || sending || !draft.trim()} onClick={() => void send()} title={t('shell.assistant.sendHint')} aria-label={t('shell.assistant.send')}><Icon.send /></button>}</div></div><div className="chat-compose-hint"><span>{t('shell.assistant.enterHint')}</span><span><kbd>Esc</kbd> {t('shell.assistant.footEsc')}</span></div></footer>}
      </aside>
    </div>
  )
}
