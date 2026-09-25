import { DEFAULT_ROLES, wfNodeTitle, type Role, type Workflow } from '@orca-board/core'
import { t, type TKey } from './i18n'

/** Системные роли — id из DEFAULT_ROLES: у пустого назначения есть значение по умолчанию, их можно вернуть из дефолта. */
export const SYSTEM_ROLE_IDS: ReadonlySet<string> = new Set(DEFAULT_ROLES.map((r) => r.id))

export function isSystemRole(roleId: string): boolean {
  return SYSTEM_ROLE_IDS.has(roleId)
}

/**
 * Что перестанет работать без системной роли. Тексты сверены с кодом: координатор без роли coordinator
 * не запускается (`startCoordinator`), ассистент без assistant берёт агента coordinator (`assistantRole`),
 * `task create --role <нет в типе задачи>` — ошибка (`pickRole`), задачи старой доски без роли получают developer.
 */
const SYSTEM_ROLE_LOSSES: Readonly<Record<string, readonly TKey[]>> = {
  coordinator: ['config.roles.loss.coordinatorRun', 'config.roles.loss.coordinatorAssistant'],
  assistant: ['config.roles.loss.assistant'],
  developer: ['config.roles.loss.developerTasks', 'config.roles.loss.developerOld'],
  reviewer: ['config.roles.loss.reviewer'],
  qa: ['config.roles.loss.qa']
}

/** Удаление роли из типа задачи: роли прогона не копируются, а читаются из библиотеки при каждом запуске агента. */
export function taskTypeRunsLoss(): string {
  return t('config.roles.loss.taskTypeRuns')
}

/** Почему роль нельзя удалить; undefined — можно. Последнюю роль не пропускает и main (`validateRoles`). */
export function removeBlocker(roles: readonly Role[]): string | undefined {
  return roles.length > 1 ? undefined : t('config.roles.lastRole')
}

/** Названия нод воркфлоу, где занята роль: роль гейта, роль работы, роль в условии. */
export function workflowNodesWithRole(wf: Workflow | undefined, roleId: string): string[] {
  if (!wf) return []
  return wf.nodes
    .filter((n) =>
      ((n.type === 'gate' || n.type === 'work') && n.roleId === roleId) ||
      (n.type === 'condition' && n.test.kind === 'role' && n.test.roleIds.includes(roleId)))
    .map((n) => wfNodeTitle(n))
}

/**
 * Последствия удаления роли для подтверждения. Пусто — подтверждать нечего (пользовательская роль без задач).
 * `taskCount` — задач проекта на роли (undefined — счётчиков нет, как в дефолте для новых проектов).
 * `workflow` — свой воркфлоу типа; дефолтный не передаётся: он строится по ролям и сам обходится без
 * удалённой (нет reviewer — ревью делает человек).
 * `ofTaskType` — роль удаляют из типа задачи: прогоны берут роли из библиотеки при каждом запуске агента, поэтому
 * удаление задевает и уже идущие глобальные задачи. Счётчика незакрытых прогонов по типу в «Настройках» нет —
 * предупреждаем всегда.
 */
export function removalConsequences(roleId: string, taskCount?: number, workflow?: Workflow, ofTaskType = false): string[] {
  const out = (SYSTEM_ROLE_LOSSES[roleId] ?? []).map((key) => t(key))
  if (ofTaskType) out.push(taskTypeRunsLoss())
  if (taskCount) out.push(t('config.roles.loss.tasks', { n: taskCount }))
  const stages = workflowNodesWithRole(workflow, roleId)
  if (stages.length) {
    const list = stages.map((title) => t('config.roles.loss.stage', { title })).join(', ')
    out.push(t('config.roles.loss.workflow', { stages: list }))
  }
  if (isSystemRole(roleId)) out.push(t('config.roles.loss.restore'))
  return out
}

/** Системные роли, которых нет в списке, — копии из DEFAULT_ROLES в их порядке. */
export function missingSystemRoles(roles: readonly Role[]): Role[] {
  const have = new Set(roles.map((r) => r.id))
  return DEFAULT_ROLES.filter((r) => !have.has(r.id)).map((r) => ({ ...r }))
}

/**
 * Вернуть удалённые системные роли с настройками по умолчанию. Каждая встаёт перед первой оставшейся системной ролью,
 * которая шла после неё в DEFAULT_ROLES (иначе — в конец): порядок ролей для задач — порядок в «Новой задаче».
 */
export function restoreSystemRoles(roles: readonly Role[]): Role[] {
  const next = [...roles]
  const order = DEFAULT_ROLES.map((r) => r.id)
  for (const role of missingSystemRoles(roles)) {
    const later = new Set(order.slice(order.indexOf(role.id) + 1))
    const at = next.findIndex((r) => later.has(r.id))
    next.splice(at < 0 ? next.length : at, 0, role)
  }
  return next
}
