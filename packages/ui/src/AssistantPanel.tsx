import { getUiApi } from './host'
import type { WorkflowAssistantSaved } from '../shared/assistant-workflow'
import { consumeWorkflowAttachment, settledWorkflowDraft, sendWorkflowApi, workflowAssistantError, type WorkflowAttachment, type WorkflowComposerRequest } from './workflowAssistant'
import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AssistantChatMessage } from '../shared/ipc'
import type { ConversationToolCall } from '../shared/assistant-conversation'
import { AgentLogo } from './AgentLogo'
import { agentTitle } from './defaultTitles'
import { Markdown } from './Markdown'
import { Icon } from './icons'
import { AssistantInteraction } from './AssistantInteraction'
import { canSendAssistantChat, emptyChatState, groupMessages, isAssistantThinking, subscribeAssistantChat, toolActivityDetail, type ChatState } from './assistantChat'
import { assistantActivityOf, type AssistantActivity } from './assistantActivity'
import { ipcErrorMessage } from './ipcError'
import { useModalFocus } from './useModalFocus'
import { useT, type TFunction, type TKey } from './i18n'

interface Props {
  open: boolean
  suspended: boolean
  activePty: string | null
  status: { busy: boolean; error: string | null }
  onClose(): void
  onActivityChange(activity: AssistantActivity): void
  onReset(): void
  onSettings(): void
  onChooseChatAgent(sessionId: string, agent: 'amp' | 'shell'): void
  onOpenInTerminals(): void
  canOpenInTerminals: boolean
  attachment: WorkflowAttachment | null
  returnAvailable: boolean
  result: WorkflowAssistantSaved | null
  composerRequest: WorkflowComposerRequest | null
  onComposerRequestApplied(nonce: number): void
  onCreateWorkflow(): void
  onDetachWorkflow(): void
  onWorkflowSent(nonce: number): void
  onReturnWorkflow(): void
  onOpenWorkflow(): void
}

function ChatToolActivity({ call, t }: { call: ConversationToolCall; t: TFunction }): React.JSX.Element {
  const detail = toolActivityDetail(call.input)
  return <div className={`chat-activity chat-activity-${call.status}`}>
    <span className="chat-activity-icon" aria-hidden="true">{call.status === 'running' ? <span className="update-spin"><Icon.spinner /></span> : call.status === 'ok' ? <Icon.check /> : call.status === 'cancelled' ? <Icon.stop /> : <Icon.info />}</span>
    <div className="chat-activity-main"><span className="chat-activity-name">{call.name || t('shell.assistant.activity')}</span>{detail && <span className="chat-activity-detail" title={detail}>{detail}</span>}</div>
    <span className="chat-activity-status">{t(`shell.assistant.tool.${call.status}` as TKey)}</span>
  </div>
}

function ChatMessageRow({ message, t }: { message: AssistantChatMessage; t: TFunction }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer) }, [copied])
  if (message.role === 'tool') return <div className="chat-activities">{message.toolCalls?.map((call, index) => <ChatToolActivity key={call.id ?? index} call={call} t={t} />)}</div>
  return (
    <article className={`chat-msg chat-msg-${message.role}`}>
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
export function AssistantPanel({ open, suspended, activePty, status, onClose, onActivityChange, onReset, onSettings, onChooseChatAgent, onOpenInTerminals, canOpenInTerminals, attachment, returnAvailable, result, composerRequest, onComposerRequestApplied, onCreateWorkflow, onDetachWorkflow, onWorkflowSent, onReturnWorkflow, onOpenWorkflow }: Props): React.JSX.Element {
  const t = useT()
  const layerRef = useRef<HTMLDivElement>(null)
  const composeRef = useRef<HTMLTextAreaElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef(activePty)
  sessionRef.current = activePty
  const attachmentRef = useRef(attachment)
  attachmentRef.current = attachment
  const stickRef = useRef(true)
  const actionBusy = useRef(false)
  const appliedComposerNonce = useRef(0)
  const [chat, setChat] = useState<ChatState>(emptyChatState)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [away, setAway] = useState(false)
  const [loading, setLoading] = useState(true)
  // Ошибка чтения снимка завершает подключение; сбой send/interrupt не меняет настоящий статус CLI.
  const activity = assistantActivityOf(error && chat.status === 'starting' ? { ...chat, status: 'error' } : chat)
  useEffect(() => {
    onActivityChange(activity)
    // Текст стримится внутри панели; оболочка получает только значимые смены состояния.
  }, [activity.ptyId, activity.revision, activity.status, activity.responseReady, activity.terminal, onActivityChange])

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
    setError(null)
    setSending(false)
    setStopping(false)
    setLoading(Boolean(activePty))
    stickRef.current = true
    setAway(false)
    actionBusy.current = false
    if (!activePty) return
    const connection = subscribeAssistantChat(getUiApi(), activePty, (state) => { setChat(state); setLoading(false) }, (failure) => { setError(failure === 'stale' ? t('shell.assistant.chatStaleApp') : ipcErrorMessage(failure)); setLoading(false) })
    return connection.dispose
    // Смена языка не пересоздаёт сессию и не удаляет черновик.
  }, [activePty])
  useEffect(() => {
    if (open && !suspended && attachment) composeRef.current?.focus({ preventScroll: true })
  }, [open, suspended, attachment?.nonce])
  const terminal = chat.transport === 'terminal'
  useEffect(() => {
    // Видимое поле уже принимает ввод: загрузка истории не должна откладывать заполнение.
    if (!open || !composerRequest || terminal || suspended || composerRequest.nonce <= appliedComposerNonce.current) return
    appliedComposerNonce.current = composerRequest.nonce
    setDraft(composerRequest.text)
    composeRef.current?.focus({ preventScroll: true })
    onComposerRequestApplied(composerRequest.nonce)
  }, [open, composerRequest, terminal, suspended, onComposerRequestApplied])
  const working = chat.status === 'thinking' || chat.status === 'waiting'
  const canSend = Boolean(activePty) && !loading && !status.busy && canSendAssistantChat(chat)
  const groups = groupMessages(chat.messages)
  const starting = loading || status.busy || chat.status === 'starting'
  const thinkingLabel = t(starting ? 'shell.assistant.starting' : 'shell.assistant.thinking')
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
    const sentAttachment = attachmentRef.current
    setSending(true)
    setError(null)
    stickRef.current = true
    setAway(false)
    try {
      if (sentAttachment) await sendWorkflowApi(getUiApi())(session, text, sentAttachment.context)
      else await getUiApi().assistantChat.send(session, text)
      if (sessionRef.current === session && attachmentRef.current?.nonce === sentAttachment?.nonce) {
        const currentSession = sessionRef.current
        const currentNonce = attachmentRef.current?.nonce
        setDraft((current) => settledWorkflowDraft(current, submitted, session, currentSession, sentAttachment?.nonce, currentNonce))
        if (sentAttachment && consumeWorkflowAttachment(attachmentRef.current, sentAttachment, session, sessionRef.current) === null) onWorkflowSent(sentAttachment.nonce)
      }
    } catch (failure) {
      if (sessionRef.current === session) setError(t('shell.assistant.sendError', { error: workflowAssistantError(ipcErrorMessage(failure)) }))
    } finally {
      if (sessionRef.current === session) { actionBusy.current = false; setSending(false) }
    }
  }
  async function stop(): Promise<void> {
    if (!activePty || stopping) return
    const session = activePty
    setStopping(true)
    setError(null)
    try { await getUiApi().assistantChat.interrupt(session) }
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
            {terminal ? <div className="chat-welcome"><span className="chat-welcome-icon"><Icon.terminal /></span><h2>{t('shell.assistant.terminalTitle', { agent: agentTitle(chat.agent ?? 'shell') })}</h2><p>{t('shell.assistant.terminalDescription')}</p><button className="btn-sm primary" type="button" disabled={!canOpenInTerminals} onClick={onOpenInTerminals}><Icon.external />{t('shell.assistant.openInTerminals')}</button>{!canOpenInTerminals && <p role="status">{t('shell.assistant.terminalNeedsProject')}</p>}{attachment && <><p role="status">{t('shell.assistant.workflowTerminal')}</p><button className="btn-sm" type="button" onClick={() => { if (activePty && (chat.agent === 'amp' || chat.agent === 'shell')) onChooseChatAgent(activePty, chat.agent) }}>{t('shell.assistant.chooseChatAgent')}</button></>}</div> : <>
              {groups.length === 0 && !working && !failure && !chat.readOnly && <div className="chat-welcome"><span className="chat-welcome-icon"><Icon.chat /></span><h2>{t('shell.assistant.welcomeTitle')}</h2><p>{t('shell.assistant.welcomeDescription')}</p><div className="chat-suggestions">{(['tasks', 'projects', 'settings'] as const).map((key) => <button type="button" key={key} onClick={() => { setDraft(t(`shell.assistant.suggestion.${key}.prompt`)); composeRef.current?.focus() }}><span>{key === 'tasks' ? <Icon.board /> : key === 'projects' ? <Icon.folder /> : <Icon.gear />}</span>{t(`shell.assistant.suggestion.${key}.label`)}<Icon.chevron /></button>)}<button type="button" onClick={onCreateWorkflow}><span><Icon.layers /></span>{t('shell.assistant.workflowCreate')}<Icon.chevron /></button></div></div>}
              {groups.map((group) => <div key={group.messages[0].id} className={`chat-group chat-${group.speaker}`}><div className="chat-speaker">{t(group.speaker === 'human' ? 'shell.assistant.chatYou' : 'shell.assistant.chatAgent')}</div>{group.messages.map((message) => <ChatMessageRow key={message.id} message={message} t={t} />)}</div>)}
              {chat.interactions.map((interaction) => <AssistantInteraction key={`${activePty}-${interaction.id}`} interaction={interaction} onAnswer={(answer) => getUiApi().assistantChat.respond(activePty!, interaction.id, answer)} />)}
              {(starting || isAssistantThinking(chat)) && <div className="chat-thinking" role="status" aria-label={thinkingLabel}><span className="chat-thinking-text" aria-hidden="true">{thinkingLabel.replace(/…$/u, '')}</span><span className="chat-typing" aria-hidden="true"><i /><i /><i /></span></div>}
              {chat.status === 'interrupted' && !chat.readOnly && <div className="chat-turn-note" role="status">{t('shell.assistant.interrupted')}</div>}
            </>}
            {chat.readOnly && <div id="assistant-history-note" className="chat-turn-note" role="status">{t('shell.assistant.historyOnly')}</div>}
            {failure && <div className="chat-failure" role="alert"><Icon.info /><div><strong>{t('shell.assistant.errorTitle')}</strong><p>{failure}</p><button className="btn-text" type="button" disabled={status.busy} onClick={onReset}>{t('shell.assistant.retry')}</button></div></div>}
          </div>
          {away && <button className="chat-jump btn-sm" type="button" onClick={() => { stickRef.current = true; setAway(false); const feed = feedRef.current; if (feed) feed.scrollTop = feed.scrollHeight }}><Icon.down />{t('shell.assistant.latest')}</button>}
        </div>
        {(attachment || returnAvailable || result) && <div className="chat-workflow-context">
          {attachment && <div className="chat-workflow-chip" role="status">
            <Icon.layers /><span title={attachment.context.mode === 'edit' ? attachment.context.title : undefined}>{attachment.context.mode === 'create' ? t('shell.assistant.workflowCreate') : t('shell.assistant.workflowEdit', { title: attachment.context.title })}{attachment.context.mode === 'edit' && attachment.context.dirty && <small>{t('shell.assistant.workflowDirty')}</small>}</span>
            <button className="icon-btn" type="button" aria-label={t('shell.assistant.workflowDetach')} title={t('shell.assistant.workflowDetach')} onClick={onDetachWorkflow}><Icon.close /></button>
          </div>}
          <div className="chat-workflow-actions">
            {returnAvailable && <button className="btn-sm" type="button" onClick={onReturnWorkflow}>{t('shell.assistant.workflowReturn')}</button>}
            {result && <button className="btn-sm primary" type="button" title={result.title} onClick={onOpenWorkflow}>{t('shell.assistant.workflowOpen')}</button>}
          </div>
        </div>}
        {!terminal && <footer className="chat-footer"><div className="chat-compose"><textarea className="resize-none" ref={composeRef} data-modal-autofocus disabled={chat.readOnly} aria-describedby={chat.readOnly ? "assistant-history-note" : undefined} value={draft} placeholder={t('shell.assistant.composePlaceholder')} aria-label={t('shell.assistant.composeLabel')} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><div className="chat-compose-actions"><span>{t('shell.assistant.scope')}</span>{working ? <button className="chat-send stopping" type="button" disabled={stopping} onClick={() => void stop()} title={t('shell.assistant.stop')} aria-label={t('shell.assistant.stop')}><Icon.stop /></button> : <button className="chat-send" type="button" disabled={!canSend || sending || !draft.trim()} onClick={() => void send()} title={t('shell.assistant.sendHint')} aria-label={t('shell.assistant.send')}><Icon.send /></button>}</div></div><div className="chat-compose-hint"><span>{t('shell.assistant.enterHint')}</span><span><kbd>Esc</kbd> {t('shell.assistant.footEsc')}</span></div></footer>}
      </aside>
    </div>
  )
}
