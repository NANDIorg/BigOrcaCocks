import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProfileOwnershipError } from '@orca-board/runtime'
import { mtIn } from './i18n.ts'
import * as startup from './profile-startup-errors.ts'

test('startup ownership errors переводятся по коду, а не по тексту общего runtime', () => {
  assert.equal(typeof startup.profileStartupMessage, 'function')
  for (const [code, key] of [
    ['ownership.busy', 'runtime.profileBusy'], ['ownership.unavailable', 'runtime.profileUnavailable'],
    ['ownership.invalid', 'runtime.profileInvalid'], ['ownership.schemaUnsupported', 'runtime.profileUnsupported']
  ] as const) {
    const original = new ProfileOwnershipError(code, 'runtime technical message')
    const text = startup.profileStartupMessage(original)
    assert.equal(text.key, key)
    const ru = mtIn('ru', text.key, text.params)
    const en = mtIn('en', text.key, text.params)
    assert.notEqual(ru, en)
    assert.notEqual(ru, key)
    assert.notEqual(en, key)
    assert.doesNotMatch(ru, /runtime technical message/)
    assert.doesNotMatch(en, /runtime technical message/)
  }
})

test('другие startup ошибки сохраняют причину в локализованном сообщении', () => {
  const result = startup.profileStartupMessage(new Error('disk failed'))
  assert.equal(result.key, 'runtime.startupFailed')
  assert.match(mtIn('ru', result.key, result.params), /disk failed/)
  assert.match(mtIn('en', result.key, result.params), /disk failed/)
})
