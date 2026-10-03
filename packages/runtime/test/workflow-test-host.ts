import type { WorkflowMessages, WorkflowMessageParams } from '../src/workflow-messages.ts'
import { resources } from './execution-test-host.ts'

/** Хост проверяет коды/параметры и локализацию, не импортируя Desktop. */
export class WorkflowHostError extends Error {
  readonly key: string
  readonly params?: WorkflowMessageParams
  constructor(key: string, params?: WorkflowMessageParams) {
    super(`${key} ${JSON.stringify(params ?? {})}`)
    this.key = key
    this.params = params
  }
}

export function workflowMessages(language = 'ru'): WorkflowMessages {
  return {
    error: (key, params) => new WorkflowHostError(key, params),
    text: (key, params) => `${language}:${key} ${JSON.stringify(params ?? {})}`,
    displayError: error => error instanceof WorkflowHostError
      ? `${language}:translated:${error.key}`
      : error instanceof Error ? error.message : String(error)
  }
}

export const workflowResources = resources()
