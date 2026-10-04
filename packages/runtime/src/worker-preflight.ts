import type { AgentInfo, Role } from '@orca-board/core'
import type { AgentSelectionServices } from './agent-selection.ts'
import type { ExecutionMessages } from './execution-messages.ts'
import { missingRoleText, type RoleSource, type createLaunchPolicy } from './launch-policy.ts'

export interface WorkerPreflightDeps {
  selection: Pick<AgentSelectionServices, 'assertAgentUsable'>
  launchPolicy: Pick<ReturnType<typeof createLaunchPolicy>, 'roleLaunchExtraArgs'>
  messages: ExecutionMessages
}

/** Выбранная графом роль проверяется до записи входа; ошибки и снимок окружения принадлежат host. */
export function createWorkerPreflight(deps: WorkerPreflightDeps) {
  function validate(type: RoleSource, agents: AgentInfo[], roleId: string): Role {
    const role = type.roles.find(role => role.id === roleId)
    if (!role) throw deps.messages.error('worker.cannotStart', { reason: missingRoleText(roleId, type) })
    deps.selection.assertAgentUsable(agents, role.agent)
    deps.launchPolicy.roleLaunchExtraArgs(role, 'worker.cannotStart')
    return role
  }
  return { validate }
}
