import type { ProjectCommandContext } from './project-commands.ts'
import type { InitialCommitMode, ProjectBranchInfo, ProjectBranchList, ProjectGitResult } from './projects.ts'

export interface ProjectGitCommands {
  branch(context: ProjectCommandContext): Promise<ProjectBranchInfo>
  branches(context: ProjectCommandContext): Promise<ProjectBranchList>
  fetch(context: ProjectCommandContext): Promise<ProjectGitResult>
  pull(context: ProjectCommandContext): Promise<ProjectGitResult>
  checkout(context: ProjectCommandContext, branch: string): Promise<ProjectBranchInfo>
  initialCommit(context: ProjectCommandContext, mode: InitialCommitMode): Promise<ProjectBranchInfo>
}
export type ProjectGitCommandName = `projectGit.${keyof ProjectGitCommands}`
