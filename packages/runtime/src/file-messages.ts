export type FileMessageKey = 'docs.noPath' | 'docs.noPreview' | 'docs.noTaskSource' | 'docs.notFile' | 'docs.notFound' | 'docs.notMarkdown' | 'docs.notOpenable' | 'docs.notRelative' | 'docs.outside' | 'docs.tooBig' | 'files.badPath' | 'files.hidden' | 'files.notDir' | 'files.notFile' | 'files.notFound' | 'files.outside' | 'files.readFailed' | 'files.rootMissing' | 'showcase.badType' | 'showcase.dispatchNotFound' | 'showcase.hidden' | 'showcase.networkNoSnapshot' | 'showcase.noPath' | 'showcase.noPreview' | 'showcase.noWorktree' | 'showcase.noWorktreeBranch' | 'showcase.notFile' | 'showcase.notFound' | 'showcase.notRelative' | 'showcase.outside' | 'showcase.taskNotFound' | 'showcase.tooBig'

export interface FileMessages {
  Error: new (key: FileMessageKey, params?: Record<string, string | number>) => Error
}
