// Совместимые пути общих функций и Desktop-составных настроек ассистента.
export { assistantEnv, assistantCwd, ASSISTANT_PERMISSION_MODE, loadedAssistantSettings } from '@orca-board/runtime'
export type { AssistantEnvInput, AssistantLaunch } from '@orca-board/runtime'
export { mergedAssistantSettings } from './project-settings'
import { executionResources } from './execution-resources'
export const assistantLaunch = executionResources.assistantLaunch
