import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AGENTS, AGENT_IDS, DEFAULT_AGENT, getAgent, type AgentInfo, type AgentKind, type AgentSpec } from '@orca-board/core'

/** Реестр как список общего типа: у элементов union'а опциональные поля вроде versionArgs недоступны. */
const SPECS: readonly AgentSpec[] = AGENTS

/** Результат поиска бинарника агента в PATH. */
export interface DetectedAgent {
  id: AgentKind
  installed: boolean
  version?: string
}

/**
 * Папки, где обычно лежат CLI-агенты, но которых может не быть в PATH приложения:
 * Electron, запущенный из Finder, получает урезанный PATH без настроек шелла.
 */
export function extraPathDirs(): string[] {
  const home = homedir()
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.bun', 'bin')
  ]
  const current = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))
  return dirs.filter((d) => !current.has(d))
}

function isExecutable(file: string): boolean {
  if (!existsSync(file)) return false
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Полный путь к бинарнику: PATH процесса плюс стандартные папки. */
function findBin(bin: string): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraPathDirs()]
  for (const dir of dirs) {
    const file = join(dir, bin)
    if (isExecutable(file)) return file
  }
  return undefined
}

/** Первая строка вывода `<bin> <versionArgs>`, не длиннее 60 символов; ошибки и таймаут → undefined. */
function readVersion(binPath: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(binPath, args, { timeout: 3000, stdio: 'pipe', encoding: 'utf8' })
    const line = out.split(/\r?\n/).find((l) => l.trim())?.trim()
    return line ? line.slice(0, 60) : undefined
  } catch {
    return undefined
  }
}

let cache: DetectedAgent[] | undefined

/**
 * Какие агенты из реестра установлены. Результат кэшируется: первый вызов считает,
 * `detectAgents(true)` пересчитывает (кнопка «Обновить» в настройках).
 */
export function detectAgents(refresh = false): DetectedAgent[] {
  if (cache && !refresh) return cache
  cache = SPECS.map((spec) => {
    const id = spec.id as AgentKind
    const binPath = findBin(spec.bin)
    if (!binPath) return { id, installed: false }
    const version = spec.versionArgs ? readVersion(binPath, spec.versionArgs) : undefined
    return { id, installed: true, version }
  })
  return cache
}

/**
 * Реестр + детект + настройка проекта. `enabledAgents` undefined — включены все установленные.
 * Порядок — как в AGENTS.
 */
export function agentInfos(enabledAgents: AgentKind[] | undefined, refresh = false): AgentInfo[] {
  const detected = new Map(detectAgents(refresh).map((d) => [d.id, d]))
  return AGENTS.map((spec) => {
    const d = detected.get(spec.id)
    const installed = d?.installed ?? false
    return {
      id: spec.id,
      title: spec.title,
      installed,
      enabled: installed && (enabledAgents === undefined ? true : enabledAgents.includes(spec.id)),
      version: d?.version
    }
  })
}

/**
 * Проверка, что агентом можно запускать задачу: известен, установлен, включён в проекте.
 * Бросает понятную ошибку — её видит и CLI, и UI.
 */
export function assertAgentUsable(agents: AgentInfo[], id: string): asserts id is AgentKind {
  const spec = getAgent(id)
  if (!spec) throw new Error(`неизвестный агент: ${id}. Известные: ${AGENT_IDS.join(', ')}`)
  const info = agents.find((a) => a.id === id)
  if (!info?.installed) throw new Error(`агент ${id} не установлен (нет бинарника ${spec.bin} в PATH)`)
  if (!info.enabled) {
    const enabled = agents.filter((a) => a.enabled).map((a) => a.id)
    throw new Error(
      `агент ${id} выключен в настройках проекта («О проекте»). Включены: ${enabled.length ? enabled.join(', ') : 'нет'}`
    )
  }
}

/**
 * Агент для новой задачи: указанный (после проверки) или первый включённый,
 * предпочтительно DEFAULT_AGENT.
 */
export function pickAgent(agents: AgentInfo[], requested: string | undefined): AgentKind {
  if (requested !== undefined) {
    assertAgentUsable(agents, requested)
    return requested
  }
  const enabled = agents.filter((a) => a.enabled)
  const chosen = enabled.find((a) => a.id === DEFAULT_AGENT) ?? enabled[0]
  if (!chosen) throw new Error('нет ни одного включённого агента')
  return chosen.id
}
