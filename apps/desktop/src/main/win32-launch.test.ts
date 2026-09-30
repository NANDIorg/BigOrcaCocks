// Запуск: pnpm --filter @orca-board/desktop test. Сборка команды запуска агента на Windows (`win32Launch`) с флагами
// пользователя (`extraArgs`). Модуль чистый, поэтому проверяется на любой платформе: на живой Windows запуск не
// проверялся (docs/architecture.md → «Кроссплатформенность»), тест держит саму сборку командной строки.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getAgent, parseExtraArgs } from '@orca-board/core'
import { CMD_LINE_LIMIT, cmdQuoteArg, win32Launch } from './win32-launch'

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
