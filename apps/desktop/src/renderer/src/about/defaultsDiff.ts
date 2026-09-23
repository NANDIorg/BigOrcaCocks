import { DEFAULT_COLUMNS, DEFAULT_ROLES, type AgentInfo, type AgentKind } from '@orca-board/core'
import type { Project, ProjectDefaults } from '../../../shared/ipc'

/** JSON с отсортированными ключами: сравнение ролей/колонок не зависит от порядка полей. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

const quoted = (titles: string[]): string => titles.map((t) => `«${t}»`).join(', ')

/** Отличие списка проекта от дефолта: «+1 «Дизайнер», −1 «QA», изменено 2, порядок»; одинаковые — null. */
function listDiff<T extends { id: string; title: string }>(mine: T[], base: T[]): string | null {
  const baseById = new Map(base.map((x) => [x.id, x]))
  const mineIds = new Set(mine.map((x) => x.id))
  const added = mine.filter((x) => !baseById.has(x.id))
  const removed = base.filter((x) => !mineIds.has(x.id))
  const changed = mine.filter((x) => {
    const b = baseById.get(x.id)
    return b !== undefined && stable(x) !== stable(b)
  })
  const parts: string[] = []
  if (added.length) parts.push(`+${added.length} ${quoted(added.map((x) => x.title))}`)
  if (removed.length) parts.push(`−${removed.length} ${quoted(removed.map((x) => x.title))}`)
  if (changed.length) parts.push(`изменено ${changed.length}`)
  const sameSet = !added.length && !removed.length
  if (sameSet && mine.map((x) => x.id).join('\n') !== base.map((x) => x.id).join('\n')) parts.push('порядок')
  return parts.length ? parts.join(', ') : null
}

/** Включённые установленные агенты: undefined — все установленные. */
function enabledSet(list: AgentKind[] | undefined, agents: AgentInfo[]): Set<AgentKind> {
  return new Set(agents.filter((a) => a.installed && (list === undefined || list.includes(a.id))).map((a) => a.id))
}

/**
 * Чем настройки проекта отличаются от дефолта для новых проектов — строки для «Обзора»
 * («роли (+1 «Дизайнер»)», «разрешения»). Пустой массив — совпадают.
 */
export function defaultsDiff(p: Project, d: ProjectDefaults, agents: AgentInfo[]): string[] {
  const out: string[] = []
  const mine = enabledSet(p.enabledAgents, agents)
  const base = enabledSet(d.enabledAgents, agents)
  const title = (id: AgentKind): string => agents.find((a) => a.id === id)?.title ?? id
  const on = [...mine].filter((id) => !base.has(id)).map((id) => `+${title(id)}`)
  const off = [...base].filter((id) => !mine.has(id)).map((id) => `−${title(id)}`)
  if (on.length || off.length) out.push(`агенты (${[...on, ...off].join(', ')})`)
  const roles = listDiff(p.roles ?? DEFAULT_ROLES, d.roles)
  if (roles) out.push(`роли (${roles})`)
  const columns = listDiff(p.columns ?? DEFAULT_COLUMNS, d.columns)
  if (columns) out.push(`колонки (${columns})`)
  if ((p.permissionMode ?? 'auto') !== d.permissionMode) out.push('разрешения')
  if ((p.agentRules ?? '').trim() !== (d.agentRules ?? '').trim()) out.push('правила доски')
  return out
}
