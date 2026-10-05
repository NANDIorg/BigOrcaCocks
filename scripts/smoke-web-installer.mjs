import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, unlink, symlink, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// Изменение passwd/home разрешено только в disposable Linux smoke, запускаемом явно.
if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.ORCA_WEB_SMOKE_ROOT !== '1') throw new Error('Fresh-user installer smoke требует явного disposable root runner')
const [directory, artifact, wanted] = process.argv.slice(2)
const releases = resolve(directory); const release = resolve(artifact)
const user = `orcasmoke${randomBytes(4).toString('hex')}`
const peer = `orcaprobe${randomBytes(4).toString('hex')}`
let peerCreated = false
const fixture = await mkdtemp(join(tmpdir(), 'orca-installer-tty-'))
const native = createRequire(join(release, 'app/package.json'))('node-pty')
const password = 'installer-smoke-secret-123'
let terminal
const customBase = process.env.ORCA_WEB_SMOKE_CUSTOM_HOME === '1' ? `/srv/orca-smoke-${user}` : undefined
const provision = process.env.ORCA_WEB_TEST_PROVISION === '1'
const originalUnits = new Map()
let ownsProvisionFixture = false
try {
  if (provision) {
    for (const file of ['/etc/systemd/system/orca-web.service', '/etc/systemd/system/orca-web-update.service', '/etc/systemd/system/orca-web-proxy.service', '/etc/sudoers.d/orca-web-update']) {
      if (existsSync(file)) {
        const content = await readFile(file, 'utf8')
        if (!content.includes('Description=Orca Web') || !content.includes('/tmp/orca-setup-')) throw new Error('Provision smoke не изменяет существующую настоящую установку')
        originalUnits.set(file, { content, mode: (await stat(file)).mode & 0o777 })
      } else originalUnits.set(file, undefined)
    }
    ownsProvisionFixture = true
    for (const file of originalUnits.keys()) await rm(file, { force: true })
    execFileSync('systemctl', ['daemon-reload'])
  }
  const tools = join(fixture, 'tools'); const operatorHome = join(fixture, 'operator')
  await mkdir(tools); await mkdir(operatorHome)
  await writeFile(join(tools, 'curl'), `#!/usr/bin/env node\nimport {copyFileSync} from 'node:fs';\nconst args=process.argv.slice(2); const at=args.indexOf('-o'); const name=args[at-1].split('/').at(-1); if (!['orca-web-linux-x64-${wanted}.tar.gz','SHA256SUMS'].includes(name)) throw new Error('Unexpected download'); copyFileSync(${JSON.stringify(releases)}+'/'+name,args[at+1]);\n`, { mode: 0o755 })
  const env = { ...process.env, HOME: operatorHome, ORCA_WEB_VERSION: wanted, PATH: `${tools}:${process.env.PATH}`, TERM: 'xterm', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'root inherited identity', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'root@example.invalid' }
  for (const key of ['ORCA_WEB_HOME', 'ORCA_WEB_CONFIG', 'ORCA_WEB_NO_SETUP', 'ORCA_WEB_ACK_ROOT']) delete env[key]
  if (customBase) env.ORCA_WEB_HOME = customBase
  const drive = async (prompts, expectedExit = 0) => {
    terminal = native.spawn('/bin/bash', [join(releases, 'install-orca-web.sh')], { name: 'xterm', cols: 110, rows: 35, cwd: fixture, env })
    let output = ''; let cursor = 0; let step = 0
    const exited = new Promise(resolve => terminal.onExit(resolve))
    terminal.onData(data => {
      output += data
      while (step < prompts.length) {
        const at = output.indexOf(prompts[step][0], cursor); if (at < 0) break
        cursor = at + prompts[step][0].length; terminal.write(`${prompts[step++][1]}\r`)
      }
    })
    const timer = setTimeout(() => terminal.kill(), 120_000)
    const result = await exited; clearTimeout(timer); terminal = undefined
    if (expectedExit === null) assert.notEqual(result.exitCode, 0, output.replaceAll(password, '[hidden]'))
    else assert.equal(result.exitCode, expectedExit, output.replaceAll(password, '[hidden]'))
    assert.equal(step, prompts.length, output)
    assert.equal(output.includes(password), false)
    return output
  }
  const automatic = provision ? 'y' : 'n'
  const first = await drive([['Пользователь сервиса', '1'], ['Имя обычного пользователя', user], ['Способ доступа', '1'], ['Папка с Git-проектами', ''], ['Логин первого', 'operator'], ['Имя автора Git', 'Orca Smoke'], ['Email автора Git', 'smoke@example.com'], ['Настроить автозапуск', automatic], ['Применить настройки', 'y'], ['Пароль (от', password], ['Повторите пароль', password], ['Какие CLI установить', '0']])
  const account = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim().split(':')
  const uid = Number(account[2]); const home = account[5]
  const installedBase = customBase ?? join(home, '.local/share/orca-web')
  assert.ok(uid > 0); assert.match(first, /пользователя orcasmoke/)
  const configFile = join(home, '.config/orca-web/config.json'); const accountFile = join(home, '.config/orca-web/accounts.json')
  const config = JSON.parse(await readFile(configFile, 'utf8')); const accounts = await readFile(accountFile, 'utf8')
  assert.equal(config.mode, 'local'); assert.equal(config.origin, 'http://localhost:3737')
  assert.equal((await stat(configFile)).uid, uid); assert.equal((await stat(accountFile)).mode & 0o777, 0o600)
  assert.equal((await stat(join(installedBase, 'current/app/control.mjs'))).uid, uid)
  for (const path of [installedBase, join(installedBase, 'bin'), join(installedBase, 'releases')]) assert.equal((await stat(path)).mode & 0o022, 0, `Installer directory must not be group/world writable: ${path}`)
  assert.equal(existsSync(join(home, '.codex')), false)
  assert.equal(execFileSync('runuser', ['-u', user, '--', 'env', '-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', 'git', 'config', '--global', '--get', 'user.name'], { cwd: home, encoding: 'utf8' }).trim(), 'Orca Smoke')
  // Системные XDG-каталоги могут иметь запись для личной группы пользователя.
  await chmod(join(home, '.local'), 0o775)
  const existingUser = [...(customBase ? [] : [['Пользователь сервиса', '1'], ['Имя обычного пользователя', user]]), ['Для использования введите USE', 'USE']]
  await drive([...existingUser, ['Способ доступа', '1'], ['Папка с Git-проектами', ''], ['Настроить автозапуск', automatic], ...(provision ? [['Для перезапуска введите RESTART', 'RESTART']] : []), ['Применить настройки', 'y'], ['Какие CLI установить', '0']])
  assert.equal(await readFile(accountFile, 'utf8'), accounts)
  // Та же запись становится небезопасной, если в группе появляется другой UID.
  execFileSync('useradd', ['--no-create-home', '--user-group', peer]); peerCreated = true
  execFileSync('usermod', ['--append', '--groups', user, peer])
  const sharedGroup = await drive(existingUser, null)
  assert.match(sharedGroup, /Небезопасные права/)
  assert.equal(await readFile(accountFile, 'utf8'), accounts)
  execFileSync('gpasswd', ['--delete', peer, user], { stdio: 'pipe' })
  execFileSync('usermod', ['--gid', account[3], peer])
  assert.match(await drive(existingUser, null), /Небезопасные права/)
  execFileSync('userdel', [peer], { stdio: 'pipe' })
  execFileSync('groupdel', [peer]); peerCreated = false
  await chmod(join(home, '.local'), 0o777)
  assert.match(await drive(existingUser, null), /Небезопасные права/)
  await chmod(join(home, '.local'), 0o775)
  if (ownsProvisionFixture) {
    const unit = await readFile('/etc/systemd/system/orca-web.service', 'utf8')
    assert.ok(unit.includes(`User=${user}\n`))
    const pid = execFileSync('systemctl', ['show', 'orca-web', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim()
    assert.equal(Number(execFileSync('ps', ['-o', 'uid=', '-p', pid], { encoding: 'utf8' }).trim()), uid, 'Service process must actually run with target UID')
    assert.equal((await stat('/etc/sudoers.d/orca-web-update')).mode & 0o777, 0o440)
    const before = await readFile(configFile, 'utf8')
    const failed = await drive([...existingUser, ['Способ доступа', '2'], ['Папка с Git-проектами', ''], ['Домен Orca', 'orca-installer-test.invalid'], ['Домен предпросмотра', 'preview-installer-test.invalid'], ['Для доступа через интернет', 'OPEN'], ['Email для уведомлений', ''], ['Настроить автозапуск', 'y'], ['Для перезапуска введите RESTART', 'RESTART'], ['Применить настройки', 'y']], null)
    assert.match(failed, /Прежние настройки.*восстановлены/)
    assert.equal(await readFile(configFile, 'utf8'), before)
    assert.equal(await readFile(accountFile, 'utf8'), accounts)
    execFileSync('systemctl', ['is-active', '--quiet', 'orca-web'])
    const health = await (await fetch('http://localhost:3737/health')).json(); assert.equal(health.status, 'ready')
    process.stdout.write('Provision smoke PASS: actual ordinary-user process, restricted sudoers, ready health and DNS failure rollback\n')
    execFileSync('systemctl', ['stop', 'orca-web'])
  }
  // Незавершённая установка существующего пользователя не должна писать root-файлы.
  const protectedFile = join(fixture, 'root-only-file')
  await writeFile(protectedFile, 'root private contents', { mode: 0o600 })
  await unlink(configFile); await unlink(join(installedBase, 'bin/orca-web'))
  await symlink(protectedFile, join(installedBase, 'bin/orca-web'))
  await drive(existingUser, null)
  assert.equal(await readFile(protectedFile, 'utf8'), 'root private contents', 'root installer must not follow user-owned descendants')
  process.stdout.write('Fresh-user installer TTY smoke PASS: automatic Linux user, clean environment, SSH default, hidden password, ownership and safe rerun\n')
} finally {
  terminal?.kill()
  if (peerCreated) {
    try { execFileSync('gpasswd', ['--delete', peer, user], { stdio: 'pipe' }) } catch {}
    try { execFileSync('userdel', [peer], { stdio: 'pipe' }) } catch {}
    try { execFileSync('groupdel', [peer], { stdio: 'pipe' }) } catch {}
  }
  if (ownsProvisionFixture) {
    try { execFileSync('systemctl', ['stop', 'orca-web']) } catch {}
    try { execFileSync('systemctl', ['disable', 'orca-web']) } catch {}
    for (const [file, saved] of originalUnits) {
      if (saved) await writeFile(file, saved.content, { mode: saved.mode })
      else await rm(file, { force: true })
    }
    execFileSync('systemctl', ['daemon-reload'])
  }
  try { execFileSync('userdel', ['--remove', user], { stdio: 'pipe' }) } catch { /* Отказ до useradd не требует cleanup. */ }
  if (customBase) await rm(customBase, { recursive: true, force: true })
  await rm(fixture, { recursive: true, force: true })
}
