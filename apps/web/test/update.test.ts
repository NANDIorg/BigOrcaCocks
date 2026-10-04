import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { activateRelease, archiveNamesSafe, recoverRelease, selectWebRelease } from '../src/server/update.ts'
import { acquireProfileOwnership } from '@orca-board/runtime'
import { serviceUnit, caddyConfig } from '../src/server/deployment.ts'
import { parseWebConfig } from '../src/server/config.ts'

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orca-update-')))
  const previous = join(base, 'releases', '1.0.0'); const next = join(base, 'releases', '2.0.0')
  const dataDir = join(base, 'profile'); const configDir = join(base, 'config')
  for (const dir of [previous, next, dataDir, configDir]) await mkdir(dir, { recursive: true })
  await symlink(previous, join(base, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(dataDir, 'projects.json'), '{"version":1}')
  await writeFile(join(configDir, 'config.json'), '{"schemaVersion":1}')
  return { base, previous, next, dataDir, configDir }
}
test('Web feed excludes Desktop/CLI/drafts and selects its highest stable compatible version', () => {
  const release = (tag: string, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, body: 'notes', assets: [{ name: `orca-web-linux-x64-${tag.replace(/^web\/v/, '')}.tar.gz` }], ...extra })
  const releases = [release('v99.0.0'), release('cli/v99.0.0'), release('web/v2.1.1'), release('web/v3.0.0'), release('web/v4.0.0', { prerelease: true }), release('web/v5.0.0', { draft: true })]
  assert.equal(selectWebRelease(releases, '2.0.0')?.version, '3.0.0')
  assert.match(selectWebRelease(releases, '2.0.0')!.releaseUrl, /\/web\/v3.0.0$/)
  assert.equal(selectWebRelease(releases, '3.0.0'), null); assert.equal(selectWebRelease([], '2.0.0'), null)
  assert.throws(() => selectWebRelease([release('web/v3.0.0', { assets: [] })], '2.0.0'))
})
test('update failure restores profile/config and executable, preserving external projects', async t => {
  const value = await fixture(); t.after(() => rm(value.base, { recursive: true, force: true }))
  const project = join(value.base, 'project-file'); await writeFile(project, 'keep')
  const starts: string[] = []; let stopped = 0
  await assert.rejects(activateRelease({ ...value, directory: value.next, version: '2.0.0', stop: async () => { stopped++ },
    start: async () => { starts.push(await realpath(join(value.base, 'current'))) }, healthy: async () => {
      await writeFile(join(value.dataDir, 'projects.json'), '{"version":999}')
      await writeFile(join(value.configDir, 'config.json'), '{"schemaVersion":999}')
      throw new Error('startup failed')
    } }), /предыдущая версия/)
  assert.equal(stopped, 2); assert.deepEqual(starts, [value.next, value.previous])
  assert.equal(await readFile(join(value.dataDir, 'projects.json'), 'utf8'), '{"version":1}')
  assert.equal(await readFile(join(value.configDir, 'config.json'), 'utf8'), '{"schemaVersion":1}')
  assert.equal(await readFile(project, 'utf8'), 'keep')
})
test('update backup has exclusive ownership; another runtime prevents replacement', async t => {
  const value = await fixture(); t.after(() => rm(value.base, { recursive: true, force: true }))
  const owner = await acquireProfileOwnership({ dataDir: value.dataDir })
  try {
    await assert.rejects(activateRelease({ ...value, directory: value.next, version: '2.0.0', stop: async () => {}, start: async () => {}, healthy: async () => {} }))
    assert.equal(await realpath(join(value.base, 'current')), value.previous)
    await assert.rejects(access(join(value.dataDir, 'backups')))
  } finally { await owner.release() }
})
test('successful update retains backup and schema validation remains with the new runtime', async t => {
  const value = await fixture(); t.after(() => rm(value.base, { recursive: true, force: true }))
  const result = await activateRelease({ ...value, directory: value.next, version: '2.0.0', stop: async () => {}, start: async () => {}, healthy: async version => { assert.equal(version, '2.0.0') } })
  assert.equal(await realpath(join(value.base, 'current')), value.next)
  assert.equal(await readFile(join(result.backup, 'profile', 'projects.json'), 'utf8'), '{"version":1}')
})
test('killed install worker is recovered from durable transaction with consistent profile/config', async t => {
  const value = await fixture(); t.after(() => rm(value.base, { recursive: true, force: true }))
  const script = join(value.base, 'worker.mjs'); const marker = join(value.base, 'migrated')
  const moduleUrl = new URL('../src/server/update.ts', import.meta.url).href
  await writeFile(script, `import {activateRelease} from ${JSON.stringify(moduleUrl)}; import {writeFile} from 'node:fs/promises';
    await activateRelease({...${JSON.stringify(value)},directory:${JSON.stringify(value.next)},version:'2.0.0',stop:async()=>{},start:async()=>{},healthy:async()=>{
      await writeFile(${JSON.stringify(join(value.dataDir, 'projects.json'))},'{"version":999}');
      await writeFile(${JSON.stringify(join(value.configDir, 'config.json'))},'{"schemaVersion":999}');
      await writeFile(${JSON.stringify(marker)},'ready'); await new Promise(()=>setInterval(()=>{},1000)); }});`)
  const worker = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] }); t.after(() => worker.kill('SIGKILL'))
  let errors = ''; worker.stderr.on('data', bytes => { errors += String(bytes) })
  const exited = new Promise(resolve => worker.once('exit', resolve))
  let migrated = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await access(marker).then(() => true, () => false)) { migrated = true; break }
    if (worker.exitCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(migrated, true, errors); worker.kill('SIGKILL'); await exited
  assert.equal(await realpath(join(value.base, 'current')), value.next)
  let started = false
  assert.equal(await recoverRelease({ ...value, stop: async () => {}, start: async () => { started = true } }), true)
  assert.equal(started, true); assert.equal(await realpath(join(value.base, 'current')), value.previous)
  assert.equal(await readFile(join(value.dataDir, 'projects.json'), 'utf8'), '{"version":1}')
  assert.equal(await readFile(join(value.configDir, 'config.json'), 'utf8'), '{"schemaVersion":1}')
  assert.equal(await recoverRelease({ ...value, stop: async () => {}, start: async () => {} }), false)
})
test('archive traversal and config injection are refused before system actions', () => {
  assert.equal(archiveNamesSafe(['orca-web/', 'orca-web/app/control.mjs']), true)
  for (const name of ['/etc/passwd', 'orca-web/../outside', 'orca-web/app/../../outside', 'orca-web/app\\outside']) assert.equal(archiveNamesSafe([name]), false)
  assert.throws(() => serviceUnit({ user: 'root\nExecStart=bad', home: '/tmp', launcher: '/tmp/x', path: '/bin' }))
  assert.match(serviceUnit({ user: 'orca', home: '/home/orca', launcher: '/opt/orca/bin/orca-web', path: '/bin', configFile: '/home/orca/custom/config.json' }), /Environment="ORCA_WEB_CONFIG=\/home\/orca\/custom\/config.json"/)
  const config = parseWebConfig({ schemaVersion: 1, configDir: '/tmp/config', dataDir: '/tmp/profile', projectRoots: ['/tmp'], mode: 'proxy', origin: 'https://orca.example', previewOrigin: 'https://preview.example' })
  const caddy = caddyConfig(config); assert.match(caddy, /header_up -Cookie/); assert.match(caddy, /preview.example/)
})
