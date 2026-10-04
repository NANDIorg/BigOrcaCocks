import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux' || process.arch !== 'x64' || !process.versions.node.startsWith('24.')) throw new Error('Bundle собирается на Linux x64 с Node 24')
const root = fileURLToPath(new URL('.', import.meta.url)); const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const nodeVersion = process.versions.node; const nodeName = `node-v${nodeVersion}-linux-x64.tar.xz`
const work = await mkdtemp(join(tmpdir(), 'orca-web-bundle-')); const bundle = join(work, 'orca-web'); const out = join(root, 'release')
try {
  await mkdir(bundle); await mkdir(out, { recursive: true })
  const prefix = `https://nodejs.org/dist/v${nodeVersion}/`
  const [archive, checksums] = await Promise.all([fetch(`${prefix}${nodeName}`), fetch(`${prefix}SHASUMS256.txt`)])
  if (!archive.ok || !checksums.ok) throw new Error('Не удалось скачать официальный Node artifact')
  const bytes = Buffer.from(await archive.arrayBuffer()); const expected = (await checksums.text()).split('\n').find(line => line.slice(66) === nodeName)?.slice(0, 64)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('SHA256 Node artifact не совпадает')
  const nodeArchive = join(work, nodeName); await writeFile(nodeArchive, bytes); await mkdir(join(bundle, 'node'))
  execFileSync('tar', ['-xJf', nodeArchive, '--strip-components=1', '-C', join(bundle, 'node')])
  await cp(join(root, 'dist'), join(bundle, 'app'), { recursive: true }); await rm(join(bundle, 'app', 'build-meta.json'), { force: true })
  const env = { ...process.env, PATH: `${join(bundle, 'node', 'bin')}:${process.env.PATH}` }
  execFileSync(join(bundle, 'node', 'bin', 'npm'), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: join(bundle, 'app'), env, stdio: 'inherit' })
  execFileSync(join(bundle, 'node', 'bin', 'npm'), ['rebuild', 'node-pty', '--build-from-source'], { cwd: join(bundle, 'app'), env, stdio: 'inherit' })
  execFileSync(join(bundle, 'node', 'bin', 'node'), ['--input-type=module', '-e', "import('node-pty').then(() => process.stdout.write('native PTY: OK\\n'))"], { cwd: join(bundle, 'app'), env, stdio: 'inherit' })
  await cp(join(root, 'bin'), join(bundle, 'bin'), { recursive: true })
  await writeFile(join(bundle, 'release.json'), JSON.stringify({ schemaVersion: 1, product: 'orca-web', version, platform: 'linux', arch: 'x64', nodeVersion }, null, 2))
  const name = `orca-web-linux-x64-${version}.tar.gz`
  // В поставке только обычные файлы/каталоги: ссылки npm разворачиваются при сборке.
  execFileSync('tar', ['--dereference', '--hard-dereference', '-czf', join(out, name), '-C', work, 'orca-web'])
  await cp(join(root, 'install-orca-web.sh'), join(out, 'install-orca-web.sh'))
  const sums = await Promise.all([name, 'install-orca-web.sh'].map(async file => `${createHash('sha256').update(await readFile(join(out, file))).digest('hex')}  ${file}`))
  await writeFile(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  process.stdout.write(`Web Linux bundle: ${join(out, name)}\n`)
} finally { await rm(work, { recursive: true, force: true }) }
