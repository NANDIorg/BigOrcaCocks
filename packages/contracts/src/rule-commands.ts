import type { ProjectCommandContext } from './project-commands.ts'
import type { RuleFile, RuleFileName } from './rules.ts'

export interface RuleCommands {
  list(context: ProjectCommandContext): RuleFile[]
  read(context: ProjectCommandContext, name: RuleFileName): RuleFile
  save(context: ProjectCommandContext, name: RuleFileName, text: string): RuleFile
}
export type RuleCommandName = `rules.${keyof RuleCommands}`
