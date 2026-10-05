import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOrcaRuntime, startOperatorEndpoint } from '@orca-board/runtime'
import { createHttpTransport, createOrcaClient, createTypedUiClient } from '@orca-board/client'

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-web-agents-'))
  const home = join(directory, 'home'); const bin = join(directory, 'bin'); const dataDir = join(directory, 'profile')
  mkdirSync(join(home, '.codex'), { recursive: true }); mkdirSync(bin)
  const config = join(home, '.codex', 'config.toml')
  writeFileSync(config, 'model = "first-model"\n')
  const version = join(directory, 'version.cjs'); writeFileSync(version, 'process.stdout.write("fixture CLI 1.0.0\\n")')
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, process.platform === 'win32' ? `${name}.cmd` : name), process.platform === 'win32'
      ? `@"${process.execPath}" "${version}"\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${version}"\n`, { mode: 0o700 })
  }
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (['PATH', 'PATHEXT'].includes(key.toUpperCase())) delete env[key]
  Object.assign(env, { PATH: bin, PATHEXT: '.CMD' })
  const owner = await createOrcaRuntime({ dataDir, homeDir: home, env, socketPath: join(directory, 'agent.sock'), cliBinDir: bin,
    product: { name: 'orca-web', version: '2.1.0' }, prompts: { worker: '', coordinator: '', assistant: '' }, agentSocket: false,
    native: { spawn: () => { throw new Error('Проверка CLI не должна запускать агента') } }, authorize: context => context.actor.kind === 'operator' })
  const endpoint = await startOperatorEndpoint({ runtime: owner.value, token: 'test-token' })
  const operator = createOrcaClient({ product: { name: 'orca-web-browser', version: '2.1.0' }, pollMs: 0,
    transport: createHttpTransport({ url: endpoint.url, clientId: 'onboarding', headers: () => ({ authorization: 'Bearer test-token' }) }) })
  const errors: unknown[] = []; const adapter = createTypedUiClient(operator, { onError: error => errors.push(error) })
  t.after(async () => { await adapter.dispose(); await endpoint.stop(); await owner.stop(); rmSync(directory, { recursive: true, force: true }) })
  return { owner, operator, adapter, errors, config }
}

test('Web onboarding обнаруживает Claude и Codex через HTTP до выбора проекта', async t => {
  const f = await fixture(t)
  assert.equal(f.operator.state.selection.projectId, undefined)
  const agents = await f.adapter.client.agents.list(true)
  for (const id of ['claude', 'codex']) {
    const agent = agents.find(agent => agent.id === id)
    assert.equal(agent?.installed, true, id); assert.equal(agent.enabled, true, id)
    assert.equal(agent.version, 'fixture CLI 1.0.0', id)
  }
  assert.deepEqual(f.errors, [])
})

test('Web список без refresh и повторная проверка сохраняют defaults и перечитывают конфигурацию', async t => {
  const f = await fixture(t)
  const model = (agents: Awaited<ReturnType<typeof f.adapter.client.agents.list>>) => agents.find(agent => agent.id === 'codex')?.defaults.model
  assert.equal(model(await f.adapter.client.agents.list()), 'first-model')
  writeFileSync(f.config, 'model = "updated-model"\n')
  assert.equal(model(await f.adapter.client.agents.list(false)), 'first-model')
  assert.equal(model(await f.adapter.client.agents.list(true)), 'updated-model')
  assert.deepEqual(f.errors, [])
})
