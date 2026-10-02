import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export interface BinaryLookupOptions {
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/** Поиск в окружении хоста; defaults читаются при вызове, чтобы refresh видел новый PATH. */
export function createBinaryLookup(options: BinaryLookupOptions = {}) {
  /** Переданный env — обычный объект; Windows-регистр нельзя поручить process.env. */
  function envValue(name: string): string | undefined {
    const env = options.env ?? process.env
    if ((options.platform ?? process.platform) !== 'win32') return env[name]
    const key = Object.keys(env).find(key => key.toUpperCase() === name)
    return key === undefined ? undefined : env[key]
  }

  /**
   * Папки, где обычно лежат CLI-агенты, но которых может не быть в PATH приложения:
   * Electron, запущенный из Finder, получает урезанный PATH без настроек шелла.
   */
  function extraPathDirs(): string[] {
    const home = options.home ?? homedir()
    const appData = envValue('APPDATA')
    const localAppData = envValue('LOCALAPPDATA')
    const dirs =
      (options.platform ?? process.platform) === 'win32'
        ? [
            // npm i -g кладёт shim-ы claude.cmd и т.п. в %APPDATA%\npm.
            ...(appData ? [join(appData, 'npm')] : []),
            ...(localAppData ? [join(localAppData, 'Programs')] : []),
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
    const current = new Set((envValue('PATH') ?? '').split((options.platform ?? process.platform) === 'win32' ? ';' : delimiter).filter(Boolean))
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
    if ((options.platform ?? process.platform) !== 'win32') return ['']
    const exts = (envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    return [...exts.map((e) => e.toLowerCase()), '']
  }

  /** Бинарник — bat/cmd-скрипт: на Windows его запускает только cmd.exe. */
  function isCmdScript(file: string): boolean {
    return (options.platform ?? process.platform) === 'win32' && /\.(cmd|bat)$/i.test(file)
  }

  /** Полный путь к бинарнику: PATH процесса плюс стандартные папки. */
  function findBin(bin: string): string | undefined {
    const dirs = [...(envValue('PATH') ?? '').split((options.platform ?? process.platform) === 'win32' ? ';' : delimiter).filter(Boolean), ...extraPathDirs()]
    const suffixes = binSuffixes()
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const file = join(dir, bin + suffix)
        if (isExecutable(file)) return file
      }
    }
    return undefined
  }

  return { extraPathDirs, findBin, isCmdScript }
}

const lookup = createBinaryLookup()
export const { extraPathDirs, findBin, isCmdScript } = lookup
