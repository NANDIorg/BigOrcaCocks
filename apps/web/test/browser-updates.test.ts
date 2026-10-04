import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, access, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBrowserUpdates, runBrowserUpdateWorker, dispatchWhenInactive } from '../src/server/browser-updates.ts'
import { readPrivateJson, replacePrivateJson, createPrivateJson, record } from '../src/server/private-json.ts'
import { updateLockFile } from '../src/server/update.ts'
import { updateWorkerUnit, updateSudoers } from '../src/server/deployment.ts'

const release = { version: '2.1.0', releaseNotes: 'Release notes', releaseUrl: 'https://github.com/NANDIorg/BigOrcaCocks/releases/tag/web/v2.1.0' }
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'orca-browser-update-'))
  await mkdir(join(base, 'releases', '2.0.0'), { recursive: true })
  await symlink(join(base, 'releases', '2.0.0'), join(base, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  return base
}
test('browser updater: pinned download/install, duplicate requests, durable state and separate worker', async t => {
  const base = await fixture(); t.after(() => rm(base, { recursive: true, force: true }))
  let checks = 0; let dispatches = 0
  const api = createBrowserUpdates({ base, version: '2.0.0', managed: true, latest: async () => { checks++; return release }, dispatch: async () => { dispatches++ }, workerActive: async () => true }); t.after(() => api.stop())
  const checked = await Promise.all([api.check(), api.check()]); assert.equal(checks, 1); assert.equal(checked[0].status, 'available')
  await assert.rejects(api.download('2.9.0'))
  const downloading = await Promise.all([api.download(release.version), api.download(release.version)]); assert.equal(dispatches, 1); assert.equal(downloading[0].status, 'downloading')
  await runBrowserUpdateWorker({ base, prepare: async (directory, version, progress) => { assert.equal(directory, base); assert.equal(version, release.version); progress?.(50); return '/fixture/package' } })
  const recovered = createBrowserUpdates({ base, version: '2.0.0', managed: true, latest: async () => release, dispatch: async () => { dispatches++ } }); t.after(() => recovered.stop())
  assert.equal((await recovered.getState()).status, 'ready')
  assert.equal((await recovered.install(release.version)).status, 'installing'); assert.equal(dispatches, 2)
  await runBrowserUpdateWorker({ base, install: async (directory, version, nonInteractive) => { assert.equal(directory, base); assert.equal(version, release.version); assert.equal(nonInteractive, true); return { backup: '/fixture/backup' } } })
  const restarted = createBrowserUpdates({ base, version: release.version, managed: true }); t.after(() => restarted.stop())
  assert.equal((await restarted.getState()).status, 'idle'); assert.equal((await restarted.getState()).currentVersion, release.version)
  await assert.rejects(access(updateLockFile(base)))
})
test('browser updater: failure/interrupt preserve server, unlock owned jobs and allow retry', async t => {
  const base = await fixture(); t.after(() => rm(base, { recursive: true, force: true }))
  const api = createBrowserUpdates({ base, version: '2.0.0', managed: true, latest: async () => release, dispatch: async () => {}, workerActive: async () => false }); t.after(() => api.stop())
  await api.check(); await api.download(release.version)
  await assert.rejects(runBrowserUpdateWorker({ base, prepare: async () => { throw new Error('checksum failed') } }))
  assert.equal((await api.getState()).status, 'error'); assert.equal((await api.getState()).error, 'download'); assert.equal((await api.getState()).currentVersion, '2.0.0')
  await api.check(); await api.download(release.version)
  const file = join(base, 'updates', 'state.json'); const saved = await readPrivateJson(file, 64 * 1024)
  assert.ok(record(saved) && record(saved.job)); saved.job.at = Date.now() - 60_000; await replacePrivateJson(file, saved)
  assert.equal((await api.getState()).error, 'interrupted'); await assert.rejects(access(updateLockFile(base)))
  await api.check(); await createPrivateJson(updateLockFile(base), { kind: 'cli', pid: process.pid, id: 'cli', at: Date.now() })
  await assert.rejects(api.download(release.version)); await access(updateLockFile(base))
})
test('unmanaged Web checks real feed but never dispatches privileged operations', async t => {
  let dispatched = false
  const api = createBrowserUpdates({ version: '2.0.0', managed: false, latest: async () => release, dispatch: async () => { dispatched = true } }); t.after(() => api.stop())
  const state = await api.check(); assert.equal(state.status, 'unsupported'); assert.equal(state.availableVersion, release.version); assert.equal(state.unsupportedReason, 'server-unmanaged')
  await assert.rejects(api.download(release.version)); await assert.rejects(api.install(release.version)); assert.equal(dispatched, false)
})
test('stopping panel aborts feed check; completed worker state wins over stale interrupted snapshot', async t => {
  const base = await fixture(); t.after(() => rm(base, { recursive: true, force: true }))
  const stopping = createBrowserUpdates({ version: '2.0.0', managed: false, latest: async (_current, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  const check = stopping.check(); await new Promise(resolve => setImmediate(resolve)); stopping.stop(); assert.equal((await check).status, 'idle')
  const api = createBrowserUpdates({ base, version: '2.0.0', managed: true, latest: async () => release, dispatch: async () => {}, workerActive: async () => {
    await runBrowserUpdateWorker({ base, prepare: async () => '/fixture/package' }); return false
  } }); t.after(() => api.stop())
  await api.check(); await api.download(release.version)
  const file = join(base, 'updates', 'state.json'); const saved = await readPrivateJson(file, 64 * 1024)
  assert.ok(record(saved) && record(saved.job)); saved.job.at = Date.now() - 60_000; await replacePrivateJson(file, saved)
  assert.equal((await api.getState()).status, 'ready')
})
test('orphan browser claim is recoverable before job publication; CLI claim is retained', async t => {
  const base = await fixture(); t.after(() => rm(base, { recursive: true, force: true }))
  const deadPid = Number(spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).stdout.trim())
  const api = createBrowserUpdates({ base, version: '2.0.0', managed: true, latest: async () => release, dispatch: async () => {}, workerActive: async () => false }); t.after(() => api.stop())
  await api.check(); await createPrivateJson(updateLockFile(base), { kind: 'browser', id: 'orphan', pid: deadPid, at: Date.now(), action: 'download', version: release.version })
  assert.equal((await api.getState()).error, 'interrupted'); await assert.rejects(access(updateLockFile(base)))
  await api.check(); await createPrivateJson(updateLockFile(base), { kind: 'browser', id: 'completed-worker', pid: process.pid, at: Date.now() - 60_000 })
  assert.equal((await api.getState()).error, 'interrupted'); await assert.rejects(access(updateLockFile(base)))
  await api.check(); assert.equal((await api.download(release.version)).status, 'downloading')
})
test('new job starts only after previous oneshot and its recovery finish', async () => {
  let active = true; let starts = 0; let previousRecovery = false
  await dispatchWhenInactive(async () => active, async () => { assert.equal(previousRecovery, true); starts++ }, async () => { previousRecovery = true; active = false })
  assert.equal(starts, 1)
  await assert.rejects(dispatchWhenInactive(async () => true, async () => { starts++ }, async () => {})); assert.equal(starts, 1)
})
test('update service has no dependency on main and sudoers grants only fixed systemctl commands', () => {
  const unit = updateWorkerUnit({ user: 'orca', home: '/home/orca', launcher: '/home/orca/.local/bin/orca-web', path: '/bin', base: '/home/orca/.local/share/orca-web', configFile: '/home/orca/config.json' })
  assert.match(unit, /Type=oneshot/); assert.match(unit, /User=orca\n/); assert.match(unit, / update-worker\n/); assert.match(unit, /ORCA_WEB_MANAGED=1/)
  assert.match(unit, /ExecStopPost=.*\/recovery\/node\/bin\/node.*\/recovery\/app\/control.mjs.*update-recover/)
  assert.doesNotMatch(unit, /Requires=|PartOf=|Restart=|WantedBy=/)
  const sudoers = updateSudoers('orca'); assert.equal(sudoers.split('/usr/bin/systemctl').length, 4); assert.doesNotMatch(sudoers, /\*/)
  assert.throws(() => updateSudoers('orca\nALL=(ALL) ALL'))
})
