import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0) throw new Error('Bundle smoke выполняется обычным пользователем Linux x64')
const releases = resolve(process.argv[2]); const file = readdirSync(releases).find(name => /^orca-web-linux-x64-\d+\.\d+\.\d+\.tar\.gz$/.test(name))
if (!file) throw new Error('Нет Linux Web bundle')
const version = /^orca-web-linux-x64-(.*)\.tar\.gz$/.exec(file)[1]
const root = dirname(dirname(fileURLToPath(import.meta.url))); const fixture = mkdtempSync(join(tmpdir(), 'orca-web-install-'))
const prefix = join(fixture, 'installed'); const curl = join(fixture, 'tools'); const link = join(homedir(), '.local/bin/orca-web'); const existed = existsSync(link)
try {
  mkdirSync(curl)
  // Только download заменён fixture: установка, checksum, extraction и packaged launcher настоящие.
  writeFileSync(join(curl, 'curl'), `#!/usr/bin/env node\nimport {copyFileSync} from 'node:fs';\nconst args=process.argv.slice(2); const at=args.indexOf('-o'); const name=args[at-1].split('/').at(-1); if (!['${file}','SHA256SUMS'].includes(name)) throw new Error('Unexpected download'); copyFileSync(${JSON.stringify(releases)}+'/'+name,args[at+1]);\n`, { mode: 0o755 })
  const env = { ...process.env, ORCA_WEB_HOME: prefix, ORCA_WEB_VERSION: version, ORCA_WEB_NO_SETUP: '1', PATH: `${curl}:${process.env.PATH}`, NODE_OPTIONS: '' }; delete env.DISPLAY
  execFileSync('bash', [join(releases, 'install-orca-web.sh')], { env, stdio: 'inherit' })
  execFileSync(join(prefix, 'bin/orca-web'), ['help'], { env, stdio: 'inherit' })
  const bundledNode = join(prefix, 'current/node/bin/node')
  execFileSync(bundledNode, [join(root, 'scripts/smoke-web-setup.mjs'), join(prefix, 'current')], { cwd: fixture, env, stdio: 'inherit', timeout: 30_000 })
  execFileSync(bundledNode, [join(root, 'scripts/smoke-web-artifact.mjs'), join(prefix, 'current/app')], { cwd: fixture, env, stdio: 'inherit', timeout: 120_000 })
  process.stdout.write('Linux bundle/install smoke PASS: checksum, installer, bundled Node/native/resources, two-user Web and restart\n')
} finally {
  if (!existed) { try { if (readlinkSync(link) === join(prefix, 'bin/orca-web')) rmSync(link) } catch {} }
  rmSync(fixture, { recursive: true, force: true })
}
