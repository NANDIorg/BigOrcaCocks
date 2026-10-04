import type { InteractionQuestion } from '../shared/assistant-conversation'

export interface QuestionDraft { optionIds: string[]; text: string }

/** Одиночный выбор и собственный текст — альтернативные ответы; множественный допускает дополнение. */
export function chooseQuestionOption(question: InteractionQuestion, value: QuestionDraft, id: string, checked: boolean): QuestionDraft {
  if (!question.multiSelect) return { optionIds: [id], text: '' }
  return { ...value, optionIds: checked ? [...new Set([...value.optionIds, id])] : value.optionIds.filter((option) => option !== id) }
}
export function writeQuestionText(question: InteractionQuestion, value: QuestionDraft, text: string): QuestionDraft {
  return { optionIds: !question.multiSelect && text.trim() ? [] : value.optionIds, text }
}
export function questionAnswer(question: InteractionQuestion, value?: QuestionDraft): { questionId: string; optionIds: string[]; text?: string } {
  const text = value?.text.trim()
  return { questionId: question.id, optionIds: value?.optionIds ?? [], ...(question.allowFreeform && text ? { text } : {}) }
}
export function validQuestionAnswer(question: InteractionQuestion, value?: QuestionDraft): boolean {
  if (!value || new Set(value.optionIds).size !== value.optionIds.length || value.optionIds.some((id) => !question.options.some((option) => option.id === id))) return false
  const text = value.text.trim()
  if (value.text.length > 20_000 || (text && !question.allowFreeform)) return false
  const count = value.optionIds.length + (text ? 1 : 0)
  return question.multiSelect ? count > 0 : count === 1
}
