import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findBin, isCmdScript, missingRoleText, type RoleSource } from '@orca-board/runtime'
import { AGENTS, AGENT_IDS, getAgent, parseCodexModelsCache, type AgentInfo, type AgentKind, type AgentSpec, type ModelOption, type Role } from '@orca-board/core'
import { OrcaError, mtIn } from './i18n'

/** Реестр как список общего типа: у элементов union'а опциональные поля вроде versionArgs недоступны. */
const SPECS: readonly AgentSpec[] = AGENTS

/** Результат поиска бинарника агента в PATH. */
export interface DetectedAgent {
  id: AgentKind
  installed: boolean
  version?: string
}

export { extraPathDirs, findBin, isCmdScript } from '@orca-board/runtime'

/** Первая строка вывода `<bin> <versionArgs>`, не длиннее 60 символов; ошибки и таймаут → undefined. */
function readVersion(binPath: string, args: string[]): string | undefined {
  try {
    // .cmd/.bat Node запускает только через оболочку; аргументы versionArgs — простые флаги без спецсимволов.
    const out = isCmdScript(binPath)
      ? execFileSync(`"${binPath}"`, args, { timeout: 3000, stdio: 'pipe', encoding: 'utf8', shell: true })
      : execFileSync(binPath, args, { timeout: 3000, stdio: 'pipe', encoding: 'utf8' })
    const line = out.split(/\r?\n/).find((l) => l.trim())?.trim()
    return line ? line.slice(0, 60) : undefined
  } catch {
    return undefined
  }
}

type AgentDefaults = AgentInfo['defaults']

/**
 * Ключи верхнего уровня TOML-конфига (до первой секции `[..]`) вида `key = "value"`.
 * Не полноценный TOML: только строки в двойных/одинарных кавычках, комментарии после значения.
 */
export function parseTopLevelToml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) break
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line)
    if (m) out[m[1]] = m[2] ?? m[3]
  }
  return out
}

/** Текст файла из ~/.codex; нет файла/ошибка чтения — undefined. */
function readCodexFile(name: string): string | undefined {
  try {
    return readFileSync(join(homedir(), '.codex', name), 'utf8')
  } catch {
    return undefined
  }
}

/** Дефолты codex из текста config.toml: model и model_reasoning_effort. Нет текста — {}. */
function codexDefaultsFrom(configText: string | undefined): AgentDefaults {
  const cfg = configText ? parseTopLevelToml(configText) : {}
  return {
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.model_reasoning_effort ? { effort: cfg.model_reasoning_effort } : {})
  }
}

interface AgentConfig {
  models: ModelOption[]
  defaults: AgentDefaults
}

/** Сколько живёт прочитанный конфиг codex (config.toml + models_cache.json). */
const CODEX_CONFIG_TTL_MS = 60_000
let codexConfigCache: { at: number; value: AgentConfig } | undefined

/** Модели и дефолты codex из ~/.codex; кэш на CODEX_CONFIG_TTL_MS, `refresh` перечитывает файлы. */
function codexConfig(refresh: boolean): AgentConfig {
  const now = Date.now()
  if (!refresh && codexConfigCache && now - codexConfigCache.at < CODEX_CONFIG_TTL_MS) return codexConfigCache.value
  const defaults = codexDefaultsFrom(readCodexFile('config.toml'))
  const models = parseCodexModelsCache(readCodexFile('models_cache.json'), defaults.model)
  codexConfigCache = { at: now, value: { models, defaults } }
  return codexConfigCache.value
}

/** Модели и дефолты агента: codex — из ~/.codex, остальные — из реестра (models) и без дефолтов. */
function agentConfig(spec: AgentSpec, refresh: boolean): AgentConfig {
  if (spec.id === 'codex') return codexConfig(refresh)
  return { models: [...(spec.models ?? [])], defaults: {} }
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
    const { models, defaults } = agentConfig(spec, refresh)
    const installed = d?.installed ?? false
    return {
      id: spec.id,
      title: spec.title,
      installed,
      enabled: installed && (enabledAgents === undefined ? true : enabledAgents.includes(spec.id)),
      version: d?.version,
      models,
      defaults,
      // Этот main сохраняет и применяет `extraArgs` — renderer по признаку открывает поле флагов.
      supportsExtraArgs: true
    }
  })
}

/**
 * Проверка, что агентом можно запускать задачу: известен, установлен, включён в проекте.
 * Бросает понятную ошибку — её видит и CLI, и UI.
 */
export function assertAgentUsable(agents: AgentInfo[], id: string): asserts id is AgentKind {
  const spec = getAgent(id)
  if (!spec) throw new OrcaError('agent.unknown', { id, known: AGENT_IDS.join(', ') })
  const info = agents.find((a) => a.id === id)
  if (!info?.installed) throw new OrcaError('agent.notInstalled', { id, bin: spec.bin })
  if (!info.enabled) {
    const enabled = agents.filter((a) => a.enabled).map((a) => a.id)
    throw new OrcaError('agent.disabled', { id, enabled: enabled.length ? enabled.join(', ') : { key: 'common.none' } })
  }
}

export { missingRoleText } from '@orca-board/runtime'
export type { RoleSource } from '@orca-board/runtime'

/**
 * Текст ошибки «роли нет в типе задачи»: какие роли у типа прогона, как их посмотреть агенту (`roles list`)
 * и где их правит человек. Роли живут в типе задачи, у проекта их нет. Один текст для task create,
 * запуска воркера и координатора.
 */
export function missingRoleMessage(roleId: string, type: RoleSource): string {
  const m = missingRoleText(roleId, type)
  return mtIn('ru', m.key, m.params)
}

/**
 * Роль для новой задачи: указанная (её агент должен быть usable) или единственная
 * в типе задачи. Если ролей несколько и ни одна не указана — ошибка со списком.
 */
export function pickRole(type: RoleSource, agents: AgentInfo[], requested: string | undefined): Role {
  const roles = type.roles
  const ids = roles.map((r) => r.id).join(', ')
  if (requested !== undefined) {
    const role = roles.find((r) => r.id === requested)
    if (!role) throw OrcaError.of(missingRoleText(requested, type))
    assertAgentUsable(agents, role.agent)
    return role
  }
  if (roles.length === 1) {
    assertAgentUsable(agents, roles[0].agent)
    return roles[0]
  }
  throw new Error(`--role обязателен. Роли: ${ids}`)
}
