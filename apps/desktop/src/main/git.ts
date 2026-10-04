import { createGitOperations, createGitProcessService } from '@orca-board/runtime'
import { mt, OrcaError } from './i18n'
import { getEffectJournal } from './effect-journal'

export { MergeError, GitOpError, type ReviewInfo } from '@orca-board/runtime'

// Общий async Git сохраняет прежние OrcaError; именованные exports делегируют одному scoped port.
export const gitProcesses = createGitProcessService()
const operations = createGitOperations({
  error: (key, params) => new OrcaError(key, params),
  untrackedLabel: () => mt('review.untracked')
}, undefined, gitProcesses, getEffectJournal)

export const {
  workflowGit, currentBranch, hasCommits, assertHasCommits, headBase, addTaskWorktree,
  projectBranchInfo, reviewInfo, commitWorktree, mergeBranch, removeWorktreeKeepBranch,
  removeWorktree, taskWorktreePath, localBranchExists, isBranchNameAcceptedByGit, gitCreateBranch,
  gitCheckout, gitCommit, gitPush, setupCommand, projectBranches,
  projectFetch, projectPull, checkoutProjectBranch, createInitialCommit, gitCheckIgnore, projectBranchInfoAsync, hasCommitsAsync
} = operations
