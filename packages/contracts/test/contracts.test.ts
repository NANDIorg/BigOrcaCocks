import { test } from 'node:test'
import assert from 'node:assert/strict'

test('общий entrypoint проверяет whitelist без загрузки store и provider driver', async () => {
  const contracts = await import('../src/index.ts')
  assert.equal(contracts.isRuleFileName('CLAUDE.md'), true)
  assert.equal(contracts.isRuleFileName('../CLAUDE.md'), false)
  assert.equal(contracts.isRuleFileName('claude.md'), false)
  assert.equal('TaskStore' in contracts, false)
  assert.equal('createConversation' in contracts, false)
})
