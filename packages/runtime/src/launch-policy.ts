import { join } from 'node:path'
import { ASSISTANT_START_PROMPT, ASSISTANT_TITLE, DEFAULT_ROLES, agentSystemPrompt, parseExtraArgs,
  type AgentKind, type AgentLanguage, type AssistantSettings, type ExtraArgsParse, type Role } from '@orca-board/core'
import { extraArgsReason, type ExtraArgsMessage } from './extra-args.ts'
import type { ExecutionMessage, ExecutionMessages } from './execution-messages.ts'

/** Проверяем снимок заново до любых effects; callback сохраняет ошибки конкретного host. */
export function parseLaunchExtraArgs(text: string | undefined, invalid: (reason: ExtraArgsMessage) => Error): string[] {
  if (text === undefined) return []
  const parse: ExtraArgsParse = typeof text === 'string' ? parseExtraArgs(text) : { ok: false, error: 'notFlag', detail: String(text) }
  if (!parse.ok) throw invalid(extraArgsReason(parse))
  return parse.args
}

export interface RoleSource {
  title: string
  roles: readonly Role[]
}

/** Роли отсутствуют в снимке типа; вложенные сообщения переводит принимающий host. */
export function missingRoleText(roleId: string, type: RoleSource): ExecutionMessage {
  const ids = type.roles.map(role => role.id).join(', ')
  const system = DEFAULT_ROLES.some(role => role.id === roleId)
  return { key: 'role.missing', params: {
    role: roleId, type: type.title, ids: ids || { key: 'common.none' },
    hint: system ? { key: 'role.missing.systemHint', params: { type: type.title } } : { key: 'role.missing.hint' }
  } }
}

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
 * cwd ассистента: нейтральная папка `userData`, не репозиторий. Это стартовая папка, а не системная песочница.
 * Вынесена сюда (не только `worker.ts`), потому что чат-режим (`assistant-chat.ts`) ищет транскрипт агента по
 * тому же cwd — `claudeDirsFor(cwd)` в `transcripts.ts`.
 */
export function assistantCwd(userDataDir: string): string {
  return join(userDataDir, 'assistant')
}

/** Режим разрешений ассистента: всегда `auto`. Ему нужен только `orca-board`, а он разрешён и так (`--allowedTools`). */
export const ASSISTANT_PERMISSION_MODE = 'auto'

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

/** Политика запуска не зависит от языка UI или Electron lifecycle. */
export function createLaunchPolicy(messages: ExecutionMessages) {
  function roleLaunchExtraArgs(role: Pick<Role, 'id' | 'extraArgs'>, cannotStart: 'worker.cannotStart' | 'coordinator.cannotStart'): string[] {
    return parseLaunchExtraArgs(role.extraArgs, reason => messages.error(cannotStart, {
      reason: { key: 'role.extraArgsInvalid', params: { id: role.id, reason } }
    }))
  }

  /**
   * Запуск ассистента из `AppSettings.assistant`: служебная инструкция (skills/assistant.md) + инструкции человека
   * блоком «# Инструкции роли «Ассистент»» + директива языка. Режим разрешений фиксированный, от типа задачи не зависит.
   * Флаги запуска разбираются здесь же: негодная строка (правили projects.json руками) — `assistant.extraArgsInvalid`
   * до старта терминала.
   */
  function assistantLaunch(settings: AssistantSettings, builtin: string, language?: AgentLanguage): AssistantLaunch {
    const extraArgs = parseLaunchExtraArgs(settings.extraArgs, reason => messages.error('assistant.extraArgsInvalid', { reason }))
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

  return { roleLaunchExtraArgs, assistantLaunch }
}
