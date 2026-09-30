import type { AgentKind, Role } from '@orca-board/core'

// Правки роли из RolesEditor без React — чтобы тестировать node --test (projectTemplates.test.ts).

/**
 * Роль с новыми полями; пустые description/model/effort/systemPrompt/extraArgs не сохраняем вовсе
 * (undefined — «по умолчанию»). Непустой `extraArgs` хранится как введён: обрезка съедала бы пробел при вводе.
 */
export function withPatch(r: Role, p: Partial<Role>): Role {
  const next: Role = { ...r, ...p }
  if (!next.description?.trim()) delete next.description
  if (!next.model) delete next.model
  if (!next.effort) delete next.effort
  if (!next.systemPrompt?.trim()) delete next.systemPrompt
  if (!next.extraArgs?.trim()) delete next.extraArgs
  return next
}

/**
 * Смена агента: модель, effort и флаги запуска прошлого агента к новому не подходят — сбрасываются в «по умолчанию».
 */
export function agentChangePatch(agent: AgentKind): Partial<Role> {
  return { agent, model: undefined, effort: undefined, extraArgs: undefined }
}

/** Смена модели: effort, которого нет у новой модели (`efforts` — её уровни), сбрасывается в «по умолчанию». */
export function modelChangePatch(effort: string | undefined, model: string, efforts: readonly string[]): { model: string; effort: string | undefined } {
  return { model, effort: effort && efforts.includes(effort) ? effort : undefined }
}

/**
 * Копия роли под новым id и названием: остальные поля, в том числе флаги запуска (`extraArgs`), переносятся как есть.
 * Флаги у копии те же, что у оригинала, — пользователь сам решает, что менять.
 */
export function duplicatedRole(role: Role, id: string, title: string): Role {
  return { ...role, id, title }
}
