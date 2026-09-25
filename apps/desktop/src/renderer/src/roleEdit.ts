import type { AgentKind, Role } from '@orca-board/core'

// Правки роли из RolesEditor без React — чтобы тестировать node --test (projectTemplates.test.ts).

/** Роль с новыми полями; пустые description/model/effort/systemPrompt не сохраняем вовсе (undefined — «по умолчанию»). */
export function withPatch(r: Role, p: Partial<Role>): Role {
  const next: Role = { ...r, ...p }
  if (!next.description?.trim()) delete next.description
  if (!next.model) delete next.model
  if (!next.effort) delete next.effort
  if (!next.systemPrompt?.trim()) delete next.systemPrompt
  return next
}

/**
 * Смена агента: модель и effort прошлого агента к новому не подходят — сбрасываются в «по умолчанию».
 */
export function agentChangePatch(agent: AgentKind): Partial<Role> {
  return { agent, model: undefined, effort: undefined }
}
