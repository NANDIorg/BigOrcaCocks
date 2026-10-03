import assert from 'node:assert/strict'
import * as runtime from '../src/index.ts'
import type { ExecutionMessageKey, ExecutionMessageParams } from '../src/execution-messages.ts'
import type { GitErrorCode, GitMessageParams } from '../src/git.ts'

/** Проверяется контракт ошибок хоста, без словарей и глобального языка Desktop. */
export class HostError extends Error {
  readonly key: ExecutionMessageKey | GitErrorCode
  readonly params?: ExecutionMessageParams | GitMessageParams
  constructor(key: ExecutionMessageKey | GitErrorCode, params?: ExecutionMessageParams | GitMessageParams) {
    super(`${key} ${JSON.stringify(params ?? {})}`)
    this.key = key
    this.params = params
  }
}

export const messages = { error: (key: ExecutionMessageKey, params?: ExecutionMessageParams) => new HostError(key, params) }
export const git = runtime.createGitOperations({ error: (key, params) => new HostError(key, params), untrackedLabel: () => 'Untracked:' })
export const warnings: string[] = []
export const logger = { warn: (message: string) => { warnings.push(message) } }

export function resources() {
  assert.equal(typeof runtime.createExecutionResources, 'function', 'Ресурсы исполнения доступны без Desktop')
  return runtime.createExecutionResources({ messages, git, logger })
}
