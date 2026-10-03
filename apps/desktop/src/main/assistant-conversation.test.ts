import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantConversation, structuredLaunch } from './assistant-conversation'
import { chooseQuestionOption, questionAnswer } from '../renderer/src/assistantQuestions'
import { fixture, until } from '../../../../packages/runtime/test/conversation-fixture.ts'
import { setMainLocale } from './i18n'

test('Cursor ACP questions preserve question ids and selected option ids', async (t) => {
  const { engine } = fixture(t, 'acp', 'cursor', {}, createAssistantConversation)
  await engine.send('question')
  await until(() => engine.snapshot().interactions.length > 0)
  const question = engine.snapshot().interactions[0]
  const item = question.questions![0]
  const selected = chooseQuestionOption(item, { optionIds: [], text: '' }, 'two', true)
  await engine.respond(question.id, { kind: 'answers', answers: [questionAnswer(item, selected)] })
  await until(() => engine.snapshot().status === 'done')
  assert.ok(engine.snapshot().messages.find((m) => m.role === 'agent')!.text.includes('"selectedOptionIds":["two"]'))
})

test('Desktop structured launch переводит ошибку после смены языка без пересоздания facade', t => {
  t.after(() => setMainLocale('ru'))
  setMainLocale('ru')
  assert.throws(() => structuredLaunch('orca-nonexistent-cli-18d86c', [], { PATH: '' }), /Не найден/)
  setMainLocale('en')
  assert.throws(() => structuredLaunch('orca-nonexistent-cli-18d86c', [], { PATH: '' }), /not found/)
})
