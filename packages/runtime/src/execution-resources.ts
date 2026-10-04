import type { createGitOperations } from './git.ts'
import type { ExecutionLogger, ExecutionMessages } from './execution-messages.ts'
import { createEffectScopeService } from './effect-scope.ts'
import { createAsyncRunBranchServices } from './run-branch-async.ts'
import { createRunBranchServices } from './run-branch.ts'
import { createCoordinatorResumeServices } from './coordinator-resume.ts'
import { createAttachmentServices } from './attachments.ts'
import { createRunImageServices } from './run-images.ts'
import { createLaunchPolicy } from './launch-policy.ts'

export interface ExecutionResourceDeps {
  messages: ExecutionMessages
  git: ReturnType<typeof createGitOperations>
  logger: ExecutionLogger
}

/** Ресурсы одного owner; factories сохраняют прежние алгоритмы и guards. */
export function createExecutionResources(deps: ExecutionResourceDeps) {
  const branches = createRunBranchServices(deps)
  const effects = createEffectScopeService()
  const asyncBranches = createAsyncRunBranchServices({ ...deps, effects })
  return {
    git: deps.git, effects, asyncBranches,
    logger: deps.logger,
    ...branches,
    ...createCoordinatorResumeServices(deps),
    ...createAttachmentServices({ ...deps, branches }),
    ...createRunImageServices(deps),
    ...createLaunchPolicy(deps.messages)
  }
}

export type ExecutionResources = ReturnType<typeof createExecutionResources>
