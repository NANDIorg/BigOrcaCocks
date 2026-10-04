/** Коды прежних Git-отказов; способ отображения и класс ошибки задаёт host. */
export type GitErrorCode = 'git.branchBusy' | 'git.branchNotFound' | 'git.dirtyTree' | 'git.noCommits' | 'git.noUpstream' | 'git.notFastForward' | 'git.notRepo' | 'git.opFailed' | 'git.timeout' | 'git.workersActive'

export interface GitMessage {
  key: GitErrorCode
  params?: GitMessageParams
}
export type GitMessageParams = Record<string, string | number | GitMessage>

export interface GitMessages {
  error(key: GitErrorCode, params?: GitMessageParams): Error
  untrackedLabel(): string
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/**
 * `git merge` не удался. `conflict` — git начал слияние и упёрся в конфликтующие файлы: его разрешают в ветке задачи
 * и сливают снова. Иначе git до слияния не дошёл (занят `index.lock`, незакоммиченное в цели, нет ветки, таймаут):
 * это не конфликт, повтор после устранения причины сольёт как есть.
 */
export class MergeError extends Error {
  readonly conflict: boolean

  constructor(message: string, conflict: boolean) {
    super(message)
    this.conflict = conflict
  }
}

/** Отказ git-операции ноды: текст `git <команда>: <причина>` уходит в `task.feedback` и исход `error`. */
export class GitOpError extends Error {}
