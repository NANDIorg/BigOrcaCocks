// Чистые функции ассистента доски — без electron, чтобы их можно было проверить node:test.
import { join } from 'node:path'
import {
  ASSISTANT_START_PROMPT, ASSISTANT_TITLE, DEFAULT_ASSISTANT_SETTINGS, agentSystemPrompt, isAgentKind,
  type AgentKind, type AgentLanguage, type AssistantSettings
} from '@orca-board/core'
import { OrcaError } from './i18n'
import { extraArgsProblem, launchExtraArgs } from './launch-extra-args'

export interface AssistantEnvInput {
  socketPath: string
  /** PATH с bin CLI (`workerPath()`). */
  path: string
  /** Node из Electron для обёртки orca-board в собранном приложении; undefined — внешний node. */
  nodePath?: string
}

/**
 * Окружение ассистента. Ассистент один на всё приложение, поэтому `ORCA_PROJECT` нет: проект он называет
 * явно (`--project`), а без флага CLI берёт активный в UI. `ORCA_RUN_ID` тоже нет — прогона у ассистента нет.
 */
export function assistantEnv(input: AssistantEnvInput): Record<string, string> {
  return {
    ...(input.nodePath ? { ORCA_NODE: input.nodePath } : {}),
    ORCA_SOCKET: input.socketPath,
    PATH: input.path,
    ORCA_ROLE: 'assistant'
  }
}

/**
 * cwd ассистента: нейтральная папка `userData`, не репозиторий (у ассистента нет файлового доступа к проектам).
 * Вынесена сюда (не только `worker.ts`), потому что чат-режим (`assistant-chat.ts`) ищет транскрипт агента по
 * тому же cwd — `claudeDirsFor(cwd)` в `transcripts.ts`.
 */
export function assistantCwd(userDataDir: string): string {
  return join(userDataDir, 'assistant')
}

/** Режим разрешений ассистента: всегда `auto`. Ему нужен только `orca-board`, а он разрешён и так (`--allowedTools`). */
export const ASSISTANT_PERMISSION_MODE = 'auto'

const ASSISTANT_TEXT_FIELDS = ['model', 'effort', 'systemPrompt', 'extraArgs'] as const

/** Поля, которые хранятся как введены (без trim — иначе автосохранение съедало бы ввод), как у ролей. */
function keptAsTyped(field: (typeof ASSISTANT_TEXT_FIELDS)[number]): boolean {
  return field === 'systemPrompt' || field === 'extraArgs'
}

/**
 * Настройки ассистента из projects.json: неизвестный агент — агент по умолчанию, не-строки и пустые строки
 * выпадают, флаги запуска, которые не разбирает `parseExtraArgs`, — тоже. Не бросает: битое поле не должно мешать
 * запуску ассистента.
 */
export function loadedAssistantSettings(raw: unknown): AssistantSettings {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const agent = typeof r.agent === 'string' && isAgentKind(r.agent) ? r.agent : DEFAULT_ASSISTANT_SETTINGS.agent
  const out: AssistantSettings = { agent }
  for (const k of ASSISTANT_TEXT_FIELDS) {
    const v = r[k]
    if (typeof v !== 'string' || !v.trim()) continue
    if (k === 'extraArgs' && extraArgsProblem(v)) continue
    out[k] = keptAsTyped(k) ? v : v.trim()
  }
  return out
}

/**
 * Патч настроек ассистента поверх текущих. Пустая строка очищает поле; промпт и флаги запуска хранятся как введены
 * (без trim — иначе автосохранение съедало бы ввод), как у ролей. Смена агента без модели, effort и флагов в патче
 * сбрасывает их: модель и флаги одного агента другому не подходят (так же делает редактор ролей, `agentChangePatch`).
 * Флаги, которые не разбирает `parseExtraArgs`, отвергаются. Поля `extraArgs` в патче нет (старый renderer, CLI
 * `settings set`) — флаги остаются прежними.
 */
export function mergedAssistantSettings(current: AssistantSettings, patch: unknown): AssistantSettings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new OrcaError('assistant.notObject')
  const p = patch as Record<string, unknown>
  const next: AssistantSettings = { ...current }
  if (p.agent !== undefined) {
    if (typeof p.agent !== 'string' || !isAgentKind(p.agent)) throw new OrcaError('assistant.unknownAgent', { agent: String(p.agent) })
    if (p.agent !== current.agent) {
      delete next.model
      delete next.effort
      delete next.extraArgs
    }
    next.agent = p.agent
  }
  for (const k of ASSISTANT_TEXT_FIELDS) {
    const v = p[k]
    if (v === undefined) continue
    if (typeof v !== 'string') throw new OrcaError('assistant.notString', { field: k })
    if (!v.trim()) {
      delete next[k]
      continue
    }
    const reason = k === 'extraArgs' ? extraArgsProblem(v) : undefined
    if (reason) throw new OrcaError('assistant.extraArgsInvalid', { reason })
    next[k] = keptAsTyped(k) ? v : v.trim()
  }
  return next
}

/** Что запускать для ассистента: агент, системный промпт, стартовое сообщение и опции `AgentSpec.invoke`. */
export interface AssistantLaunch {
  agent: AgentKind
  system: string
  prompt: string
  permissionMode: string
  model?: string
  effort?: string
  /** Флаги пользователя, уже разобранные в argv (`AgentInvokeOptions.extraArgs`); нет флагов — нет поля. */
  extraArgs?: string[]
}

/**
 * Запуск ассистента из `AppSettings.assistant`: служебная инструкция (skills/assistant.md) + инструкции человека
 * блоком «# Инструкции роли «Ассистент»» + директива языка. Режим разрешений фиксированный, от типа задачи не зависит.
 * Флаги запуска разбираются здесь же: негодная строка (правили projects.json руками) — `assistant.extraArgsInvalid`
 * до старта терминала.
 */
export function assistantLaunch(settings: AssistantSettings, builtin: string, language?: AgentLanguage): AssistantLaunch {
  const extraArgs = launchExtraArgs(settings.extraArgs, (reason) => ({ key: 'assistant.extraArgsInvalid', params: { reason } }))
  return {
    agent: settings.agent,
    system: agentSystemPrompt(builtin, { role: { title: ASSISTANT_TITLE, systemPrompt: settings.systemPrompt }, language }),
    prompt: ASSISTANT_START_PROMPT,
    permissionMode: ASSISTANT_PERMISSION_MODE,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(extraArgs.length ? { extraArgs } : {})
  }
}
