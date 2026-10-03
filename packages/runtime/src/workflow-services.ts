import type { OrcaEvent, RequestResolution, Task } from '@orca-board/core'
import type { ExecutionResources } from './execution-resources.ts'
import type { WorkflowMessages } from './workflow-messages.ts'
import { createReviewServices, type ResolveOutcome } from './review.ts'
import { createTaskWorkflowServices } from './workflow.ts'
import { createRunWorkflowServices, type RunWorkflowDeps } from './workflow-run.ts'

export interface WorkflowServiceDeps {
  resources: ExecutionResources
  messages: WorkflowMessages
}

/** Все исполнители одного owner используют одни ресурсы; проект всегда передаётся явно. */
export function createWorkflowServices(deps: WorkflowServiceDeps) {
  const review = createReviewServices(deps)
  const task = createTaskWorkflowServices({ ...deps, review })
  const run = createRunWorkflowServices({ ...deps, workflow: task })

  function forProject(project: RunWorkflowDeps) {
    return {
      handleEvents(events: readonly OrcaEvent[]): void {
        task.handleWorkflowEvents(project, events)
        run.handleRunWorkflowEvents(project, events)
      },
      resumeStuckStages(): void {
        task.resumeStuckStages(project)
      },
      resolveHumanRequest(id: string, resolution: RequestResolution): ResolveOutcome {
        return review.resolveHumanRequest(project.store, project.repoRoot, id, resolution, project.startWorker, request => {
          if (!run.handleRunRequest(project, request)) task.approvalResolved(project, request)
        }, project.mergeTarget)
      },
      reviewDecision(taskId: string, outcome: 'accept' | 'reject', text?: string, images?: string[]): Task | undefined {
        if (run.isRunGate(project.store.getTask(taskId))) {
          run.runGateDecision(project, taskId, outcome, text, images)
        } else if (outcome === 'accept') {
          task.reviewAccept(project, taskId, text)
        } else {
          return task.reviewReject(project, taskId, text ?? '', images)
        }
        return project.store.getTask(taskId)
      }
    }
  }

  return { review, task, run, forProject }
}

export type WorkflowServices = ReturnType<typeof createWorkflowServices>
export type ProjectWorkflowServices = ReturnType<WorkflowServices['forProject']>
