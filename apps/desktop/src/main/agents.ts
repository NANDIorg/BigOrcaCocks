import { createAgentDiscovery, createAgentSelection, missingRoleText, type AgentSelectionServices, type RoleSource } from '@orca-board/runtime'
import type { AgentInfo, AgentKind, Role } from '@orca-board/core'
import { OrcaError, mtIn } from './i18n'

/** Desktop использует прежний домашний каталог/окружение; кэши принадлежат его runtime adapter. */
const discovery = createAgentDiscovery()
const selection: AgentSelectionServices = createAgentSelection({ error: (key, params) => new OrcaError(key, params) })

export const { detectAgents, agentInfos, extraPathDirs, findBin, isCmdScript } = discovery
export { parseTopLevelToml, missingRoleText } from '@orca-board/runtime'
export type { DetectedAgent, RoleSource } from '@orca-board/runtime'

/** Wrapper сохраняет прежнюю assertion signature для socket и main guards. */
export function assertAgentUsable(agents: AgentInfo[], id: string): asserts id is AgentKind {
  selection.assertAgentUsable(agents, id)
}

/** Инструкцию о недостающей роли читают socket/CLI, поэтому язык всегда русский. */
export function missingRoleMessage(roleId: string, type: RoleSource): string {
  const m = missingRoleText(roleId, type)
  return mtIn('ru', m.key, m.params)
}

export function pickRole(type: RoleSource, agents: AgentInfo[], requested: string | undefined): Role {
  return selection.pickRole(type, agents, requested)
}
