import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export const repository = dirname(dirname(fileURLToPath(import.meta.url)))
export const nodeNativeRoot = join(repository, '.native', `node-${process.versions.modules}-${process.platform}-${process.arch}`)
const marker = join(nodeNativeRoot, 'verified.json')
export function nodePtyPath(specifier = 'node-pty') { return join(nodeNativeRoot, 'node_modules', specifier) }
export function assertNativeRoots() {
  const node = realpathSync(nodePtyPath()); const desktop = realpathSync(join(repository, 'apps/desktop/node_modules/node-pty'))
  if (node === desktop) throw new Error('Node и Electron node-pty не должны иметь общий install root')
  return { node, desktop }
}
export function ensureNodeNative() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Native test root требует Node24')
  if (existsSync(marker) && existsSync(nodePtyPath())) {
    const info = JSON.parse(readFileSync(marker, 'utf8'))
    if (info.nodeAbi === process.versions.modules && info.pty === '1.1.0') return assertNativeRoots()
  }
  mkdirSync(nodeNativeRoot, { recursive: true })
  writeFileSync(join(nodeNativeRoot, 'package.json'), JSON.stringify({ private: true, name: 'orca-node-test-native', version: '0.0.0', dependencies: { 'node-pty': '1.1.0' } }))
  const taskEnv = { ...process.env }; delete taskEnv.ELECTRON_RUN_AS_NODE; delete taskEnv.npm_config_runtime; delete taskEnv.npm_config_target; delete taskEnv.npm_config_disturl
  const npmCli = join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')
  if (!existsSync(npmCli)) throw new Error('Node24 npm CLI не найден рядом с executable')
  const result = spawnSync(process.execPath, [npmCli, 'install', '--prefix', nodeNativeRoot, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: nodeNativeRoot, env: taskEnv, stdio: 'inherit', shell: false })
  if (result.error) throw result.error; if (result.status !== 0) throw new Error('Не удалось установить отдельный Node native root')
  // macOS prebuild spawn-helper иногда не имеет executable bit; chmod касается только нашего Node root.
  const helper = join(nodePtyPath(), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (process.platform !== 'win32' && existsSync(helper)) chmodSync(helper, 0o755)
  if (process.platform === 'linux') {
    const build = spawnSync(process.execPath, [npmCli, 'rebuild', '--prefix', nodeNativeRoot, '--ignore-scripts=false', '--build-from-source'], { cwd: nodeNativeRoot, env: taskEnv, stdio: 'inherit', shell: false })
    if (build.error) throw build.error; if (build.status !== 0) throw new Error('Не удалось собрать node-pty под Node24')
  }
  writeFileSync(marker, JSON.stringify({ nodeAbi: process.versions.modules, pty: '1.1.0' }))
  return assertNativeRoots()
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(ensureNodeNative()) + '\n')
}
