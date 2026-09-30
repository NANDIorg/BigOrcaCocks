import type React from 'react'
import { useId, useState } from 'react'
import type { ConversationInteraction, InteractionAnswer } from '../../shared/ipc'
import { Icon } from './icons'
import { useT, type TKey } from './i18n'
import { ipcErrorMessage } from './ipcError'
import { chooseQuestionOption, writeQuestionText, questionAnswer, validQuestionAnswer, type QuestionDraft } from './assistantQuestions'

/** Выбор не предустановлен: разрешение всегда требует осознанного ответа. */
export function AssistantInteraction({ interaction, onAnswer }: {
  interaction: ConversationInteraction
  onAnswer(answer: InteractionAnswer): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const formId = useId()
  const [answers, setAnswers] = useState<Record<string, QuestionDraft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const questions = interaction.questions ?? []
  const valid = questions.length > 0 && questions.every((question) => validQuestionAnswer(question, answers[question.id]))
  async function respond(answer: InteractionAnswer): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await onAnswer(answer) }
    catch (failure) { setError(ipcErrorMessage(failure)); setBusy(false) }
  }
  return (
    <section className="chat-request" aria-label={interaction.title} aria-busy={busy}>
      <div className="chat-request-heading"><Icon.shield /><span>{t(interaction.kind === 'question' ? 'shell.assistant.question' : 'shell.assistant.permission')}</span></div>
      <h4>{interaction.title}</h4>
      {interaction.text && <p className="chat-request-description">{interaction.text}</p>}
      {interaction.tool && <details className="chat-request-tool"><summary>{interaction.tool.name}</summary><pre>{interaction.tool.input}</pre></details>}
      {questions.length > 0 ? (
        <form noValidate onSubmit={(event) => {
          event.preventDefault()
          if (valid) void respond({ kind: 'answers', answers: questions.map((question) => questionAnswer(question, answers[question.id])) })
        }}>
          {questions.map((question) => {
            const value = answers[question.id] ?? { optionIds: [], text: '' }
            return (
              <fieldset key={question.id} disabled={busy}>
                <legend>{question.question}</legend>
                {question.multiSelect && <div className="chat-request-description">{t('shell.assistant.multipleChoice')}</div>}
                <div className="chat-choices">
                  {question.options.map((option) => (
                    <label className={`chat-choice${value.optionIds.includes(option.id) ? ' selected' : ''}`} key={option.id}>
                      <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${formId}-${question.id}`} value={option.id} checked={value.optionIds.includes(option.id)} onChange={(event) => {
                        const next = chooseQuestionOption(question, value, option.id, event.target.checked)
                        setAnswers((previous) => ({ ...previous, [question.id]: next }))
                      }} />
                      <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                    </label>
                  ))}
                </div>
                {question.allowFreeform && <label className="chat-freeform">{t('shell.assistant.freeform')}<textarea className="resize-none" maxLength={20_000} value={value.text} rows={2} onChange={(event) => { const text = event.target.value; event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(160, event.currentTarget.scrollHeight)}px`; setAnswers((previous) => ({ ...previous, [question.id]: writeQuestionText(question, value, text) })) }} /></label>}
              </fieldset>
            )
          })}
          <div className="chat-request-actions"><button className="btn-sm primary" type="submit" disabled={busy || !valid}>{t('shell.assistant.answer')}</button><button className="btn-sm" type="button" disabled={busy} onClick={() => void respond({ kind: 'cancel' })}>{t('shell.cancel')}</button></div>
        </form>
      ) : (
        <div className="chat-request-actions">
          {(interaction.options ?? []).map((option) => (
            <button key={option.id} title={option.description} type="button" className={`btn-sm${option.kind === 'allow_once' ? ' primary' : ''}`} disabled={busy} onClick={() => void respond({ kind: 'option', optionId: option.id })}>
              {option.label || (option.kind ? t(`shell.assistant.permission.${option.kind}` as TKey) : '')}
            </button>
          ))}
          <button className="btn-text" type="button" disabled={busy} onClick={() => void respond({ kind: 'cancel' })}>{t('shell.cancel')}</button>
        </div>
      )}
      {busy && <p className="chat-request-description" role="status">{t('shell.assistant.answering')}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  )
}
