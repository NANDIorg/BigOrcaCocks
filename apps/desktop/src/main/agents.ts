import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AGENTS, AGENT_IDS, DEFAULT_ROLES, getAgent, parseCodexModelsCache, type AgentInfo, type AgentKind, type AgentSpec, type ModelOption, type Role } from '@orca-board/core'

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
  const dirs =
    process.platform === 'win32'
      ? [
          // npm i -g кладёт shim-ы claude.cmd и т.п. в %APPDATA%\npm.
          ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []),
          ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs')] : []),
          join(home, '.local', 'bin'),
          join(home, '.cargo', 'bin'),
          join(home, '.bun', 'bin')
        ]
      : [
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

/**
 * Суффиксы имени бинарника: на Windows — расширения из PATHEXT (claude.cmd, codex.exe…), затем имя как есть;
 * иначе только имя как есть. Расширения первыми: рядом с claude.cmd npm кладёт sh-скрипт `claude` без расширения.
 */
function binSuffixes(): string[] {
  if (process.platform !== 'win32') return ['']
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [...exts.map((e) => e.toLowerCase()), '']
}

/** Бинарник — bat/cmd-скрипт: на Windows его запускает только cmd.exe. */
export function isCmdScript(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
}

/** Полный путь к бинарнику: PATH процесса плюс стандартные папки. */
export function findBin(bin: string): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraPathDirs()]
  const suffixes = binSuffixes()
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const file = join(dir, bin + suffix)
      if (isExecutable(file)) return file
    }
  }
  return undefined
}

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
      defaults
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

/** Роли типа задачи и его название — для текста ошибки «роли нет» (`ResolvedRunType` подходит как есть). */
export interface RoleSource {
  title: string
  roles: readonly Role[]
}

/**
 * Текст ошибки «роли нет в типе задачи»: какие роли у типа прогона, как их посмотреть агенту (`roles list`)
 * и где их правит человек. Роли живут в типе задачи, у проекта их нет. Один текст для task create,
 * запуска воркера и координатора.
 */
export function missingRoleMessage(roleId: string, type: RoleSource): string {
  const ids = type.roles.map((r) => r.id).join(', ') || 'нет'
  const hint = DEFAULT_ROLES.some((r) => r.id === roleId)
    ? ` Это системная роль — её можно вернуть: «Настройки» → «Типы задач» → «${type.title}» → «Вернуть системные роли».`
    : ' Роли типа меняются в «Настройки» → «Типы задач».'
  return `роли «${roleId}» нет в типе задачи «${type.title}». Роли типа: ${ids} (orca-board roles list).${hint}`
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
    if (!role) throw new Error(missingRoleMessage(requested, type))
    assertAgentUsable(agents, role.agent)
    return role
  }
  if (roles.length === 1) {
    assertAgentUsable(agents, roles[0].agent)
    return roles[0]
  }
  throw new Error(`--role обязателен. Роли: ${ids}`)
}
