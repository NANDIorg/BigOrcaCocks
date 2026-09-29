// Чистые функции ассистента доски — без electron, чтобы их можно было проверить node:test.
import { join } from 'node:path'
import {
  ASSISTANT_START_PROMPT, ASSISTANT_TITLE, DEFAULT_ASSISTANT_SETTINGS, agentSystemPrompt, isAgentKind,
  type AgentKind, type AgentLanguage, type AssistantSettings
} from '@orca-board/core'
import { OrcaError } from './i18n'

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

const ASSISTANT_TEXT_FIELDS = ['model', 'effort', 'systemPrompt'] as const

/**
 * Настройки ассистента из projects.json: неизвестный агент — агент по умолчанию, не-строки и пустые строки
 * выпадают. Не бросает: битое поле не должно мешать запуску ассистента.
 */
export function loadedAssistantSettings(raw: unknown): AssistantSettings {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const agent = typeof r.agent === 'string' && isAgentKind(r.agent) ? r.agent : DEFAULT_ASSISTANT_SETTINGS.agent
  const out: AssistantSettings = { agent }
  for (const k of ASSISTANT_TEXT_FIELDS) {
    const v = r[k]
    if (typeof v === 'string' && v.trim()) out[k] = k === 'systemPrompt' ? v : v.trim()
  }
  return out
}

/**
 * Патч настроек ассистента поверх текущих. Пустая строка очищает поле; промпт хранится как введён (без trim —
 * иначе автосохранение съедало бы ввод), как у ролей. Смена агента без модели и effort в патче сбрасывает их:
 * модель одного агента другому не подходит (так же делает редактор ролей, `agentChangePatch`).
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
    }
    next.agent = p.agent
  }
  for (const k of ASSISTANT_TEXT_FIELDS) {
    const v = p[k]
    if (v === undefined) continue
    if (typeof v !== 'string') throw new OrcaError('assistant.notString', { field: k })
    if (v.trim()) next[k] = k === 'systemPrompt' ? v : v.trim()
    else delete next[k]
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
}

/**
 * Запуск ассистента из `AppSettings.assistant`: служебная инструкция (skills/assistant.md) + инструкции человека
 * блоком «# Инструкции роли «Ассистент»» + директива языка. Режим разрешений фиксированный, от типа задачи не зависит.
 */
export function assistantLaunch(settings: AssistantSettings, builtin: string, language?: AgentLanguage): AssistantLaunch {
  return {
    agent: settings.agent,
    system: agentSystemPrompt(builtin, { role: { title: ASSISTANT_TITLE, systemPrompt: settings.systemPrompt }, language }),
    prompt: ASSISTANT_START_PROMPT,
    permissionMode: ASSISTANT_PERMISSION_MODE,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {})
  }
}
