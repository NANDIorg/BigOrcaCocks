import { DEFAULT_ROLES, wfNodeTitle, type Role, type Workflow } from '@orca-board/core'

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
const SYSTEM_ROLE_LOSSES: Readonly<Record<string, readonly string[]>> = {
  coordinator: [
    'Нельзя будет запустить прогон и продолжить глобальную задачу: координатор запускается только ролью coordinator.',
    'Если нет и роли assistant, ассистент доски запустится claude с настройками по умолчанию.'
  ],
  assistant: [
    'Ассистент доски запустится агентом, моделью и усилием роли coordinator (без неё — claude по умолчанию), без инструкций роли assistant.'
  ],
  developer: [
    'Координатор не сможет поручать задачи с кодом роли developer (task create --role developer вернёт ошибку).',
    'Задачи со старой доски без роли получают developer — их нельзя будет запустить.'
  ],
  reviewer: [
    'Координатор не сможет создавать задачи ревью (task create --role reviewer вернёт ошибку) — ревью придётся делать вручную.'
  ],
  qa: [
    'Координатор не сможет поручать тесты и проверки роли qa (task create --role qa вернёт ошибку).'
  ]
}

/** Удаление роли из типа задачи: роли прогона не копируются, а читаются из библиотеки при каждом запуске агента. */
export const TASK_TYPE_RUNS_LOSS = 'Незакрытые глобальные задачи этого типа потеряют роль со следующего запуска агента.'

/** Почему роль нельзя удалить; undefined — можно. Последнюю роль не пропускает и main (`validateRoles`). */
export function removeBlocker(roles: readonly Role[]): string | undefined {
  return roles.length > 1 ? undefined : 'Нельзя удалить последнюю роль'
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
  const out = [...(SYSTEM_ROLE_LOSSES[roleId] ?? [])]
  if (ofTaskType) out.push(TASK_TYPE_RUNS_LOSS)
  if (taskCount) out.push(`Задачи на этой роли (${taskCount}) не запустятся, пока роль не вернут.`)
  const stages = workflowNodesWithRole(workflow, roleId)
  if (stages.length) {
    out.push(
      `Роль занята в воркфлоу: ${stages.map((t) => `«${t}»`).join(', ')}. Задачи остановятся на этих этапах, ` +
        'а граф не сохранится, пока роль не заменят во вкладке «Воркфлоу» типа (Настройки → Типы задач).'
    )
  }
  if (isSystemRole(roleId)) out.push('Вернуть роль можно кнопкой «Вернуть системные роли» под списком — с настройками по умолчанию.')
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
