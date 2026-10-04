import { statusSource, type Question, type RequestResolution, type Task, type TaskStore } from '@orca-board/core'
import type { ReviewInfo } from '@orca-board/contracts'
import type { ExecutionMessages } from './execution-messages.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { TaskWorkerLifecycle } from './task-worker-lifecycle.ts'
import type { RunWorkflowDeps } from './workflow-run.ts'
import type { WorkflowServices } from './workflow-services.ts'
import { executionContext, type ExecutionContext } from './execution-context.ts'
import type { ResolveOutcome } from './review.ts'

export interface ReviewProject extends ExecutionContext { store: TaskStore; root: string; workflow: RunWorkflowDeps }
export interface ReviewOperationHost {
  workflow: WorkflowServices
  resources: ExecutionResources
  lifecycle: Pick<TaskWorkerLifecycle, 'syncWorkerLiveness'>
  messages: Pick<ExecutionMessages, 'error'>
}

/** Trusted socket и IPC используют прежние router/attachments/liveness без копии workflow. */
export function createReviewOperations(host: ReviewOperationHost) {
  return {
    info(project: Pick<ReviewProject, 'store' | 'root'> & ExecutionContext, taskId: string): Promise<ReviewInfo> {
      return host.workflow.review.getReview(project.store, project.root, taskId, project)
    },
    decide(project: ReviewProject, taskId: string, decision: 'accept' | 'reject', text?: string, images?: unknown): Promise<Task | undefined> {
      project = { ...project, source: project.source ?? statusSource() }
      if (decision === 'accept' && host.resources.hasImageInput(images)) throw host.messages.error('attachments.notForAction')
      const workflow = host.workflow.forProject({ ...project.workflow, ...executionContext(project) })
      if (decision === 'accept') return workflow.reviewDecision(taskId, decision, text)
      return host.resources.rejectWithImages(project.store, project.root, taskId, images, text ?? '', paths =>
        workflow.reviewDecision(taskId, decision, text, paths), project)
    },
    resolve(project: ReviewProject, id: string, resolution: RequestResolution, images?: unknown): Promise<ResolveOutcome> {
      project = { ...project, source: project.source ?? statusSource() }
      const request = project.store.getRequest(id)
      if (request?.taskId) host.lifecycle.syncWorkerLiveness(project.store, request.taskId)
      const workflow = host.workflow.forProject({ ...project.workflow, ...executionContext(project) })
      return host.resources.resolveWithImages(project.store, project.root, id, resolution, images,
        clean => workflow.resolveHumanRequest(id, clean), project)
    },
    answer(project: Pick<ReviewProject, 'store'>, questionId: string, answer: string): Question {
      return answerQuestionWithLiveness(project.store, host.lifecycle, questionId, answer)
    }
  }
}

/** Общая точка для legacy socket helper; выход PTY мог ещё не попасть в store. */
export function answerQuestionWithLiveness(store: TaskStore, lifecycle: Pick<TaskWorkerLifecycle, 'syncWorkerLiveness'>, questionId: string, answer: string): Question {
  const question = store.getQuestion(questionId)
  if (question) lifecycle.syncWorkerLiveness(store, question.taskId)
  return store.answer(questionId, answer)
}

export type ReviewOperations = ReturnType<typeof createReviewOperations>
