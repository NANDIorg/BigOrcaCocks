import { isAgentKind } from '@orca-board/core'
import type { RuntimeSettings, RuntimeSettingsPatch, NotificationSettingsPatch, NotifyKind } from '@orca-board/contracts'
import { NOTIFY_KINDS, isTime } from '@orca-board/contracts'
export interface AgentSocketSettings extends RuntimeSettings { keepInBackground?: boolean; updates?: { autoCheck: boolean; autoDownload: boolean; installWhenIdle: boolean } }
export interface AgentSocketSettingsPatch extends RuntimeSettingsPatch { keepInBackground?: boolean; updates?: { autoCheck?: boolean; autoDownload?: boolean; installWhenIdle?: boolean } }
type AppSettingsPatch = AgentSocketSettingsPatch


// Разбор флагов CLI `settings set` в AppSettingsPatch. Чистый модуль — без pty/electron (как request-params.ts).

function boolFlag(v: unknown, flag: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${flag} — флаг без значения: включить — сам флаг, выключить — --no-${flag.slice(2)}`)
  return v
}

/** `--notify-role <id>=on|off` / `--notify-event <kind>=on|off`: CLI присылает массив (повторяемый флаг). */
function pairs(v: unknown, flag: string): Array<[string, boolean]> {
  const raw = Array.isArray(v) ? v : v === undefined ? [] : [v]
  return raw.map((item) => {
    if (typeof item !== 'string') throw new Error(`${flag} требует значения в формате id=on|off`)
    const eq = item.indexOf('=')
    if (eq < 0) throw new Error(`${flag} требует формат id=on|off (получено «${item}»)`)
    const key = item.slice(0, eq)
    const val = item.slice(eq + 1)
    if (val !== 'on' && val !== 'off') throw new Error(`${flag}: значение должно быть on или off (получено «${val}» у «${key}»)`)
    return [key, val === 'on']
  })
}

/** Флаги ассистента → поля `AssistantSettings`. Пустая строка — очистить поле (мерж — `mergedAssistantSettings`). */
const ASSISTANT_FLAGS = [
  ['assistant-agent', 'agent'],
  ['assistant-model', 'model'],
  ['assistant-effort', 'effort'],
  ['assistant-prompt', 'systemPrompt']
] as const

/**
 * Патч `AppSettings` из флагов `settings set` (docs/assistant-chat.md → «2. Контракт CLI/сокета»). Любой поднабор
 * флагов; отсутствующие — не трогают текущее значение (мерж — `ProjectManager.setSettings`).
 */
export function settingsPatchFromParams(p: Record<string, unknown>): AppSettingsPatch {
  const patch: AppSettingsPatch = {}
  if (p.language !== undefined) {
    if (p.language !== 'ru' && p.language !== 'en') throw new Error('--language: ru или en')
    patch.language = p.language
  }
  if (p['keep-in-background'] !== undefined) patch.keepInBackground = boolFlag(p['keep-in-background'], '--keep-in-background')

  const notifications: NotificationSettingsPatch = {}
  if (p['notifications-enabled'] !== undefined) notifications.enabled = boolFlag(p['notifications-enabled'], '--notifications-enabled')
  if (p['notify-role'] !== undefined) {
    const roles: Record<string, boolean> = {}
    for (const [id, on] of pairs(p['notify-role'], '--notify-role')) roles[id] = on
    notifications.roles = roles
  }
  if (p['notify-event'] !== undefined) {
    const events: Partial<Record<NotifyKind, boolean>> = {}
    for (const [kind, on] of pairs(p['notify-event'], '--notify-event')) {
      if (!(NOTIFY_KINDS as string[]).includes(kind)) throw new Error(`--notify-event: неизвестный вид «${kind}» (${NOTIFY_KINDS.join(', ')})`)
      events[kind as NotifyKind] = on
    }
    notifications.events = events
  }
  if (p['quiet-hours'] !== undefined) {
    if (p['quiet-hours'] === false) {
      notifications.quietHours = { enabled: false }
    } else {
      if (typeof p['quiet-hours'] !== 'string') throw new Error('--quiet-hours требует значения "ЧЧ:ММ-ЧЧ:ММ" (или --no-quiet-hours, чтобы выключить)')
      const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(p['quiet-hours'])
      if (!m || !isTime(m[1]) || !isTime(m[2])) throw new Error(`--quiet-hours: формат ЧЧ:ММ-ЧЧ:ММ, например 22:00-08:00 (получено «${p['quiet-hours']}»)`)
      notifications.quietHours = { enabled: true, from: m[1], to: m[2] }
    }
  }
  if (p.sound !== undefined) notifications.sound = boolFlag(p.sound, '--sound')
  if (p['show-preview'] !== undefined) notifications.showPreview = boolFlag(p['show-preview'], '--show-preview')
  if (Object.keys(notifications).length) patch.notifications = notifications

  const updates: AppSettingsPatch['updates'] = {}
  if (p['auto-check'] !== undefined) updates.autoCheck = boolFlag(p['auto-check'], '--auto-check')
  if (p['auto-download'] !== undefined) updates.autoDownload = boolFlag(p['auto-download'], '--auto-download')
  if (p['install-when-idle'] !== undefined) updates.installWhenIdle = boolFlag(p['install-when-idle'], '--install-when-idle')
  if (Object.keys(updates).length) patch.updates = updates

  const assistant: NonNullable<AppSettingsPatch['assistant']> = {}
  for (const [flag, field] of ASSISTANT_FLAGS) {
    const v = p[flag]
    if (v === undefined) continue
    if (typeof v !== 'string') throw new Error(`--${flag} требует значения (пустая строка "" — очистить)`)
    if (field === 'agent') {
      if (!isAgentKind(v)) throw new Error(`--assistant-agent: неизвестный агент «${v}» (id из orca-board agents list)`)
      assistant.agent = v
    } else {
      assistant[field] = v
    }
  }
  if (Object.keys(assistant).length) patch.assistant = assistant

  return patch
}
