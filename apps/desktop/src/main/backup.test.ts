import { it } from 'node:test'
import assert from 'node:assert/strict'
import { rememberUpdate, getJustUpdatedFrom } from './backup'

it('Desktop запоминает прежнюю версию только после обновления', () => {
  rememberUpdate({ previous: '1.0.0', updated: true })
  assert.equal(getJustUpdatedFrom(), '1.0.0')
  rememberUpdate({ previous: '1.0.0', updated: false })
  assert.equal(getJustUpdatedFrom(), null)
  rememberUpdate({ updated: false })
  assert.equal(getJustUpdatedFrom(), null)
})
