// Запуск: pnpm --filter @orca-board/desktop test. macOS-бэкенд обновления с подставными fetch/run и настоящим скриптом подмены.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MacUpdater, type MacUpdaterEnv } from './macUpdater'
import { INSTALL_SCRIPT } from './macUpdateLogic'

const ZIP_BYTES = Buffer.from('fake zip payload'.repeat(100))
const ZIP_SHA = createHash('sha512').update(ZIP_BYTES).digest('base64')
const zipName = `orca-board-0.2.0-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`
const yml = (sha = ZIP_SHA, version = '0.2.0') =>
  `version: ${version}\nfiles:\n  - url: ${zipName}\n    sha512: ${sha}\n    size: ${ZIP_BYTES.length}\n  - url: orca-board-${version}-arm64.dmg\n    sha512: zz==\n    size: 5\n`

let tmp: string
let calls: { file: string; args: string[] }[]
let spawned: { file: string; args: string[] }[]
let plist: Record<string, string>

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-macupd-')))
  calls = []
  spawned = []
  plist = { CFBundleIdentifier: 'dev.orca-board', CFBundleShortVersionString: '0.2.0' }
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

interface Net {
  manifest?: string | number
  notes?: string | number
  zip?: Buffer | number
}

function makeEnv(net: Net, over: Partial<MacUpdaterEnv> = {}): MacUpdaterEnv {
  const reply = (body: string | Buffer | number | undefined): Response =>
    typeof body === 'number' || body === undefined
      ? new Response('', { status: typeof body === 'number' ? body : 404 })
      : new Response(typeof body === 'string' ? body : new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(body)) }
        })
  return {
    version: '0.1.0',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    bundlePath: path.join(tmp, 'Applications', 'orca-board.app'),
    userData: path.join(tmp, 'userData'),
    pid: 4242,
    fetch: async (url) => {
      if (url.endsWith('/latest-mac.yml')) return reply(net.manifest)
      if (url.startsWith('https://api.github.com/')) {
        return typeof net.notes === 'string' ? reply(JSON.stringify({ body: net.notes, html_url: 'https://github.com/x/y/releases/tag/v0.2.0' })) : reply(net.notes)
      }
      if (url.endsWith('.zip')) return reply(net.zip)
      throw new Error(`неожиданный запрос ${url}`)
    },
    // Имитация внешних команд: ditto создаёт .app, plutil отдаёт значения из `plist`, codesign молча проходит.
    run: async (file, args) => {
      calls.push({ file, args })
      if (file === 'ditto') mkdirSync(path.join(args[args.length - 1], 'orca-board.app', 'Contents'), { recursive: true })
      if (file === 'plutil') return `${plist[args[1]] ?? ''}\n`
      return ''
    },
    spawnDetached: async (file, args) => {
      spawned.push({ file, args })
    },
    ...over
  }
}

describe('MacUpdater.check', () => {
  it('новее нет → null', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml(ZIP_SHA, '0.1.0') }))
    assert.equal(await u.check(), null)
  })

  it('есть новая: версия, заметки и ссылка из API', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml(), notes: '## Что нового\n- фича' }))
    assert.deepEqual(await u.check(), {
      version: '0.2.0',
      releaseNotes: '## Что нового\n- фича',
      releaseUrl: 'https://github.com/x/y/releases/tag/v0.2.0'
    })
  })

  it('API заметок недоступен — версия всё равно найдена, ссылка на страницу тега', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml(), notes: 403 }))
    const info = await u.check()
    assert.equal(info?.version, '0.2.0')
    assert.equal(info?.releaseNotes, '')
    assert.equal(info?.releaseUrl, 'https://github.com/NANDIorg/BigOrcaCocks/releases/tag/v0.2.0')
  })

  it('сеть упала — ошибка по-русски, а не необработанный отказ', async () => {
    const u = new MacUpdater(makeEnv({}, { fetch: async () => { throw new TypeError('fetch failed') } }))
    await assert.rejects(u.check(), /не удалось получить список обновлений.*fetch failed/)
    const u404 = new MacUpdater(makeEnv({ manifest: 404 }))
    await assert.rejects(u404.check(), /HTTP 404/)
  })

  it('в релизе нет zip под эту архитектуру — ошибка', async () => {
    const u = new MacUpdater(makeEnv({ manifest: 'version: 0.2.0\nfiles:\n  - url: a.dmg\n    sha512: x\n' }))
    await assert.rejects(u.check(), /нет zip-сборки/)
  })
})

describe('MacUpdater.download', () => {
  it('без check — ошибка', async () => {
    await assert.rejects(new MacUpdater(makeEnv({})).download(() => {}), /сначала нужна проверка/)
  })

  it('качает, проверяет sha512, распаковывает и проверяет подпись; прогресс доходит до 100', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES }))
    await u.check()
    const progress: number[] = []
    await u.download((p) => progress.push(p))
    assert.equal(progress[progress.length - 1], 100)
    assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]))
    const names = calls.map((c) => c.file)
    assert.deepEqual(names.slice(0, 2), ['ditto', 'codesign'])
    assert.deepEqual(calls[0].args.slice(0, 2), ['-x', '-k'])
    assert.deepEqual(calls[1].args.slice(0, 3), ['--verify', '--deep', '--strict'])
    const stage = path.join(tmp, 'userData', 'updates', `0.2.0-${process.arch === 'arm64' ? 'arm64' : 'x64'}`)
    assert.ok(existsSync(path.join(stage, 'unpacked', 'orca-board.app')))
    assert.ok(!existsSync(path.join(stage, 'update.zip')), 'zip удаляется после распаковки')
  })

  it('zip качается по тегу найденной версии, а не по latest: новый релиз между check и download не ломает sha512', async () => {
    const env = makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES })
    const requested: string[] = []
    const inner = env.fetch
    env.fetch = async (url, init) => {
      requested.push(url)
      return inner(url, init)
    }
    const u = new MacUpdater(env)
    await u.check()
    await u.download(() => {})
    const zipUrls = requested.filter((r) => r.endsWith('.zip'))
    assert.deepEqual(zipUrls, [`https://github.com/NANDIorg/BigOrcaCocks/releases/download/v0.2.0/${zipName}`])
    // Манифест — единственное, что берётся с latest; заметки — по тегу той же версии.
    assert.ok(requested.some((r) => r.endsWith('/releases/latest/download/latest-mac.yml')))
    assert.ok(requested.some((r) => r.endsWith('/releases/tags/v0.2.0')))
  })

  it('sha512 не совпал — ошибка, каталог загрузки убран, ditto не вызывался', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml('WRONG=='), notes: '', zip: ZIP_BYTES }))
    await u.check()
    await assert.rejects(u.download(() => {}), /повреждён.*sha512/)
    assert.equal(calls.length, 0)
    assert.deepEqual(readdirSync(path.join(tmp, 'userData', 'updates')), [])
    await assert.rejects(u.install(), /нечего/)
  })

  it('HTTP-ошибка при скачивании — ошибка по-русски', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml(), notes: '', zip: 500 }))
    await u.check()
    await assert.rejects(u.download(() => {}), /не удалось скачать обновление 0\.2\.0.*HTTP 500/)
  })

  it('чужой CFBundleIdentifier или версия — установка запрещена', async () => {
    const u = new MacUpdater(makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES }))
    await u.check()
    // plutil читает и новый, и текущий бандл: чужим делаем только новый — по порядку вызовов.
    const env = makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES })
    let n = 0
    env.run = async (file, args) => {
      if (file === 'ditto') mkdirSync(path.join(args[args.length - 1], 'orca-board.app', 'Contents'), { recursive: true })
      if (file === 'plutil') return n++ === 0 ? 'com.evil.app\n' : 'dev.orca-board\n'
      return ''
    }
    const bad = new MacUpdater(env)
    await bad.check()
    await assert.rejects(bad.download(() => {}), /не прошло проверку.*идентификатор/)

    plist.CFBundleShortVersionString = '0.1.5'
    const oldVer = new MacUpdater(makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES }))
    await oldVer.check()
    await assert.rejects(oldVer.download(() => {}), /не прошло проверку.*версия/)
  })

  it('codesign не прошёл — ошибка и очистка', async () => {
    const env = makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES })
    env.run = async (file, args) => {
      if (file === 'ditto') mkdirSync(path.join(args[args.length - 1], 'orca-board.app'), { recursive: true })
      if (file === 'codesign') throw new Error('codesign: a sealed resource is missing or invalid')
      return ''
    }
    const u = new MacUpdater(env)
    await u.check()
    await assert.rejects(u.download(() => {}), /не прошло проверку.*sealed resource/)
    assert.deepEqual(readdirSync(path.join(tmp, 'userData', 'updates')), [])
  })
})

// Установка передаёт реальные пути файловой системы POSIX-скрипту и намеренно отвергает C:\\….
// Эти интеграционные сценарии выполняются на macOS/Linux; check/download и чистая валидация
// остаются на всех ОС. Нативный Windows-установщик эта группа не проверяет.
describe('MacUpdater.install', { skip: process.platform === 'win32' }, () => {
  async function ready(): Promise<{ u: MacUpdater; env: MacUpdaterEnv }> {
    const env = makeEnv({ manifest: yml(), notes: '', zip: ZIP_BYTES })
    const u = new MacUpdater(env)
    await u.check()
    await u.download(() => {})
    return { u, env }
  }

  it('без download — ошибка', async () => {
    await assert.rejects(new MacUpdater(makeEnv({})).install(), /нечего/)
  })

  it('запускает /bin/sh со скриптом и аргументами массивом; пишет маркер и лог', async () => {
    const { u, env } = await ready()
    await u.install()
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].file, '/bin/sh')
    const [script, pid, target, staged, stage, previous, log] = spawned[0].args
    assert.equal(script, path.join(env.userData, 'updates', 'install.sh'))
    assert.equal(pid, '4242')
    assert.equal(target, env.bundlePath)
    assert.ok(staged.endsWith('unpacked/orca-board.app') && staged.startsWith(stage))
    assert.equal(previous, path.join(env.userData, 'updates', 'previous'))
    assert.equal(log, path.join(env.userData, 'updates', 'install.log'))
    assert.equal(readFileSync(script, 'utf8'), INSTALL_SCRIPT)
    assert.match(readFileSync(log, 'utf8'), /0\.1\.0 → 0\.2\.0/)
  })

  it('повторный install не запускает второй скрипт', async () => {
    const { u } = await ready()
    await u.install()
    await u.install()
    assert.equal(spawned.length, 1)
  })

  it('consumeJustUpdated: после успешного перезапуска отдаёт прежнюю версию один раз и чистит остатки', async () => {
    const { u, env } = await ready()
    await u.install()
    // «Перезапуск»: новый процесс уже версии 0.2.0.
    const after = new MacUpdater({ ...env, version: '0.2.0' })
    assert.equal(after.consumeJustUpdated(), '0.1.0')
    assert.equal(after.consumeJustUpdated(), null)
    assert.ok(!readdirSync(path.join(env.userData, 'updates')).some((n) => /-(arm64|x64)$/.test(n)))
  })

  it('consumeJustUpdated: установка не удалась (версия прежняя) — null, маркер сброшен', async () => {
    const { u, env } = await ready()
    await u.install()
    const still = new MacUpdater(env)
    assert.equal(still.consumeJustUpdated(), null)
    assert.ok(!existsSync(path.join(env.userData, 'updates', 'pending.json')))
  })

  it('не удалось запустить установщик — ошибка по-русски', async () => {
    const { u, env } = await ready()
    env.spawnDetached = async () => {
      throw new Error('spawn EACCES')
    }
    await assert.rejects(u.install(), /не удалось запустить установщик.*EACCES/)
  })
})

// Настоящий скрипт подмены: /bin/sh, ditto из macOS; `open` и (для отката) `ditto` подменяются через PATH.
describe('INSTALL_SCRIPT', { skip: process.platform !== 'darwin' }, () => {
  let bin: string
  let dead: number
  const dirs = () => ({
    target: path.join(tmp, 'Applications', 'orca-board.app'),
    stage: path.join(tmp, 'u', 'stage'),
    staged: path.join(tmp, 'u', 'stage', 'unpacked', 'orca-board.app'),
    previous: path.join(tmp, 'u', 'previous'),
    log: path.join(tmp, 'u', 'install.log'),
    script: path.join(tmp, 'u', 'install.sh')
  })

  beforeEach(() => {
    const d = dirs()
    mkdirSync(path.join(d.target, 'Contents'), { recursive: true })
    writeFileSync(path.join(d.target, 'Contents', 'v.txt'), 'old')
    mkdirSync(path.join(d.staged, 'Contents'), { recursive: true })
    writeFileSync(path.join(d.staged, 'Contents', 'v.txt'), 'new')
    writeFileSync(d.script, INSTALL_SCRIPT)
    bin = path.join(tmp, 'bin')
    mkdirSync(bin)
    // Фейковый open пишет, что его позвали и с чем.
    writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$@" >> "${tmp}/open.log"\n`)
    chmodSync(path.join(bin, 'open'), 0o755)
    // Завершившийся процесс — его PID скрипт ждать не должен.
    dead = Number(execFileSync('/bin/sh', ['-c', 'sh -c "echo $$" & wait']).toString().trim())
  })

  const run = (extraPath = bin) => {
    const d = dirs()
    return spawnSync('/bin/sh', [d.script, String(dead), d.target, d.staged, d.stage, d.previous, d.log], {
      env: { ...process.env, PATH: `${extraPath}:${process.env.PATH}` },
      encoding: 'utf8'
    })
  }

  it('успех: старое — в previous, новое — на месте, stage убран, приложение открыто', () => {
    const d = dirs()
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(path.join(d.target, 'Contents', 'v.txt'), 'utf8'), 'new')
    assert.equal(readFileSync(path.join(d.previous, 'orca-board.app', 'Contents', 'v.txt'), 'utf8'), 'old')
    assert.ok(!existsSync(d.stage))
    assert.equal(readFileSync(path.join(tmp, 'open.log'), 'utf8').trim(), d.target)
    assert.match(readFileSync(d.log, 'utf8'), /установлено/)
  })

  it('ditto упал — старое приложение возвращено на место и открыто, stage сохранён', () => {
    const d = dirs()
    writeFileSync(path.join(bin, 'ditto'), '#!/bin/sh\nmkdir -p "$2"; echo partial > "$2/junk"; exit 1\n')
    chmodSync(path.join(bin, 'ditto'), 0o755)
    const r = run()
    assert.equal(r.status, 1)
    assert.equal(readFileSync(path.join(d.target, 'Contents', 'v.txt'), 'utf8'), 'old')
    assert.ok(!existsSync(path.join(d.target, 'junk')))
    assert.ok(existsSync(d.staged))
    assert.equal(readFileSync(path.join(tmp, 'open.log'), 'utf8').trim(), d.target)
    assert.match(readFileSync(d.log, 'utf8'), /старое приложение восстановлено/)
  })

  it('lock: второй скрипт при живом владельце выходит и ничего не трогает; lock после успеха снят', () => {
    const d = dirs()
    // Живой владелец lock — этот тестовый процесс.
    mkdirSync(`${d.previous}.lock`, { recursive: true })
    writeFileSync(path.join(`${d.previous}.lock`, 'pid'), String(process.pid))
    const busy = run()
    assert.equal(busy.status, 0, busy.stderr)
    assert.equal(readFileSync(path.join(d.target, 'Contents', 'v.txt'), 'utf8'), 'old')
    assert.ok(!existsSync(d.previous))
    assert.match(readFileSync(d.log, 'utf8'), /другая установка уже идёт/)
    // Владелец умер — lock забирается, установка проходит, lock убирается.
    writeFileSync(path.join(`${d.previous}.lock`, 'pid'), String(dead))
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(path.join(d.target, 'Contents', 'v.txt'), 'utf8'), 'new')
    assert.ok(!existsSync(`${d.previous}.lock`))
  })

  it('lock снимается и после неудачи', () => {
    const d = dirs()
    rmSync(d.stage, { recursive: true })
    assert.equal(run().status, 1)
    assert.ok(!existsSync(`${d.previous}.lock`))
  })

  it('нового приложения нет (повторный запуск) — ничего не трогает', () => {
    const d = dirs()
    rmSync(d.stage, { recursive: true })
    const r = run()
    assert.equal(r.status, 1)
    assert.equal(readFileSync(path.join(d.target, 'Contents', 'v.txt'), 'utf8'), 'old')
    assert.ok(!existsSync(d.previous))
  })

  it('пути с пробелами и кавычками не ломают скрипт', () => {
    const d = dirs()
    const odd = path.join(tmp, "Мои 'при ложения")
    mkdirSync(odd)
    const target = path.join(odd, 'orca board.app')
    mkdirSync(path.join(target, 'Contents'), { recursive: true })
    writeFileSync(path.join(target, 'Contents', 'v.txt'), 'old')
    const r = spawnSync('/bin/sh', [d.script, String(dead), target, d.staged, d.stage, d.previous, d.log], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8'
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(path.join(target, 'Contents', 'v.txt'), 'utf8'), 'new')
  })
})
