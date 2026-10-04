import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Реальная installed поставка не пользуется source TS/workspace symlinks/native root Desktop.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const installed = mkdtempSync(join(tmpdir(), 'orca-installed-artifact-'))
function run(args, cwd) {
  const env = { ...process.env, NODE_OPTIONS: '' }; delete env.DISPLAY
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env, shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Installed artifact check завершился с кодом ${result.status}`)
}
try {
  cpSync(join(root, 'apps/headless/dist'), installed, { recursive: true })
  const npm = join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')
  run([npm, 'install', '--omit=dev', '--no-audit', '--no-fund'], installed)
  run([join(root, 'scripts/smoke-headless-artifact.mjs'), installed], tmpdir())
} finally { rmSync(installed, { recursive: true, force: true }) }
