import type { createGitOperations } from './git.ts'
import type { ExecutionLogger, ExecutionMessages } from './execution-messages.ts'
import { createEffectScopeService } from './effect-scope.ts'
import { createRunBranchServices } from './run-branch.ts'
import { createCoordinatorResumeServices } from './coordinator-resume.ts'
import { createAttachmentServices } from './attachments.ts'
import { createRunImageServices } from './run-images.ts'
import { createLaunchPolicy } from './launch-policy.ts'
import type { EffectJournal } from './effect-journal.ts'

export interface ExecutionResourceDeps {
  messages: ExecutionMessages
  git: ReturnType<typeof createGitOperations>
  logger: ExecutionLogger
  journal?: () => EffectJournal | undefined
}

/** Ресурсы одного owner; factories сохраняют прежние алгоритмы и guards. */
export function createExecutionResources(deps: ExecutionResourceDeps) {
  const effects = createEffectScopeService({ journal: deps.journal })
  const branches = createRunBranchServices({ ...deps, effects })
  return {
    git: deps.git, effects,
    logger: deps.logger,
    ...branches,
    ...createCoordinatorResumeServices(deps),
    ...createAttachmentServices({ ...deps, branches, effects }),
    ...createRunImageServices(deps),
    ...createLaunchPolicy(deps.messages)
  }
}

export type ExecutionResources = ReturnType<typeof createExecutionResources>
