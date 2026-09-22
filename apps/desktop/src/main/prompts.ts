import type { BuiltinPrompts } from '@orca-board/core'
import workerSkill from '../../../../skills/worker.md?raw'
import coordinatorSkill from '../../../../skills/coordinator.md?raw'

/** Служебные инструкции Orca: их получают агенты при запуске (worker.ts) и их же показывает UI ролей. */
export const BUILTIN_PROMPTS: BuiltinPrompts = { worker: workerSkill, coordinator: coordinatorSkill }
