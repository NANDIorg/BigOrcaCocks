// Запуск: pnpm --filter @orca-board/desktop test. Логика раздела «Правила доски» (about/AgentRulesSection.tsx).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaApi, Project } from '../../shared/ipc'
import { AGENT_RULES_STALE_MESSAGE, agentRulesApi, agentRulesCount, isStaleAgentRulesError } from './agentRules'

describe('agentRulesApi', () => {
  it('старый preload без setAgentRules — ошибка «перезапустите приложение»', () => {
    assert.throws(() => agentRulesApi(undefined), { message: AGENT_RULES_STALE_MESSAGE })
    assert.throws(() => agentRulesApi({}), /Перезапустите приложение/)
    assert.throws(() => agentRulesApi({ projects: {} }), /Перезапустите приложение/)
  })

  it('с setAgentRules — отдаёт его', () => {
    const setAgentRules: OrcaApi['projects']['setAgentRules'] = async (id) => ({ id } as Project)
    assert.equal(agentRulesApi({ projects: { setAgentRules } }), setAgentRules)
  })

  it('узнаёт ошибку старого main', () => {
    assert.ok(isStaleAgentRulesError(
      "Error invoking remote method 'projects:setAgentRules': Error: No handler registered for 'projects:setAgentRules'"
    ))
    assert.ok(!isStaleAgentRulesError("No handler registered for 'projects:setRoles'"))
  })
})

describe('agentRulesCount', () => {
  it('пусто или одни пробелы — «нет»', () => {
    assert.equal(agentRulesCount(undefined), 'нет')
    assert.equal(agentRulesCount('  \n\n '), 'нет')
  })

  it('считает только непустые строки, CRLF тоже', () => {
    assert.equal(agentRulesCount('# Правила\r\n\r\n- раз\r\n- два'), '3 стр.')
  })
})
