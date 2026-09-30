// Сборка команды запуска агента на Windows. Без electron и PTY — чтобы проверять node:test на любой платформе
// (worker.ts тянет electron): окружение (собранное приложение, поиск бинарника) передаёт вызывающий.
import { dirname, isAbsolute, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { findBin } from './agents'

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
 */
export function win32Launch(command: string, args: string[], env: Win32LaunchEnv = {}): Win32Launch {
  const bin = isAbsolute(command) ? command : ((env.findBin ?? findBin)(command) ?? command)
  // Расширение проверяется без оглядки на платформу (в отличие от `isCmdScript`): сюда приходят только на Windows.
  if (!/\.(cmd|bat)$/i.test(bin)) return { command: bin, args, env: {} }
  const target = npmShimTarget(bin)
  if (target && /\.exe$/i.test(target)) return { command: target, args, env: {} }
  const node = target ? win32Node(bin, env) : undefined
  if (target && node) return { command: node.command, args: [target, ...args], env: node.env }
  const line = [cmdQuoteCommand(bin), ...args.map((a) => cmdQuoteArg(a, true))].join(' ')
  if (line.length > CMD_LINE_LIMIT) {
    throw new Error(
      `не удалось запустить ${command} на Windows: ${bin} — не стандартный npm-шим, а через cmd.exe ` +
        `командная строка (${line.length} символов) превышает лимит ${CMD_LINE_LIMIT}. ` +
        `Установите агента так, чтобы в PATH был ${command}.exe, или сократите описание задачи/цель и флаги запуска.`
    )
  }
  return { command: 'cmd.exe', args: `/d /s /c "${line}"`, env: {} }
}
