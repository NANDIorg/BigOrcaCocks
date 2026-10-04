import test from 'node:test'
import assert from 'node:assert/strict'

test('установка CLI принимает только поддерживаемые пакеты без shell-аргументов', async () => {
  const { agentPackage } = await import('../src/server/agents-setup.ts')
  assert.equal(agentPackage('codex'), '@openai/codex@latest')
  assert.equal(agentPackage('claude'), '@anthropic-ai/claude-code@latest')
  for (const id of ['--prefix=/etc', 'codex; rm -rf /', '@unknown/plugin']) assert.throws(() => agentPackage(id), /агент/i)
})
