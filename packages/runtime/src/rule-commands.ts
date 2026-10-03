import type { RuleCommands, RuleCommandName } from '@orca-board/contracts'
import { createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import type { createRuleServices } from './rules.ts'

export interface RuleProject { root: string }
export interface RuleCommandHost extends ProjectCommandHost<RuleProject, RuleCommandName> {
  rules: ReturnType<typeof createRuleServices>
}
export function createRuleCommands(host: RuleCommandHost): RuleCommands {
  const execute = createProjectCommandExecutor(host)
  return {
    list: ctx => execute(ctx, 'rules.list', () => project => host.rules.listRules(project.root)),
    read: (ctx, input) => execute(ctx, 'rules.read', () => {
      const name = host.rules.ruleFileName(input)
      return project => host.rules.readRule(project.root, name)
    }),
    save: (ctx, input, text) => execute(ctx, 'rules.save', () => {
      const name = host.rules.ruleFileName(input); const value = host.rules.ruleText(name, text)
      return project => host.rules.writeRule(project.root, name, value)
    })
  }
}
