import { parseExtraArgs, type AgentKind, type Role } from '@orca-board/core'

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

/** Исполнитель с флагами запуска: роль или настройки ассистента. */
interface WithExtraArgs {
  agent: AgentKind
  extraArgs?: string
}

/**
 * Исполнитель для отправки в main: годные флаги (`parseExtraArgs`) уходят как введены, пустые очищают поле.
 * Негодные main отверг бы вместе со всей записью, и правка соседнего поля пропала бы — вместо них уходят последние
 * отправленные (`saved`), если они годные и того же агента, иначе поля нет. Остальные поля — как в черновике;
 * сам черновик (и поле ввода) не меняется.
 */
export function withSavableExtraArgs<T extends WithExtraArgs>(draft: T, saved: WithExtraArgs | undefined): T {
  if (parseExtraArgs(draft.extraArgs ?? '').ok) return draft
  const next = { ...draft }
  if (saved?.agent === draft.agent && saved.extraArgs && parseExtraArgs(saved.extraArgs).ok) next.extraArgs = saved.extraArgs
  else delete next.extraArgs
  return next
}

/** Роли для `taskTypes:save` из черновика: `withSavableExtraArgs` для каждой, прежняя роль ищется по id. */
export function rolesForSave(draft: readonly Role[], saved: readonly Role[]): Role[] {
  return draft.map((r) => withSavableExtraArgs(r, saved.find((x) => x.id === r.id)))
}
