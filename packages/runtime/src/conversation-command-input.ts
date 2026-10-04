import type { InteractionAnswer } from '@orca-board/contracts'
import { commandArray, commandObject, commandString, invalidCommandField } from './profile-command-input.ts'

export function conversationDimension(raw: unknown, field: string, minimum: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > 1000) return invalidCommandField(field)
  return raw
}
export function conversationText(raw: unknown, field = 'text'): string {
  const text = commandString(raw, field, false)
  if (text.length > 1_000_000) return invalidCommandField(field)
  return text
}

/** Проверяется форма ответа; текущий turn/request и допустимые choices проверяет driver. */
export function interactionAnswer(raw: unknown): InteractionAnswer {
  const value = commandObject(raw, ['kind', 'optionId', 'answers'], 'answer')
  if (value.kind === 'cancel' && Object.keys(value).length === 1) return { kind: 'cancel' }
  if (value.kind === 'option' && !Object.hasOwn(value, 'answers')) return { kind: 'option', optionId: commandString(value.optionId, 'answer.optionId') }
  if (value.kind === 'answers' && !Object.hasOwn(value, 'optionId')) return { kind: 'answers', answers: commandArray(value.answers, 'answer.answers', (raw, field) => {
    const row = commandObject(raw, ['questionId', 'optionIds', 'text'], field)
    return { questionId: commandString(row.questionId, `${field}.questionId`),
      optionIds: commandArray(row.optionIds, `${field}.optionIds`, commandString),
      ...(row.text === undefined ? {} : { text: conversationText(row.text, `${field}.text`) }) }
  }) }
  return invalidCommandField('answer.kind')
}
