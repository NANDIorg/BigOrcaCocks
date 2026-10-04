import { createGitOperations } from '@orca-board/runtime'
import { mt, OrcaError } from './i18n'

export { MergeError, GitOpError, type ReviewInfo } from '@orca-board/runtime'

// Общий Git сохраняет прежние OrcaError для IPC/socket и читает язык при показе review.
const operations = createGitOperations({
  error: (key, params) => new OrcaError(key, params),
  untrackedLabel: () => mt('review.untracked')
})

export const {
  currentBranch, hasCommits, assertHasCommits, headBase, addTaskWorktree,
  projectBranchInfo, reviewInfo, commitWorktree, mergeBranch, removeWorktreeKeepBranch,
  removeWorktree, taskWorktreePath, localBranchExists, isBranchNameAcceptedByGit, gitCreateBranch,
  gitCheckout, gitCommit, gitPush, setupCommand, projectBranches,
  projectFetch, projectPull, checkoutProjectBranch, createInitialCommit, gitCheckIgnore, projectBranchInfoAsync, hasCommitsAsync
} = operations
