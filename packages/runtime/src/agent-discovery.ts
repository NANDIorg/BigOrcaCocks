import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, parseCodexModelsCache, type AgentInfo, type AgentKind, type AgentSpec, type ModelOption } from '@orca-board/core'
import { createBinaryLookup, type BinaryLookupOptions } from './binary-lookup.ts'

/** Реестр как список общего типа: опциональные поля union доступны через AgentSpec. */
const SPECS: readonly AgentSpec[] = AGENTS

export interface DetectedAgent {
  id: AgentKind
  installed: boolean
  version?: string
}

export interface AgentVersionCommand {
  file: string
  args: string[]
  timeout: number
  shell?: true
  env?: NodeJS.ProcessEnv
}

export interface AgentDiscoveryOptions extends BinaryLookupOptions {
  /** По умолчанию <home>/.codex; отдельный профиль может явно выбрать каталог конфигурации CLI. */
  codexDir?: string
  now?: () => number
  executeVersion?: (command: AgentVersionCommand) => string
}

type AgentDefaults = AgentInfo['defaults']
interface AgentConfig {
  models: ModelOption[]
  defaults: AgentDefaults
}

/**
 * Только верхние строковые ключи TOML до первой секции. Не полноценный parser:
 * сохранён прежний разбор quoted values и комментариев, включая буквальные escapes.
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

const CODEX_CONFIG_TTL_MS = 60_000

/** Кэши принадлежат одному host; defaults читаются при вызове, refresh видит актуальный PATH. */
export function createAgentDiscovery(options: AgentDiscoveryOptions = {}) {
  const lookup = createBinaryLookup(options)
  let cache: DetectedAgent[] | undefined
  let codexConfigCache: { at: number; value: AgentConfig } | undefined

  /** Ошибка версии не означает, что установленный CLI исчез. */
  function readVersion(binPath: string, args: string[]): string | undefined {
    try {
      const command: AgentVersionCommand = {
        // Windows cmd/bat требует shell; versionArgs реестра — простые флаги.
        file: lookup.isCmdScript(binPath) ? `"${binPath}"` : binPath,
        args,
        timeout: 3000,
        ...(lookup.isCmdScript(binPath) ? { shell: true } : {}),
        ...(options.env ? { env: options.env } : {})
      }
      const out = options.executeVersion ? options.executeVersion(command)
        : execFileSync(command.file, command.args, {
          timeout: command.timeout, stdio: 'pipe', encoding: 'utf8',
          ...(command.shell ? { shell: command.shell } : {}),
          ...(command.env ? { env: command.env } : {})
        })
      const line = out.split(/\r?\n/).find(l => l.trim())?.trim()
      return line ? line.slice(0, 60) : undefined
    } catch {
      return undefined
    }
  }

  function readCodexFile(name: string): string | undefined {
    try {
      return readFileSync(join(options.codexDir ?? join(options.home ?? homedir(), '.codex'), name), 'utf8')
    } catch {
      return undefined
    }
  }

  function codexConfig(refresh: boolean): AgentConfig {
    const now = (options.now ?? Date.now)()
    if (!refresh && codexConfigCache && now - codexConfigCache.at < CODEX_CONFIG_TTL_MS) return codexConfigCache.value
    const text = readCodexFile('config.toml')
    const cfg = text ? parseTopLevelToml(text) : {}
    const defaults: AgentDefaults = {
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.model_reasoning_effort ? { effort: cfg.model_reasoning_effort } : {})
    }
    const models = parseCodexModelsCache(readCodexFile('models_cache.json'), defaults.model)
    codexConfigCache = { at: now, value: { models, defaults } }
    return codexConfigCache.value
  }

  function agentConfig(spec: AgentSpec, refresh: boolean): AgentConfig {
    if (spec.id === 'codex') return codexConfig(refresh)
    return { models: [...(spec.models ?? [])], defaults: {} }
  }

  /** Первый вызов ищет CLI, refresh повторяет lookup и чтение версий. */
  function detectAgents(refresh = false): DetectedAgent[] {
    if (cache && !refresh) return cache
    cache = SPECS.map(spec => {
      const id = spec.id as AgentKind
      const binPath = lookup.findBin(spec.bin)
      if (!binPath) return { id, installed: false }
      const version = spec.versionArgs ? readVersion(binPath, spec.versionArgs) : undefined
      return { id, installed: true, version }
    })
    return cache
  }

  /** Реестр + установка + настройки проекта, в порядке AGENTS. */
  function agentInfos(enabledAgents: AgentKind[] | undefined, refresh = false): AgentInfo[] {
    const detected = new Map(detectAgents(refresh).map(d => [d.id, d]))
    return AGENTS.map(spec => {
      const d = detected.get(spec.id)
      const { models, defaults } = agentConfig(spec, refresh)
      const installed = d?.installed ?? false
      return {
        id: spec.id, title: spec.title, installed,
        enabled: installed && (enabledAgents === undefined || enabledAgents.includes(spec.id)),
        version: d?.version, models, defaults, supportsExtraArgs: true
      }
    })
  }

  return { detectAgents, agentInfos, ...lookup }
}

export type AgentDiscovery = ReturnType<typeof createAgentDiscovery>
