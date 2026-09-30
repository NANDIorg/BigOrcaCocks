import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentInfo } from '@orca-board/core'
import { createOnboardingScanner, onboardingAgentGroups, type OnboardingScanState } from './onboardingAgents'

const agent = (id: AgentInfo['id'], installed: boolean): AgentInfo => ({ id, title: id, installed, enabled: true, models: [], defaults: {} })
const CLAUDE = { ...agent('claude', true), version: '2.1.0' }
const CODEX = agent('codex', true)
const GEMINI = agent('gemini', false)

test('список мастера исключает shell, разделяет найденных и отсутствующих, сохраняя порядок источника', () => {
  const source = [GEMINI, CODEX, agent('shell', true), CLAUDE]
  const groups = onboardingAgentGroups(source)
  assert.deepEqual(groups.installed.map(a => a.id), ['codex', 'claude'])
  assert.deepEqual(groups.missing.map(a => a.id), ['gemini'])
  assert.deepEqual(source.map(a => a.id), ['gemini', 'codex', 'shell', 'claude'])
  assert.equal(groups.installed[1].version, '2.1.0')
})

test('неизвестный результат и только shell не считаются найденным агентом', () => {
  assert.deepEqual(onboardingAgentGroups(null), { installed: [], missing: [] })
  assert.deepEqual(onboardingAgentGroups([agent('shell', true)]), { installed: [], missing: [] })
})

test('повторный запрос во время проверки не запускает вторую проверку и даёт тот же результат', async () => {
  let resolve!: (agents: AgentInfo[]) => void
  let calls = 0
  const states: OnboardingScanState[] = []
  const scanner = createOnboardingScanner(() => {
    calls++
    return new Promise<AgentInfo[]>(done => { resolve = done })
  }, state => states.push(state))
  const first = scanner.scan()
  const second = scanner.scan()
  assert.equal(calls, 1)
  assert.deepEqual(states.map(s => s.busy), [true])
  resolve([CLAUDE])
  await Promise.all([first, second])
  assert.equal(states.at(-1)?.busy, false)
  assert.deepEqual(states.at(-1)?.agents?.map(a => a.id), ['claude'])
  assert.equal(states.at(-1)?.error, null)
})

test('ошибка повторной проверки сохраняет прошлых агентов и позволяет повторить запрос', async () => {
  let calls = 0
  const states: OnboardingScanState[] = []
  const scanner = createOnboardingScanner(async () => {
    calls++
    if (calls === 2) throw new Error("Error invoking remote method 'agents:list': Error: недоступен CLI")
    return calls === 1 ? [CLAUDE] : [CODEX]
  }, state => states.push(state))
  await scanner.scan()
  await scanner.scan()
  assert.deepEqual(states.at(-1)?.agents?.map(a => a.id), ['claude'])
  assert.equal(states.at(-1)?.error, 'недоступен CLI')
  assert.equal(states.at(-1)?.busy, false)
  await scanner.scan()
  assert.deepEqual(states.at(-1)?.agents?.map(a => a.id), ['codex'])
  assert.equal(states.at(-1)?.error, null)
})

test('закрытый мастер не получает поздний результат и не запускает новую проверку', async () => {
  let resolve!: (agents: AgentInfo[]) => void
  let calls = 0
  const states: OnboardingScanState[] = []
  const scanner = createOnboardingScanner(() => {
    calls++
    return new Promise<AgentInfo[]>(done => { resolve = done })
  }, state => states.push(state))
  const pending = scanner.scan()
  assert.equal(states.length, 1)
  scanner.dispose()
  resolve([CLAUDE])
  await pending
  await scanner.scan()
  assert.equal(states.length, 1)
  assert.equal(calls, 1)
})

test('синхронный отказ старого preload не оставляет проверку навсегда занятой', async () => {
  let calls = 0
  const states: OnboardingScanState[] = []
  const scanner = createOnboardingScanner(() => {
    if (++calls === 1) throw new Error('CLI unavailable')
    return Promise.resolve([CODEX])
  }, state => states.push(state))
  await scanner.scan()
  assert.equal(states.at(-1)?.error, 'CLI unavailable')
  await scanner.scan()
  assert.deepEqual(states.at(-1)?.agents?.map(a => a.id), ['codex'])
})
