import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink, chmod } from 'node:fs/promises'
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
  const prompts = [ ['Папка с проектами', join(root, 'projects')], ['Домен Orca', 'orca.example'], ['Отдельный домен', 'preview.example'], ['Логин первого', 'operator'], ['Пароль (от', password], ['Повторите пароль', password] ]
  const env = { ...process.env, ORCA_WEB_HOME: base, ORCA_WEB_CONFIG: configFile, PATH: `${join(release, 'node/bin')}:${process.env.PATH}`, TERM: 'xterm' }
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
  process.stdout.write('Setup TTY smoke PASS: fresh account, masked password, custom config, systemd/Caddy templates\n')
} finally { terminal?.kill(); await rm(root, { recursive: true, force: true }) }
