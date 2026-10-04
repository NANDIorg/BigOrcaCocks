import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ensureNodeNative, nodePtyPath } from './node-native.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))); const installed = mkdtempSync(join(tmpdir(), 'orca-installed-web-'))
try {
  ensureNodeNative()
  cpSync(join(root, 'apps/web/dist'), installed, { recursive: true })
  cpSync(nodePtyPath(), join(installed, 'node_modules/node-pty'), { recursive: true })
  const env = { ...process.env, NODE_OPTIONS: '' }; delete env.DISPLAY
  const result = spawnSync(process.execPath, [join(root, 'scripts/smoke-web-artifact.mjs'), installed], { cwd: tmpdir(), env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error; if (result.status !== 0) throw new Error(`Installed Web smoke завершился с кодом ${result.status}`)
} finally { rmSync(installed, { recursive: true, force: true }) }
