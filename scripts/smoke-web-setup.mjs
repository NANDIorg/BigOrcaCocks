import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink, chmod, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Root разрешён только явно в disposable Linux-окружении.
if (process.platform !== 'linux' || process.getuid() === 0 && process.env.ORCA_WEB_SMOKE_ROOT !== '1') throw new Error('Требуется Linux-пользователь; root smoke включается явно')
const release = resolve(process.argv[2]); const root = await mkdtemp(join(tmpdir(), 'orca-setup-'))
const configFile = join(root, 'config', 'config.json'); const base = join(root, 'installed')
const native = createRequire(join(release, 'app/package.json'))('node-pty')
let terminal
try {
  await mkdir(join(base, 'bin'), { recursive: true }); await symlink(release, join(base, 'current'))
  await copyFile(join(release, 'bin/orca-web'), join(base, 'bin/orca-web')); await chmod(join(base, 'bin/orca-web'), 0o755)
  const password = 'wizard-secret-123'
  const gitConfigured = (() => { try { return Boolean(execFileSync('git', ['config', '--global', '--get', 'user.name'], { encoding: 'utf8' }).trim()) && Boolean(execFileSync('git', ['config', '--global', '--get', 'user.email'], { encoding: 'utf8' }).trim()) } catch { return false } })()
  const prompts = [ ...(process.getuid() === 0 ? [['Для продолжения введите ROOT', 'ROOT']] : []), ['Способ доступа', '2'], ['Папка с Git-проектами', join(root, 'projects')], ['Домен Orca', 'orca.example'], ['Домен предпросмотра', 'preview.example'], ['Для доступа через интернет', 'OPEN'], ['Логин первого', 'operator'], ...(!gitConfigured ? [['Имя автора Git', 'Orca'], ['Email автора Git', 'orca@example.com']] : []), ['Email для уведомлений', ''], ['Настроить автозапуск', '2'], ['Применить настройки', '1'], ['Пароль (от', password], ['Повторите пароль', password] ]
  const env = { ...process.env, ORCA_WEB_HOME: base, ORCA_WEB_CONFIG: configFile, ORCA_WEB_ACK_ROOT: '0', PATH: `${join(release, 'node/bin')}:${process.env.PATH}`, TERM: 'xterm' }
  terminal = native.spawn(join(release, 'node/bin/node'), [join(release, 'app/control.mjs'), 'setup'], { name: 'xterm', cols: 100, rows: 30, cwd: root, env })
  let output = ''; let cursor = 0; let step = 0
  const exit = new Promise(resolve => terminal.onExit(resolve))
  terminal.onData(data => {
    output += data
    while (step < prompts.length) {
      const at = output.indexOf(prompts[step][0], cursor); if (at < 0) break
      cursor = at + prompts[step][0].length; terminal.write(`${prompts[step++][1]}\r`)
    }
  })
  const timer = setTimeout(() => terminal.kill(), 15_000)
  const result = await exit; clearTimeout(timer); terminal = undefined
  assert.equal(result.exitCode, 0, output.replaceAll(password, '[hidden]')); assert.equal(step, prompts.length)
  assert.equal(output.includes(password), false, 'Пароль не должен попадать в terminal echo')
  const config = JSON.parse(await readFile(configFile, 'utf8')); assert.equal(config.origin, 'https://orca.example')
  const unit = join(config.configDir, 'orca-web.service')
  assert.ok((await readFile(unit, 'utf8')).includes(`ORCA_WEB_CONFIG=${configFile}`))
  assert.equal((await readFile(join(config.configDir, 'accounts.json'), 'utf8')).includes(password), false)
  if (process.env.ORCA_WEB_VALIDATE_DEPLOYMENT === '1') {
    execFileSync('systemd-analyze', ['verify', '--man=no', unit, join(config.configDir, 'orca-web-proxy.service'), join(config.configDir, 'orca-web-update.service')], { env, stdio: 'pipe', timeout: 15_000 })
    execFileSync('/usr/sbin/visudo', ['-cf', join(config.configDir, 'orca-web-update.sudoers')], { env, stdio: 'pipe', timeout: 15_000 })
    execFileSync('/usr/bin/caddy', ['validate', '--config', join(config.configDir, 'Caddyfile'), '--adapter', 'caddyfile'], { env, stdio: 'pipe', timeout: 15_000 })
  }
  if (process.getuid() === 0 && process.env.ORCA_WEB_TEST_ROOT_SERVICE === '1') {
    // Только disposable root runner: файлы сервиса настоящие, PID1/systemctl заменён.
    const tools = join(root, 'tools'); const log = join(root, 'systemctl.log'); await mkdir(tools)
    await writeFile(join(tools, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORCA_WEB_TEST_SYSTEMCTL"\nif [ "$1" = is-active ]; then exit 1; fi\n', { mode: 0o755 })
    await writeFile(join(tools, 'sudo'), '#!/bin/sh\necho "root must not invoke sudo" >&2\nexit 99\n', { mode: 0o755 })
    execFileSync(join(release, 'node/bin/node'), [join(release, 'app/control.mjs'), 'service', 'install'], { env: { ...env, PATH: `${tools}:${env.PATH}`, ORCA_WEB_TEST_SYSTEMCTL: log }, stdio: 'pipe', timeout: 15_000 })
    assert.equal(await readFile('/etc/systemd/system/orca-web.service', 'utf8'), await readFile(unit, 'utf8'))
    assert.ok((await readFile('/etc/systemd/system/orca-web-update.service', 'utf8')).includes('User=root\n'))
    assert.ok((await readFile(log, 'utf8')).includes('enable --now orca-web.service orca-web-proxy.service'))
    process.stdout.write('Root service smoke PASS: real unit installation, no sudo, systemctl boundary\n')
  }
  const originalAccounts = await readFile(join(config.configDir, 'accounts.json'), 'utf8')
  const again = [ ...(process.getuid() === 0 ? [['Для продолжения введите ROOT', 'ROOT']] : []), ['Способ доступа', '1'], ['Папка с Git-проектами', join(root, 'projects-updated')], ['Настроить автозапуск', '1'], ['Применить настройки', '1'] ]
  terminal = native.spawn(join(release, 'node/bin/node'), [join(release, 'app/control.mjs'), 'configure'], { name: 'xterm', cols: 100, rows: 30, cwd: root, env: { ...env, ORCA_WEB_INSTALLER: '1' } })
  output = ''; cursor = 0; step = 0
  const secondExit = new Promise(resolve => terminal.onExit(resolve))
  terminal.onData(data => {
    output += data
    while (step < again.length) {
      const at = output.indexOf(again[step][0], cursor); if (at < 0) break
      cursor = at + again[step][0].length; terminal.write(`${again[step++][1]}\r`)
    }
  })
  const secondTimer = setTimeout(() => terminal.kill(), 15_000)
  const second = await secondExit; clearTimeout(secondTimer); terminal = undefined
  assert.equal(second.exitCode, 0, output); assert.equal(step, again.length)
  assert.equal(await readFile(join(config.configDir, 'accounts.json'), 'utf8'), originalAccounts)
  const changed = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(changed.mode, 'local'); assert.equal(changed.origin, 'http://localhost:3737')
  assert.deepEqual(changed.projectRoots, [join(root, 'projects-updated')])
  assert.ok((await readdir(config.configDir)).some(file => file.startsWith('config.json.backup-')))
  assert.ok(output.includes('-L 3738:127.0.0.1:3738'))
  if (process.getuid() !== 0) {
    const before = await readFile(configFile, 'utf8'); const tools = join(root, 'refuse-sudo'); await mkdir(tools)
    await writeFile(join(tools, 'sudo'), '#!/bin/sh\necho forbidden-user-owned-code >&2\nexit 99\n', { mode: 0o755 })
    const unsafe = [['Способ доступа', '1'], ['Папка с Git-проектами', join(root, 'must-not-be-applied')], ['Настроить автозапуск', '1'], ['Применить настройки', '1']]
    terminal = native.spawn(join(release, 'node/bin/node'), [join(release, 'app/control.mjs'), 'configure'], { name: 'xterm', cols: 100, rows: 30, cwd: root, env: { ...env, ORCA_WEB_INSTALLER: '0', PATH: `${tools}:${env.PATH}` } })
    output = ''; cursor = 0; step = 0
    const denied = new Promise(resolve => terminal.onExit(resolve))
    terminal.onData(data => {
      output += data
      while (step < unsafe.length) {
        const at = output.indexOf(unsafe[step][0], cursor); if (at < 0) break
        cursor = at + unsafe[step][0].length; terminal.write(`${unsafe[step++][1]}\r`)
      }
    })
    const deniedTimer = setTimeout(() => terminal.kill(), 15_000); const stopped = await denied; clearTimeout(deniedTimer); terminal = undefined
    assert.equal(stopped.exitCode, 1, output)
    assert.equal(await readFile(configFile, 'utf8'), before, 'Standalone configure must refuse privileged user-owned code before config writes')
    assert.equal(output.includes('forbidden-user-owned-code'), false)
  }
  process.stdout.write('Configure TTY smoke PASS: SSH access, new projects folder, accounts preserved, config backup\n')
  process.stdout.write('Setup TTY smoke PASS: fresh account, masked password, custom config, systemd/Caddy templates\n')
} finally { terminal?.kill(); await rm(root, { recursive: true, force: true }) }
