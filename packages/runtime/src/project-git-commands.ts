import type { Project, ProjectCommandContext, ProjectGitCommands, ProjectGitCommandName } from '@orca-board/contracts'
import type { ProjectCommandHost } from './project-commands.ts'
import { createAsyncProjectCommandExecutor } from './async-project-commands.ts'
import { commandInputError, commandString } from './command-input.ts'
import type { GitOperations } from './git.ts'

export interface ProjectGitCommandHost extends ProjectCommandHost<Project, ProjectGitCommandName> {
  isCurrent(project: Project, context: ProjectCommandContext): boolean
  git: Pick<GitOperations, 'projectBranchInfoAsync' | 'projectBranches' | 'projectFetch' | 'projectPull' | 'checkoutProjectBranch' | 'createInitialCommit'>
  liveAgents(projectId: string): number
}

/** Root захватывается отдельно: registration object может изменить свой путь во время await. */
export function createProjectGitCommands(host: ProjectGitCommandHost): ProjectGitCommands {
  const execute = createAsyncProjectCommandExecutor({
    authorize: host.authorize,
    project: (id: string) => { const registration = host.project(id); return registration ? { id, root: registration.root, registration } : undefined },
    isCurrent: (project, context) => project.registration.root === project.root && host.isCurrent(project.registration, context)
  })
  return {
    branch: context => execute(context, 'projectGit.branch', () => project => host.git.projectBranchInfoAsync(project.root)),
    branches: context => execute(context, 'projectGit.branches', () => project => host.git.projectBranches(project.root)),
    fetch: context => execute(context, 'projectGit.fetch', () => (project, _context, scope) => host.git.projectFetch(project.root, () => scope.commit(() => undefined))),
    pull: context => execute(context, 'projectGit.pull', () => (project, _context, scope) => host.git.projectPull(project.root, () => scope.commit(() => undefined))),
    checkout: (context, branch) => execute(context, 'projectGit.checkout', () => {
      const name = commandString(branch, 'branch')
      return (project, _context, scope) => host.git.checkoutProjectBranch(project.root, name, () => host.liveAgents(project.id), () => scope.commit(() => undefined))
    }),
    initialCommit: (context, mode) => execute(context, 'projectGit.initialCommit', () => {
      if (mode !== 'empty' && mode !== 'snapshot') commandInputError('mode')
      return (project, _context, scope) => host.git.createInitialCommit(project.root, mode, () => scope.commit(() => undefined))
    })
  }
}
