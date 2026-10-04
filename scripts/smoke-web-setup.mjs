import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, copyFile, symlink, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Только disposable Linux-user: реальный мастер с TTY и шаблоны, без публичного DNS/сертификатов.
if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Требуется обычный Linux-пользователь')
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
  process.stdout.write('Setup TTY smoke PASS: fresh account, masked password, custom config, systemd/Caddy templates\n')
} finally { terminal?.kill(); await rm(root, { recursive: true, force: true }) }
