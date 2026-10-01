// Флаги пользователя к команде запуска агента (`Role.extraArgs`, `AssistantSettings.extraArgs`): разбор строки
// в argv без shell и поиск флагов, которыми управляет само приложение.
// Модуль импортирует renderer (превью команды, проверка ввода), поэтому без node-импортов;
// значения импортируются с расширением .ts.
import type { ReservedFlagReason } from './agents'
import { getAgent } from './agents.ts'

/** Предел длины строки флагов: на Windows флаги делят с промптом ~8000 символов командной строки cmd.exe. */
export const EXTRA_ARGS_MAX_LENGTH = 2000

/** Предел числа аргументов после разбора. */
export const EXTRA_ARGS_MAX_COUNT = 64

/**
 * Почему строку флагов нельзя принять:
 * `quote` — незакрытая кавычка; `separator` — токен `--` (всё после него, включая флаги приложения, стало бы
 * позиционным); `notFlag` — первый токен не флаг (была бы подкоманда: `codex exec`, `claude mcp`);
 * `control` — управляющий символ; `length` / `count` — превышены `EXTRA_ARGS_MAX_LENGTH` / `EXTRA_ARGS_MAX_COUNT`.
 */
export type ExtraArgsError = 'quote' | 'separator' | 'notFlag' | 'control' | 'length' | 'count'

/** Результат разбора. `detail` — что именно не так: кавычка, токен, код символа (`U+0000`), фактическая длина или число. */
export type ExtraArgsParse =
  | { ok: true; args: string[] }
  | { ok: false; error: ExtraArgsError; detail?: string }

function isSeparator(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** Управляющий символ, кроме таба и переводов строки: те вне кавычек — разделители, внутри — часть значения. */
function controlChar(text: string): string | undefined {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if ((code < 0x20 && !isSeparator(ch)) || code === 0x7f) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return undefined
}

/**
 * Разбирает строку флагов в аргументы — сам, без shell, одинаково на всех платформах.
 * - Разделители — пробелы, табы и переводы строк вне кавычек.
 * - `'…'` — буквально. `"…"` — внутри только `\"` → `"` и `\\` → `\`, прочие `\` буквальны.
 *   Вне кавычек `\` буквален: иначе сломался бы Windows-путь `C:\Users\me`.
 * - Кавычки склеиваются с соседним текстом (`--dir="a b"` → `--dir=a b`); `""` — пустой аргумент.
 * - Никаких раскрытий: `$VAR`, `~`, `*`, `;`, `|`, `&&`, `>` остаются как есть.
 * - Только флаги: первый токен начинается с `-`, токена `--` быть не может (см. `ExtraArgsError`).
 * Пустая строка или одни пробелы — `args: []`.
 */
export function parseExtraArgs(text: string): ExtraArgsParse {
  if (text.length > EXTRA_ARGS_MAX_LENGTH) return { ok: false, error: 'length', detail: String(text.length) }
  const control = controlChar(text)
  if (control) return { ok: false, error: 'control', detail: control }

  const args: string[] = []
  let current = ''
  // Токен начат: отличает пустой аргумент `""` от отсутствия токена.
  let started = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = undefined
      else if (quote === '"' && ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (isSeparator(ch)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quote) return { ok: false, error: 'quote', detail: quote }
  if (started) args.push(current)

  if (args.length > EXTRA_ARGS_MAX_COUNT) return { ok: false, error: 'count', detail: String(args.length) }
  if (args.length > 0 && !/^-./.test(args[0])) return { ok: false, error: 'notFlag', detail: args[0] }
  if (args.includes('--')) return { ok: false, error: 'separator', detail: '--' }
  return { ok: true, args }
}

/** Зарезервированный флаг, найденный во флагах пользователя: как показать (`flag`) и код причины для текста в UI. */
export interface ReservedFlag {
  flag: string
  reason: ReservedFlagReason
}

/**
 * Значение, написанное слитно с флагом: `--model=x` → `x`, `-mx` → `x`, `-c=x` → `x`; флаг без значения — ''.
 * undefined — токен не этот флаг. Короткий флаг узнаётся и в начале связки (`-pc`): оба прочтения — связка
 * булевых флагов или слитное значение — означают, что флаг задан.
 */
function attachedValue(token: string, flag: string): string | undefined {
  if (token === flag) return ''
  if (flag.startsWith('--')) return token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : undefined
  if (token.startsWith('--') || !token.startsWith(flag)) return undefined
  const rest = token.slice(flag.length)
  return rest.startsWith('=') ? rest.slice(1) : rest
}

/**
 * Флаги из `args`, которыми управляет приложение (`AgentSpec.reservedFlags`), — для предупреждения в UI;
 * запуск они не блокируют. По одному на написание флага, в порядке появления. У неизвестного агента и агента
 * без списка — []. Значения чужих флагов не отличаются от флагов (`--name --model` даст предупреждение):
 * для предупреждения лишнее срабатывание дешевле, чем таблица арности всех флагов каждого агента.
 */
export function reservedFlagsIn(agent: string, args: readonly string[]): ReservedFlag[] {
  const rules = getAgent(agent)?.reservedFlags ?? []
  const found: ReservedFlag[] = []
  args.forEach((token, i) => {
    for (const rule of rules) {
      for (const flag of rule.flags) {
        const attached = attachedValue(token, flag)
        if (attached === undefined) continue
        // Codex принимает пробелы вокруг `=` в -c: сравниваем ключ настройки, а не её оформление.
        const value = (attached || args[i + 1] || '').trimStart().replace(/\s*=\s*/, '=')
        if (rule.valuePrefix !== undefined && !value.startsWith(rule.valuePrefix)) continue
        const shown = rule.valuePrefix === undefined ? flag : `${flag} ${rule.valuePrefix}`
        if (!found.some((f) => f.flag === shown)) found.push({ flag: shown, reason: rule.reason })
      }
    }
  })
  return found
}
