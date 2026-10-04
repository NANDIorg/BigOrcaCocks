import { createRuleServices } from '@orca-board/runtime'
import { OrcaError } from './i18n'

export { RULE_MAX_BYTES, detectEol, withEol } from '@orca-board/runtime'
export const ruleServices = createRuleServices({ messages: { Error: OrcaError } })
export const { ruleFileName, readRule, listRules, writeRule } = ruleServices
