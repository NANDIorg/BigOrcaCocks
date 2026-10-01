import type { Workflow } from '@orca-board/core'
export type { WorkflowAssistantSaved } from '@orca-board/core'

/** Данные редактора; системные инструкции собирает только main. */
export type WorkflowAssistantContext =
  | { mode: 'create' }
  | { mode: 'edit'; typeId: string; title: string; workflow: Workflow; baseline: Workflow; dirty: boolean; path: string[] }
