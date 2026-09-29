import { isTaskRole, type AgentInfo, type AgentKind, type Role, type Workflow } from '@orca-board/core'
import { nodeTitle } from './defaultTitles'
import type { WfScope } from './workflowNav'

// Выбор исполнителя этапа в инспекторе воркфлоу (карточка «Кто выполняет») и состояние агента роли на вкладке «Роли».
// Чистые функции без React: вся ветвистая логика карточки здесь, чтобы её можно было проверить тестами без DOM.

/** Состояние агента роли для точки статуса и предупреждений. */
export type AgentState = 'on' | 'off' | 'unknown'

/**
 * Агент роли включён, выключен или неизвестен. `unknown` — список агентов не пришёл или агента в нём нет:
 * тревогу по нему не поднимаем, чтобы не пугать «выключенным» агентом, о котором ничего не знаем.
 */
export function roleAgentState(info: AgentInfo | undefined): AgentState {
  if (!info) return 'unknown'
  return info.enabled ? 'on' : 'off'
}

/**
 * Роли проверок: roleId → названия gate-нод верхнего уровня графа, которые ведёт роль. Правило — как у store
 * (`bindToStage`): подзадачи этапа не получают роль, стоящую на gate графа, какой бы у неё ни был id. Путь подзадачи
 * (`subflow`) не смотрим — его проверки не мешают роли работать в других этапах.
 */
export function checkRoleNodes(wf: Workflow): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const n of wf.nodes) {
    if (n.type !== 'gate' || !n.roleId) continue
    out.set(n.roleId, [...(out.get(n.roleId) ?? []), nodeTitle(n)])
  }
  return out
}

/** Роль в карточке «Кто выполняет»: строка списка или краткая карточка под `<select>` у gate/decision/ask. */
export interface StageRoleOption {
  id: string
  title: string
  /** Описание без пробелов по краям; пустое — поля нет. */
  description?: string
  agent: AgentKind
  model?: string
  state: AgentState
  /** Роль отмечена в `roleIds` ноды. */
  checked: boolean
  /** Только у ролей проверок: названия gate-нод, которые ведёт роль. */
  checkedBy?: string[]
}

/** Id из выбора ноды, которого нельзя показать строкой: роли нет в типе (`missing`) или она служебная (`service`). */
export interface StageRoleOrphan {
  id: string
  reason: 'missing' | 'service'
}

export interface StageRolesView {
  /** Рабочие роли: не служебные и не роли проверок, в порядке ролей типа. */
  work: StageRoleOption[]
  /** Роли проверок (gate верхнего графа); в пути подзадачи группы нет — пусто. */
  checks: StageRoleOption[]
  /** «Сироты» выбора в порядке `chosen` — показываются с кнопкой «Убрать». */
  orphans: StageRoleOrphan[]
  /** Из чего выберет координатор в режиме `coordinator`: рабочие роли без выключенного агента. */
  pool: StageRoleOption[]
  /** Id рабочих ролей без описания: координатор выбирает их только по названию. */
  noDescription: string[]
  /** `coordinator` — роли не заданы, выбирает координатор; `chosen` — только отмеченные. */
  mode: 'coordinator' | 'chosen'
  /** Путь подзадачи с двумя и больше ролями (из файла): роль подзадачи должна быть одна. */
  pathConflict: boolean
}

export interface StageRolesInput {
  /** Все роли типа (вместе со служебными — они нужны, чтобы отличить `service` от `missing`). */
  roles: readonly Role[]
  /** Граф, в котором стоит нода: gate-ноды его верхнего уровня задают роли проверок. */
  workflow: Workflow
  scope: WfScope
  /** Выбор ноды «Работа» — `wfWorkRoleIds(node)` (учитывает `roleId` версии 1). */
  chosen: readonly string[]
  /** Агенты для состояния; не передан — у всех `unknown`. Для типа задачи — `libraryAgents(agents)`. */
  agents?: readonly AgentInfo[]
  /** Человек переключился на «Только выбранные», но ещё ничего не отметил: режим `chosen` при пустом выборе. */
  localChosen?: boolean
}

function optionOf(r: Role, chosen: readonly string[], agents: readonly AgentInfo[] | undefined, checkedBy?: string[]): StageRoleOption {
  const description = r.description?.trim()
  return {
    id: r.id,
    title: r.title,
    ...(description ? { description } : {}),
    agent: r.agent,
    ...(r.model ? { model: r.model } : {}),
    state: roleAgentState(agents?.find((a) => a.id === r.agent)),
    checked: chosen.includes(r.id),
    ...(checkedBy ? { checkedBy } : {})
  }
}

/** Всё, что показывает карточка «Кто выполняет» у ноды «Работа» (этап графа или путь подзадачи). */
export function stageRolesView(i: StageRolesInput): StageRolesView {
  const checkNodes = i.scope === 'subtask' ? new Map<string, string[]>() : checkRoleNodes(i.workflow)
  const work: StageRoleOption[] = []
  const checks: StageRoleOption[] = []
  for (const r of i.roles) {
    if (!isTaskRole(r.id)) continue
    const by = checkNodes.get(r.id)
    if (by) checks.push(optionOf(r, i.chosen, i.agents, by))
    else work.push(optionOf(r, i.chosen, i.agents))
  }
  const shown = new Set([...work, ...checks].map((r) => r.id))
  const orphans: StageRoleOrphan[] = i.chosen
    .filter((id) => !shown.has(id))
    .map((id) => ({ id, reason: isTaskRole(id) ? 'missing' : 'service' }))
  return {
    work,
    checks,
    orphans,
    pool: work.filter((r) => r.state !== 'off'),
    noDescription: work.filter((r) => !r.description).map((r) => r.id),
    mode: i.chosen.length > 0 || i.localChosen ? 'chosen' : 'coordinator',
    pathConflict: i.scope === 'subtask' && i.chosen.length >= 2
  }
}

/**
 * Краткая карточка роли под `<select>` у gate/decision/ask. `empty` — роль не выбрана, `missing` — её нет в типе,
 * `service` — служебная (в список выбора не попадает, но может прийти из файла).
 */
export function stageRoleBrief(
  roles: readonly Role[], roleId: string | undefined, agents?: readonly AgentInfo[]
): { role: StageRoleOption } | { problem: 'empty' | 'missing' | 'service' } {
  if (!roleId) return { problem: 'empty' }
  if (!isTaskRole(roleId)) return { problem: 'service' }
  const r = roles.find((x) => x.id === roleId)
  return r ? { role: optionOf(r, [roleId], agents) } : { problem: 'missing' }
}

/** Отметить или снять роль: порядок выбора сохраняется, повторов нет, «сироты» остаются, пока их не уберут явно. */
export function toggleStageRole(chosen: readonly string[], id: string, on: boolean): string[] {
  if (on) return chosen.includes(id) ? [...chosen] : [...chosen, id]
  return chosen.filter((x) => x !== id)
}

/** Роль пути подзадачи — одна: `null` («Роль не меняется») — пустой список. */
export function pickPathRole(id: string | null): string[] {
  return id ? [id] : []
}
