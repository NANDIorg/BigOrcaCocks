// Настройки отдельного запуска агента: без Electron и PTY, чтобы проверять окружение и временные файлы.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentInvocation } from '@orca-board/core'
import { OrcaError } from './i18n'
import { win32Launch, type Win32Launch, type Win32LaunchEnv } from './win32-launch'

const temporarySettings = new Set<string>()
// app.quit()/установщик завершают main раньше асинхронного PTY onExit: чистим оставшиеся копии синхронно.
process.once('exit', () => {
  for (const directory of temporarySettings) rmSync(directory, { recursive: true, force: true })
})

interface LaunchOptions extends Win32LaunchEnv {
  platform?: NodeJS.Platform
  home?: string
  tempRoot?: string
  env?: NodeJS.ProcessEnv
}

/** JSONC Amp: комментарии и запятые в конце, без порчи URL, экранированных строк и содержимого MCP. */
function parseSettings(source: string): Record<string, unknown> {
  let text = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (quoted) {
      text += ch
      if (ch === '\\') text += source[++i] ?? ''
      else if (ch === '"') quoted = false
    } else if (ch === '"') {
      quoted = true
      text += ch
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++
      text += ' '
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw new Error('незакрытый комментарий')
      i = end + 1
      text += ' '
    } else text += ch
  }
  // Строки — первая альтернатива: «,}» внутри значения остаётся как есть.
  text = text.replace(/("(?:[^"\\]|\\.)*")|,\s*([}\]])/g, (_match: string, value: string | undefined, close: string) => value ?? close)
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('настройки должны быть объектом')
  return value as Record<string, unknown>
}

/** Последний --settings-file человека служит источником копии; итоговый флаг приложения стоит после него. */
function ampSettingsPath(inv: AgentInvocation, cwd: string, options: LaunchOptions): { path: string; explicit: boolean } {
  let path = (options.env ?? process.env).AMP_SETTINGS_FILE
  for (let i = 0; i < inv.args.length - 1; i++) {
    const arg = inv.args[i]
    if (arg === '--settings-file') path = inv.args[++i]
    else if (arg.startsWith('--settings-file=')) path = arg.slice('--settings-file='.length)
  }
  const home = options.home ?? homedir()
  if (path) return { path: resolve(cwd, path.replace(/^~(?=[/\\])/, home)), explicit: true }
  const json = join(home, '.config', 'amp', 'settings.json')
  return { path: existsSync(json) ? json : join(home, '.config', 'amp', 'settings.jsonc'), explicit: false }
}

/**
 * Единая граница запуска воркера, координатора и PTY-ассистента. Окружение адаптера сохраняется и при
 * Windows npm-шимах, и при Unix setup+exec. Файл Amp живёт до выхода/закрытия PTY; отказ spawn тоже его удаляет.
 */
export function launchAgent(
  inv: AgentInvocation,
  cwd: string,
  start: (launch: Win32Launch, onExit: (id: string, code: number) => void) => string,
  onExit?: (id: string, code: number) => void,
  options: LaunchOptions = {}
): string {
  let temporary: string | undefined
  const dispose = (): void => {
    if (temporary) {
      rmSync(temporary, { recursive: true, force: true })
      temporarySettings.delete(temporary)
    }
  }
  try {
    let args = inv.args
    if (inv.settingsFile) {
      const original = ampSettingsPath(inv, cwd, options)
      let settings: Record<string, unknown> = {}
      try {
        if (original.explicit || existsSync(original.path)) settings = parseSettings(readFileSync(original.path, 'utf8'))
      } catch {
        throw OrcaError.of({ key: 'agentLaunch.settingsInvalid', params: { path: original.path } })
      }
      temporary = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'orca-agent-settings-'))
      temporarySettings.add(temporary)
      const file = join(temporary, 'settings.json')
      writeFileSync(file, JSON.stringify({ ...settings, ...inv.settingsFile.overrides }), { mode: 0o600 })
      args = [...args.slice(0, -1), inv.settingsFile.flag, file, ...args.slice(-1)]
    }
    const launch = (options.platform ?? process.platform) === 'win32'
      ? win32Launch(inv.command, args, options)
      : { command: inv.command, args, env: {} }
    return start({ ...launch, env: { ...inv.env, ...launch.env } }, (id, code) => {
      try { onExit?.(id, code) } finally { dispose() }
    })
  } catch (error) {
    dispose()
    throw error
  }
}
