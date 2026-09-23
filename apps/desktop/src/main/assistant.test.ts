// Запуск: pnpm --filter @orca-board/desktop test. Окружение ассистента доски (assistantEnv).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assistantEnv } from './assistant'

describe('assistantEnv', () => {
  it('без ORCA_PROJECT и ORCA_RUN_ID: ассистент один на приложение и работает через --project', () => {
    const env = assistantEnv({ socketPath: '/s.sock', path: '/cli:/usr/bin' })
    assert.deepEqual(env, { ORCA_SOCKET: '/s.sock', PATH: '/cli:/usr/bin', ORCA_ROLE: 'assistant' })
    assert.equal('ORCA_PROJECT' in env, false)
    assert.equal('ORCA_RUN_ID' in env, false)
  })

  it('ORCA_NODE — только когда передан Node из Electron', () => {
    assert.equal(assistantEnv({ socketPath: 's', path: 'p', nodePath: '/app/Electron' }).ORCA_NODE, '/app/Electron')
    assert.equal('ORCA_NODE' in assistantEnv({ socketPath: 's', path: 'p', nodePath: '' }), false)
  })
})
