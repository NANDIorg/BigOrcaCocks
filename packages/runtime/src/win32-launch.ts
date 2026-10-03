// Сборка команды запуска агента на Windows. Без electron и PTY — чтобы проверять node:test на любой платформе
// (worker.ts тянет electron): окружение (собранное приложение, поиск бинарника) передаёт вызывающий.
import { dirname, isAbsolute, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { findBin } from './binary-lookup.ts'

/** Метасимволы cmd.exe, перед которыми ставится ^. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * Аргумент для командной строки `cmd.exe /d /s /c "..."` (схема как в cross-spawn):
 * 1) кавычки по правилам MSVCRT, чтобы запускаемая программа получила аргумент целиком:
 *    `"` → `\"`, обратные слэши перед `"` и в конце строки удваиваются;
 * 2) ^ перед метасимволами cmd (& | < > ^ % ! " и т.п.), чтобы cmd не выполнил их сам.
 * .cmd/.bat-shim (npm: claude.cmd) ещё раз разбирает аргументы через cmd (`%*`) — там ^ удваивается.
 * Перевод строки cmd передать не умеет (обрывает команду) — заменяется пробелом.
 */
export function cmdQuoteArg(arg: string, doubleEscape: boolean): string {
  const msvcrt = `"${arg
    .replace(/\r?\n/g, ' ')
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`
  const once = msvcrt.replace(CMD_META, '^$1')
  return doubleEscape ? once.replace(CMD_META, '^$1') : once
}

/** Имя/путь программы для cmd.exe: только ^ перед метасимволами (включая пробелы в пути). */
function cmdQuoteCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1')
}

/** Командная строка cmd.exe длиннее ~8191 символа обрезается молча — проверяем с запасом. */
export const CMD_LINE_LIMIT = 8000

/** Лимит командной строки CreateProcess (символов UTF-16, вместе с путём программы) — так node-pty запускает argv. */
export const CREATE_PROCESS_LIMIT = 32767

/**
 * Запас до `CREATE_PROCESS_LIMIT`: длиннее `CREATE_PROCESS_LIMIT − запас` строка argv считается не влезающей. Запас
 * покрывает то, что длину считаем моделью квотинга node-pty (`argvCommandLine`), а не настоящим CreateProcess.
 */
export const ARGV_LINE_MARGIN = 2048

/**
 * Флаг system prompt claude (`getAgent('claude').invoke`: пара стоит прямо перед промптом) и его файловый вариант.
 * Другие агенты склеивают system prompt с заданием в один аргумент — вынести его в файл у них нечем.
 */
const SYSTEM_PROMPT_FLAG = '--append-system-prompt'
const SYSTEM_PROMPT_FILE_FLAG = '--append-system-prompt-file'

/**
 * Командная строка, которую node-pty соберёт из argv (`argsToCommandLine` в `node-pty/lib/windowsPtyAgent.js`, правила
 * MSVCRT): аргумент с пробелом или табом — в кавычках, `"` → `\"`, обратные слэши перед кавычкой удваиваются.
 * Копия, а не импорт: модуль остаётся чистым, тест сверяет её с node-pty.
 */
export function argvCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args]
    .map((arg) => {
      const opens = arg[0] === '"'
      const closes = arg[arg.length - 1] === '"'
      const quote = arg === '' || (/[ \t]/.test(arg) && arg.length > 1 && (opens !== closes || (!opens && !closes)))
      let out = ''
      let slashes = 0
      for (const ch of arg) {
        if (ch === '\\') slashes++
        else if (ch === '"') {
          out += '\\'.repeat(slashes * 2 + 1) + '"'
          slashes = 0
        } else {
          out += '\\'.repeat(slashes) + ch
          slashes = 0
        }
      }
      return quote ? `"${out}${'\\'.repeat(slashes * 2)}"` : out + '\\'.repeat(slashes)
    })
    .join(' ')
}

/**
 * Точка входа npm-шима (`claude.cmd`, `codex.cmd`), сгенерированного cmd-shim:
 * `"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*` (старые версии — `%~dp0\`).
 * Возвращает абсолютный путь к скрипту/программе или undefined, если шим не распознан.
 */
function npmShimTarget(shim: string): string | undefined {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  // Цель — последний путь от папки шима; `"%~dp0\node.exe"` старых шимов — это интерпретатор, не цель.
  const rel = [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]+\.(?:js|cjs|mjs|exe))"/gi)]
    .map((m) => m[1])
    .filter((p) => !/(^|\\)node\.exe$/i.test(p))
    .pop()
  if (!rel) return undefined
  const target = join(dirname(shim), rel)
  return existsSync(target) ? target : undefined
}

/** Окружение запуска: то, что зависит от Electron и от машины. */
export interface Win32LaunchEnv {
  /** Собранное приложение: путь к Electron, который запускается как Node (`ELECTRON_RUN_AS_NODE=1`). Нет — dev. */
  electronNode?: string
  /** Поиск бинарника в PATH; по умолчанию — `findBin` (подменяется в тестах). */
  findBin?: (bin: string) => string | undefined
  /**
   * Свежий путь (файла ещё нет) для system prompt claude, если строка не влезает в лимит: `win32Launch` пишет туда
   * текст и передаёт `--append-system-prompt-file`. Удаляет файл вызывающий — после выхода агента (`tempFiles`).
   * Нет — подмены нет, длинная строка даёт ошибку.
   */
  systemPromptFile?: () => string
}

/**
 * Node для JS-точки входа шима: node.exe рядом с шимом (так делает сам шим), в сборке — Node из Electron
 * (ORCA_NODE, с ELECTRON_RUN_AS_NODE=1), иначе node из PATH.
 */
function win32Node(shim: string, env: Win32LaunchEnv): { command: string; env: Record<string, string> } | undefined {
  const local = join(dirname(shim), 'node.exe')
  if (existsSync(local)) return { command: local, env: {} }
  if (env.electronNode) return { command: env.electronNode, env: { ELECTRON_RUN_AS_NODE: '1' } }
  const node = (env.findBin ?? findBin)('node')
  return node ? { command: node, env: {} } : undefined
}

/** Команда для PTY (`PtyCommand`: args строкой — готовая командная строка) и доп. окружение агента. */
export interface Win32Launch {
  command: string
  args: string[] | string
  /** Доп. переменные окружения для агента (ELECTRON_RUN_AS_NODE при запуске через Electron). */
  env: Record<string, string>
  /** Временные файлы запуска (system prompt claude): удалить после выхода агента или неудачного старта. */
  tempFiles?: string[]
}

/** Собранный запуск и его командная строка против лимита своей ветки: argv — CreateProcess с запасом, cmd.exe — свой. */
interface Win32Build {
  launch: Win32Launch
  bin: string
  length: number
  cmd: boolean
}

/**
 * Запуск агента на Windows. Промпт и system prompt длинные и многострочные, поэтому по возможности
 * идут через argv node-pty (CreateProcess, лимит 32767, переводы строк сохраняются), а не через cmd.exe:
 * 1) `<bin>.exe` (или файл без расширения) — напрямую;
 * 2) npm-шим `<bin>.cmd` — node с JS-точкой входа из шима напрямую (или .exe, на который указывает шим);
 * 3) шим не распознан — `cmd.exe /d /s /c "<agent> <args>"` с экранированием; строка длиннее
 *    CMD_LINE_LIMIT — ошибка (cmd молча обрезал бы её), переводы строк при этом теряются.
 * Флаги пользователя (`extraArgs`) — обычные элементы `args`: в ветках 1–2 идут как есть, в ветке 3 экранируются
 * `cmdQuoteArg` и входят в лимит строки наравне с промптом.
 * Строка не влезает (argv — `CREATE_PROCESS_LIMIT − ARGV_LINE_MARGIN`, cmd.exe — `CMD_LINE_LIMIT`): у claude system
 * prompt (~30 тыс. знаков у координатора) уходит в файл `env.systemPromptFile` через `--append-system-prompt-file`;
 * влезает и так — запуск прежний. Не влезает и с файлом или агент не claude — понятная ошибка до CreateProcess.
 */
export function win32Launch(command: string, args: string[], env: Win32LaunchEnv = {}): Win32Launch {
  const first = win32Build(command, args, env)
  if (fits(first)) return first.launch
  const at = args.length - 3
  if (at >= 0 && args[at] === SYSTEM_PROMPT_FLAG && env.systemPromptFile) {
    const file = env.systemPromptFile()
    const next = win32Build(command, [...args.slice(0, at), SYSTEM_PROMPT_FILE_FLAG, file, ...args.slice(at + 2)], env)
    if (fits(next)) {
      writeFileSync(file, args[at + 1], { encoding: 'utf8', flag: 'wx' })
      return { ...next.launch, tempFiles: [file] }
    }
    throw tooLong(command, next)
  }
  throw tooLong(command, first)
}

function fits(b: Win32Build): boolean {
  return b.length <= (b.cmd ? CMD_LINE_LIMIT : CREATE_PROCESS_LIMIT - ARGV_LINE_MARGIN)
}

function tooLong(command: string, b: Win32Build): Error {
  if (b.cmd) {
    return new Error(
      `не удалось запустить ${command} на Windows: ${b.bin} — не стандартный npm-шим, а через cmd.exe ` +
        `командная строка (${b.length} символов) превышает лимит ${CMD_LINE_LIMIT}. ` +
        `Установите агента так, чтобы в PATH был ${command}.exe, или сократите описание задачи/цель и флаги запуска.`
    )
  }
  return new Error(
    `не удалось запустить ${command} на Windows: командная строка (${b.length} символов) не укладывается в лимит ` +
      `${CREATE_PROCESS_LIMIT} с запасом ${ARGV_LINE_MARGIN}. Сократите цель или описание задачи, правила проекта и роли, ` +
      `число приложенных файлов или флаги запуска.`
  )
}

function win32Build(command: string, args: string[], env: Win32LaunchEnv): Win32Build {
  const bin = isAbsolute(command) ? command : ((env.findBin ?? findBin)(command) ?? command)
  const argv = (launch: Win32Launch): Win32Build => ({ launch, bin, length: argvCommandLine(launch.command, launch.args as string[]).length, cmd: false })
  // Расширение проверяется без оглядки на платформу (в отличие от `isCmdScript`): сюда приходят только на Windows.
  if (!/\.(cmd|bat)$/i.test(bin)) return argv({ command: bin, args, env: {} })
  const target = npmShimTarget(bin)
  if (target && /\.exe$/i.test(target)) return argv({ command: target, args, env: {} })
  const node = target ? win32Node(bin, env) : undefined
  if (target && node) return argv({ command: node.command, args: [target, ...args], env: node.env })
  const line = [cmdQuoteCommand(bin), ...args.map((a) => cmdQuoteArg(a, true))].join(' ')
  return { launch: { command: 'cmd.exe', args: `/d /s /c "${line}"`, env: {} }, bin, length: line.length, cmd: true }
}
