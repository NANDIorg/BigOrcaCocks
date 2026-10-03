import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import type { AgentKind } from '@orca-board/core'
import type { ConversationUpdate } from '@orca-board/contracts'
import * as runtime from '../src/index.ts'
import type { ConversationServicesDeps, AssistantConversation, ConversationOptions } from '../src/index.ts'

/** Явный test host; реальные CLI fixtures проверяют wire и cleanup без платных провайдеров. */
export function services(overrides: Partial<ConversationServicesDeps> = {}) {
  assert.equal(typeof runtime.createAssistantConversationServices, 'function')
  return runtime.createAssistantConversationServices({
    messages: (key, params) => `${key === 'assistantTransport.staleRequest' ? 'Request no longer active' : 'request capability'} ${key} ${params ? JSON.stringify(params) : ''}`,
    env: () => process.env, homeDir: homedir(), executablePath: process.execPath, platform: process.platform,
    ...overrides
  })
}

export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Fixture condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const cleanup = new WeakMap<object, { engine: AssistantConversation; dir: string }[]>()

export function fixture(t: { after(fn: () => void): void }, mode = 'claude', agent: AgentKind = 'claude', selection: { model?: string; effort?: string; extraArgs?: string[] } = {}, create?: (options: ConversationOptions) => AssistantConversation): { engine: AssistantConversation; updates: ConversationUpdate[]; wire(): Record<string, unknown>[]; release(): void } {
  const creator = create ?? services().create
  const dir = mkdtempSync(join(tmpdir(), 'orca-conversation-fixture-'))
  const source = readFileSync(new URL('./fixtures/assistant-cli.mjs', import.meta.url), 'utf8')
  for (const name of ['claude', 'codex', 'gemini', 'opencode', 'goose', 'copilot', 'agent', 'cursor-agent']) {
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${name}.mjs`), source)
      writeFileSync(join(dir, `${name}.cmd`), `@ECHO off\r\n"%ORCA_NODE%" "%~dp0${name}.mjs" %*\r\n`)
    } else {
      const bin = join(dir, name)
      writeFileSync(bin, `#!${process.execPath}\n${source}`)
      chmodSync(bin, 0o755)
    }
  }
  const log = join(dir, 'wire.jsonl')
  writeFileSync(log, '')
  const updates: ConversationUpdate[] = []
  const engine = creator({ agent, system: 'Use orca-board.', ...selection, cwd: dir, env: { PATH: [dir, process.env.PATH].join(delimiter), ...(process.platform === 'win32' ? { ORCA_NODE: process.execPath } : {}), ORCA_TEST_MODE: mode, ORCA_TEST_LOG: log, ORCA_TEST_GATE: join(dir, 'accept') }, onUpdate: (update) => updates.push(update) })
  let resources = cleanup.get(t)
  if (!resources) {
    resources = []
    cleanup.set(t, resources)
    t.after(async () => {
      const errors: unknown[] = []
      // Node останавливает цепочку after-хуков при первой ошибке. Сначала закрываем ВСЕ CLI,
      // затем ждём удаления папок: Windows отпускает cwd после асинхронного taskkill.
      for (const resource of cleanup.get(t) ?? []) {
        try { resource.engine.dispose() } catch (error) { errors.push(error) }
      }
      const results = await Promise.allSettled((cleanup.get(t) ?? []).map(({ dir: path }) =>
        rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      ))
      cleanup.delete(t)
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      if (errors.length) throw new AggregateError(errors, 'Не удалось завершить очистку фикстур ассистента')
    })
  }
  resources.push({ engine, dir })
  return { engine, updates, release: () => writeFileSync(join(dir, 'accept'), ''), wire: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
}
