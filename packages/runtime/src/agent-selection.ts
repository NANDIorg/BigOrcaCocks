import { AGENT_IDS, getAgent, type AgentInfo, type AgentKind, type Role } from '@orca-board/core'
import type { ExecutionMessageParams } from './execution-messages.ts'
import { missingRoleText, type RoleSource } from './launch-policy.ts'

export type AgentSelectionErrorKey = 'agent.unknown' | 'agent.notInstalled' | 'agent.disabled' | 'role.missing'
export interface AgentSelectionMessages {
  error(key: AgentSelectionErrorKey, params?: ExecutionMessageParams): Error
}

export interface AgentSelectionServices {
  assertAgentUsable(agents: AgentInfo[], id: string): asserts id is AgentKind
  pickRole(type: RoleSource, agents: AgentInfo[], requested: string | undefined): Role
}

/** Общие guards до запуска; host выбирает класс ошибки, перевод и способ доставки. */
export function createAgentSelection(messages: AgentSelectionMessages): AgentSelectionServices {
  function assertAgentUsable(agents: AgentInfo[], id: string): asserts id is AgentKind {
    const spec = getAgent(id)
    if (!spec) throw messages.error('agent.unknown', { id, known: AGENT_IDS.join(', ') })
    const info = agents.find(a => a.id === id)
    if (!info?.installed) throw messages.error('agent.notInstalled', { id, bin: spec.bin })
    if (!info.enabled) {
      const enabled = agents.filter(a => a.enabled).map(a => a.id)
      throw messages.error('agent.disabled', { id, enabled: enabled.length ? enabled.join(', ') : { key: 'common.none' } })
    }
  }

  function pickRole(type: RoleSource, agents: AgentInfo[], requested: string | undefined): Role {
    const roles = type.roles
    const ids = roles.map(r => r.id).join(', ')
    if (requested !== undefined) {
      const role = roles.find(r => r.id === requested)
      if (!role) {
        const message = missingRoleText(requested, type)
        throw messages.error('role.missing', message.params)
      }
      assertAgentUsable(agents, role.agent)
      return role
    }
    if (roles.length === 1) {
      assertAgentUsable(agents, roles[0].agent)
      return roles[0]
    }
    // Эту инструкцию читает agent client; она не зависит от языка интерфейса host.
    throw new Error(`--role обязателен. Роли: ${ids}`)
  }

  return { assertAgentUsable, pickRole }
}
