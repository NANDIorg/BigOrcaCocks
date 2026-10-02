// Запуск: pnpm --filter @orca-board/desktop test. Сборка команды запуска агента на Windows (`win32Launch`) с флагами
// пользователя (`extraArgs`). Модуль чистый, поэтому проверяется на любой платформе: на живой Windows запуск не
// проверялся (docs/architecture.md → «Кроссплатформенность»), тест держит саму сборку командной строки.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getAgent, parseExtraArgs } from '@orca-board/core'
import { ARGV_LINE_MARGIN, CMD_LINE_LIMIT, CREATE_PROCESS_LIMIT, argvCommandLine, cmdQuoteArg, win32Launch } from './win32-launch'

/** Типичные флаги пользователя: путь с пробелом и обратными слэшами, значение с метасимволами cmd, `=`-форма. */
const FLAGS = '--add-dir "C:\\Users\\me\\my repo" --mcp-config=\'C:\\cfg\\mcp.json\' --name "a&b|c" --verbose'
const ARGS = ['--add-dir', 'C:\\Users\\me\\my repo', '--mcp-config=C:\\cfg\\mcp.json', '--name', 'a&b|c', '--verbose']

function userArgs(): string[] {
  const parse = parseExtraArgs(FLAGS)
  assert.ok(parse.ok)
  assert.deepEqual(parse.args, ARGS)
  return parse.args
}

/** argv claude с флагами пользователя — то, что `worker.ts` отдаёт в `win32Launch`. */
function claudeArgs(prompt = 'Сделай задачу'): string[] {
  return getAgent('claude')!.invoke('SYSTEM', prompt, { permissionMode: 'auto', shell: 'cmd.exe', extraArgs: userArgs() }).args
}

let tmp: string
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-win32-launch-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Файл «бинарника» во временной папке; возвращает его путь. */
function bin(name: string, text = ''): string {
  const file = path.join(tmp, name)
  writeFileSync(file, text)
  return file
}

describe('win32Launch: флаги пользователя', () => {
  it('.exe — argv как есть, без cmd.exe: флаги первыми, перед флагами приложения и промптом', () => {
    const exe = bin('claude.exe')
    const args = claudeArgs()
    const launch = win32Launch('claude', args, { findBin: (b) => (b === 'claude' ? exe : undefined) })
    assert.deepEqual(launch, { command: exe, args, env: {} })
    assert.deepEqual(args.slice(0, ARGS.length + 1), [...ARGS, '--permission-mode'])
    assert.equal(args.at(-1), 'Сделай задачу')
  })

  it('npm-шим: node с JS-точкой входа, флаги — обычными элементами argv', () => {
    const cli = bin('cli.js')
    const shim = bin('claude.cmd', '@ECHO off\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n')
    const args = claudeArgs()
    // Собранное приложение: Node — сам Electron.
    assert.deepEqual(win32Launch(shim, args, { electronNode: 'C:\\app\\Orca.exe' }), {
      command: 'C:\\app\\Orca.exe', args: [cli, ...args], env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    // dev: node из PATH.
    assert.deepEqual(win32Launch(shim, args, { findBin: (b) => (b === 'node' ? 'C:\\node\\node.exe' : undefined) }), {
      command: 'C:\\node\\node.exe', args: [cli, ...args], env: {}
    })
    // node.exe рядом с шимом побеждает.
    const local = bin('node.exe')
    assert.equal(win32Launch(shim, args, { electronNode: 'C:\\app\\Orca.exe' }).command, local)
  })

  it('нераспознанный шим — одна строка cmd.exe: каждый флаг в кавычках, метасимволы cmd экранированы дважды', () => {
    const shim = bin('codex.cmd', '@echo off\r\nrem самодельная обёртка\r\n')
    const launch = win32Launch(shim, ['--add-dir', 'C:\\Users\\me\\my repo', '--name', 'a&b|c', '--verbose', 'задание'])
    assert.equal(launch.command, 'cmd.exe')
    assert.equal(typeof launch.args, 'string')
    const line = launch.args as string
    assert.ok(line.startsWith('/d /s /c "') && line.endsWith('"'))
    // Пробел в значении не делит аргумент: он внутри кавычек MSVCRT и экранирован для cmd.
    assert.ok(line.includes(cmdQuoteArg('C:\\Users\\me\\my repo', true)))
    assert.equal(cmdQuoteArg('C:\\Users\\me\\my repo', true), '^^^"C:\\Users\\me\\my^^^ repo^^^"')
    // & и | не выполняются cmd.exe и не теряются во втором разборе `%*`.
    assert.equal(cmdQuoteArg('a&b|c', true), '^^^"a^^^&b^^^|c^^^"')
    assert.doesNotMatch(line, /[^^][&|]/, 'неэкранированных & и | в строке нет')
    // Порядок аргументов сохранён: флаги пользователя перед заданием.
    const order = ['--add-dir', 'my^^^ repo', '--name', 'a^^^&b', '--verbose', 'задание'].map((s) => line.indexOf(s))
    assert.ok(order.every((pos, i) => pos >= 0 && (i === 0 || pos > order[i - 1])), line)
  })

  it('cmdQuoteArg: кавычка в значении, обратный слэш в конце и перевод строки', () => {
    assert.equal(cmdQuoteArg('say "hi"', false), '^"say^ \\^"hi\\^"^"')
    assert.equal(cmdQuoteArg('C:\\dir\\', false), '^"C:\\dir\\\\^"')
    assert.equal(cmdQuoteArg('a\r\nb', false), '^"a^ b^"')
    assert.equal(cmdQuoteArg('', false), '^"^"', 'пустой аргумент "" остаётся аргументом')
  })

  it('через cmd.exe флаги входят в лимит строки: превышение — понятная ошибка, а не обрезанная команда', () => {
    const shim = bin('claude.cmd', '@echo off\r\n')
    const flags = Array.from({ length: 60 }, (_, i) => `--add-dir=C:\\repos\\project-${i}`)
    const prompt = 'x'.repeat(CMD_LINE_LIMIT - 1200)
    // Один промпт в лимит укладывается, вместе с флагами пользователя — уже нет.
    assert.equal(win32Launch(shim, [prompt]).command, 'cmd.exe')
    assert.throws(() => win32Launch(shim, [...flags, prompt]), /превышает лимит 8000.*сократите описание задачи\/цель и флаги запуска/s)
  })

  it('.exe лимита cmd не имеет: длинные флаги и промпт идут в argv', () => {
    const exe = bin('claude.exe')
    const args = [...Array.from({ length: 60 }, (_, i) => `--add-dir=C:\\repos\\project-${i}`), 'x'.repeat(CMD_LINE_LIMIT)]
    assert.deepEqual(win32Launch(exe, args).args, args)
  })

  // Не проверено на живой Windows: разбор ниже — модель правил MSVCRT (`CommandLineToArgvW`) и cmd.exe (`^`),
  // а не запуск настоящего cmd.exe. Она ловит регрессию схемы `cmdQuoteArg`, но не заменяет прогон на Windows.
  it('cmdQuoteArg: типичные значения флагов проходят cmd.exe и разбор аргументов без потерь (модель)', () => {
    /** Один слой экранирования cmd.exe: `^x` → `x`. */
    const unescapeCmd = (line: string): string => line.replace(/\^(.)/g, '$1')
    /** Разбор командной строки по правилам MSVCRT: `\` перед `"` парами, нечётный `\` экранирует кавычку. */
    const argvParse = (line: string): string[] => {
      const out: string[] = []
      let cur = ''
      let started = false
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        let slashes = 0
        while (line[i] === '\\') { slashes++; i++ }
        if (line[i] === '"') {
          cur += '\\'.repeat(Math.floor(slashes / 2))
          if (slashes % 2) cur += '"'
          else inQuotes = !inQuotes
          started = true
        } else {
          cur += '\\'.repeat(slashes)
          if (slashes) started = true
          if (i >= line.length) break
          if (!inQuotes && (line[i] === ' ' || line[i] === '\t')) {
            if (started) out.push(cur)
            cur = ''
            started = false
          } else {
            cur += line[i]
            started = true
          }
        }
      }
      if (started) out.push(cur)
      return out
    }
    const values = [
      '{"model":"x","n":1}', // JSON: --settings '{"a":1}'
      'C:\\Users\\me\\my dir\\', // путь с пробелом и завершающим слэшем
      'a&b|c', 'say "hi"', '100%', '!x!', 'a^b', '(x)<y>', '--name=v w', 'Bash(git:*)', 'tab\there', ''
    ]
    for (const v of values) {
      // Прямой запуск программы через cmd: один слой ^ снимает cmd.
      assert.deepEqual(argvParse(unescapeCmd(cmdQuoteArg(v, false))), [v], JSON.stringify(v))
      // Через .cmd-шим (`%*`): cmd разбирает аргументы второй раз — два слоя.
      assert.deepEqual(argvParse(unescapeCmd(unescapeCmd(cmdQuoteArg(v, true)))), [v], JSON.stringify(v))
    }
  })
})

/** Квотинг node-pty для Windows (`argsToCommandLine`): модуль чистый JS, грузится и на macOS/Linux. */
const { argsToCommandLine } = createRequire(import.meta.url)('node-pty/lib/windowsPtyAgent') as {
  argsToCommandLine: (file: string, args: string[]) => string
}

describe('win32Launch: длинный system prompt claude — в файл', () => {
  const ARGV_LIMIT = CREATE_PROCESS_LIMIT - ARGV_LINE_MARGIN
  /** Свежий путь в tmp, как `launchOnWin32` в worker.ts; счётчик — сколько раз путь просили. */
  function promptFiles(): { calls: () => number; env: () => string } {
    let n = 0
    return { calls: () => n, env: () => path.join(tmp, `sys-${++n}.md`) }
  }
  function shimLaunch(): { cli: string; shim: string } {
    return { cli: bin('cli.js'), shim: bin('claude.cmd', '@ECHO off\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n') }
  }
  const node = { findBin: (b: string) => (b === 'node' ? 'C:\\node\\node.exe' : undefined) }

  it('argvCommandLine совпадает с node-pty argsToCommandLine', () => {
    const args = ['--x', 'with space', 'say "hi"', 'C:\\dir with space\\', 'C:\\a\\b\\', '"quoted arg"', '"lopsided', '', 'tab\there', 'много\nстрок "и" кавычек\\']
    assert.equal(argvCommandLine('C:\\Program Files\\node.exe', args), argsToCommandLine('C:\\Program Files\\node.exe', args))
  })

  it('влезает — запуск прежний: --append-system-prompt с текстом, файла нет', () => {
    const { cli, shim } = shimLaunch()
    const files = promptFiles()
    const args = getAgent('claude')!.invoke('SYSTEM', 'Сделай задачу', { permissionMode: 'auto', shell: 'cmd.exe' }).args
    const launch = win32Launch(shim, args, { ...node, systemPromptFile: files.env })
    assert.deepEqual(launch, { command: 'C:\\node\\node.exe', args: [cli, ...args], env: {} })
    assert.equal(files.calls(), 0)
  })

  it('не влезает с запасом — system prompt в файл, --append-system-prompt-file, промпт и флаги на месте', () => {
    const { cli, shim } = shimLaunch()
    const files = promptFiles()
    const system = 'правило "в кавычках"\n'.repeat(1600)
    const args = getAgent('claude')!.invoke(system, 'Сделай задачу', { permissionMode: 'auto', shell: 'cmd.exe', extraArgs: userArgs() }).args
    assert.ok(argvCommandLine('C:\\node\\node.exe', [cli, ...args]).length > ARGV_LIMIT)
    const launch = win32Launch(shim, args, { ...node, systemPromptFile: files.env })
    const file = path.join(tmp, 'sys-1.md')
    assert.deepEqual(launch.tempFiles, [file])
    assert.equal(readFileSync(file, 'utf8'), system)
    const argv = launch.args as string[]
    assert.deepEqual(argv.slice(-3), ['--append-system-prompt-file', file, 'Сделай задачу'])
    assert.ok(!argv.includes('--append-system-prompt') && !argv.includes(system))
    assert.deepEqual(argv.slice(0, ARGS.length + 1), [cli, ...ARGS])
    assert.ok(argvCommandLine(launch.command, argv).length <= ARGV_LIMIT)
  })

  it('нераспознанный шим (cmd.exe): system prompt тоже уходит в файл, строка — в лимит cmd', () => {
    const shim = bin('claude.cmd', '@echo off\r\n')
    const files = promptFiles()
    const args = getAgent('claude')!.invoke('x'.repeat(CMD_LINE_LIMIT), 'Сделай задачу', { permissionMode: 'auto', shell: 'cmd.exe' }).args
    const launch = win32Launch(shim, args, { systemPromptFile: files.env })
    assert.equal(launch.command, 'cmd.exe')
    assert.ok((launch.args as string).includes('--append-system-prompt-file') && (launch.args as string).length <= CMD_LINE_LIMIT + 20)
    assert.deepEqual(launch.tempFiles, [path.join(tmp, 'sys-1.md')])
  })

  it('не влезает и с файлом, без systemPromptFile или агент не claude — понятная ошибка, файл не пишется', () => {
    const { shim } = shimLaunch()
    const files = promptFiles()
    const huge = 'x'.repeat(CREATE_PROCESS_LIMIT)
    const claude = (system: string, prompt: string) => getAgent('claude')!.invoke(system, prompt, { permissionMode: 'auto', shell: 'cmd.exe' }).args
    const tooLong = /не укладывается в лимит 32767 с запасом 2048\. Сократите цель или описание задачи, правила проекта и роли, число приложенных файлов/
    assert.throws(() => win32Launch(shim, claude('S', huge), { ...node, systemPromptFile: files.env }), tooLong)
    assert.ok(!existsSync(path.join(tmp, 'sys-1.md')), 'файл system prompt не создан, если и с ним не влезает')
    assert.throws(() => win32Launch(shim, claude(huge, 'P'), node), tooLong)
    const exe = bin('codex.exe')
    const codex = getAgent('codex')!.invoke(huge, 'P', { permissionMode: 'auto', shell: 'cmd.exe' }).args
    assert.throws(() => win32Launch(exe, codex, { systemPromptFile: files.env }), tooLong)
    assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('sys-')), [])
  })
})
