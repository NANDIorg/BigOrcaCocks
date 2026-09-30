import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { InteractionQuestion } from '../../shared/assistant-conversation'
import { chooseQuestionOption, writeQuestionText, questionAnswer, validQuestionAnswer } from './assistantQuestions'
const question: InteractionQuestion = { id: 'q', question: 'Выбор', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], multiSelect: false, allowFreeform: true }
it('Cursor: выбранный вариант не отправляет запрещённый пустой freeform', () => {
  const cursor = { ...question, allowFreeform: false }
  const selected = chooseQuestionOption(cursor, { optionIds: [], text: '' }, 'a', true)
  assert.deepEqual(questionAnswer(cursor, selected), { questionId: 'q', optionIds: ['a'] })
})
it('свой ответ заменяет выбранный radio, а выбор radio удаляет свой ответ', () => {
  const custom = writeQuestionText(question, { optionIds: ['a'], text: '' }, 'Мой вариант')
  assert.deepEqual(custom, { optionIds: [], text: 'Мой вариант' })
  assert.equal(validQuestionAnswer(question, custom), true)
  const selected = chooseQuestionOption(question, custom, 'b', true)
  assert.deepEqual(selected, { optionIds: ['b'], text: '' })
})
it('множественный выбор сохраняет выбранные варианты и дополнительный текст', () => {
  const multiple = { ...question, multiSelect: true }
  const custom = writeQuestionText(multiple, { optionIds: ['a'], text: '' }, 'Ещё')
  const selected = chooseQuestionOption(multiple, custom, 'b', true)
  assert.deepEqual(selected, { optionIds: ['a', 'b'], text: 'Ещё' })
  assert.deepEqual(chooseQuestionOption(multiple, selected, 'a', false).optionIds, ['b'])
})
it('пустые, неизвестные и конфликтующие ответы не включают кнопку отправки', () => {
  assert.equal(validQuestionAnswer(question, { optionIds: [], text: '  ' }), false)
  assert.equal(validQuestionAnswer(question, { optionIds: ['other'], text: '' }), false)
  assert.equal(validQuestionAnswer(question, { optionIds: ['a'], text: 'custom' }), false)
  assert.equal(validQuestionAnswer({ ...question, allowFreeform: false }, { optionIds: [], text: 'custom' }), false)
})
