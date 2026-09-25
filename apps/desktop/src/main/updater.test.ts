// Запуск: pnpm --filter @orca-board/desktop test. Контракт обновления: настройки и заглушка Updater.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectManager } from './projects'
import { createUpdater, initialUpdateState } from './updater'
import { DEFAULT_UPDATE_SETTINGS } from '../shared/ipc'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-updater-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('настройки обновления', () => {
  it('по умолчанию: autoCheck и autoDownload включены, installWhenIdle выключен', () => {
    assert.deepEqual(new ProjectManager(tmp).settings().updates, { autoCheck: true, autoDownload: true, installWhenIdle: false })
    assert.deepEqual(DEFAULT_UPDATE_SETTINGS, { autoCheck: true, autoDownload: true, installWhenIdle: false })
  })

  it('патч мержится по полям и переживает перезапуск', () => {
    const pm = new ProjectManager(tmp)
    pm.setSettings({ updates: { installWhenIdle: true } })
    assert.deepEqual(pm.settings().updates, { autoCheck: true, autoDownload: true, installWhenIdle: true })
    assert.deepEqual(new ProjectManager(tmp).settings().updates, { autoCheck: true, autoDownload: true, installWhenIdle: true })
  })

  it('не-boolean в патче — ошибка, дефолт не портится', () => {
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.setSettings({ updates: { autoCheck: 'да' } as never }), /updates\.autoCheck должен быть boolean/)
    assert.throws(() => pm.setSettings({ updates: null as never }), /updates: ожидается объект/)
    assert.equal(pm.settings().updates.autoCheck, true)
  })

  it('патч других настроек не трогает updates', () => {
    const pm = new ProjectManager(tmp)
    pm.setSettings({ updates: { autoDownload: false } })
    pm.setSettings({ keepInBackground: false })
    assert.equal(pm.settings().updates.autoDownload, false)
  })
})

describe('заглушка Updater', () => {
  it('в dev — unsupported с причиной dev, действия не меняют состояние', async () => {
    const u = createUpdater({ version: '1.2.3', isPackaged: false })
    const s = u.getState()
    assert.equal(s.status, 'unsupported')
    assert.equal(s.unsupportedReason, 'dev')
    assert.equal(s.currentVersion, '1.2.3')
    assert.equal(s.installPending, null)
    assert.deepEqual(await u.check(), s)
    assert.deepEqual(await u.download(), s)
    assert.deepEqual(await u.install({ when: 'now' }), s)
    assert.deepEqual(await u.cancelPending(), s)
  })

  it('в собранном приложении — idle, версии нет', () => {
    const s = createUpdater({ version: '1.2.3', isPackaged: true }).getState()
    assert.equal(s.status, 'idle')
    assert.equal(s.mode, 'auto')
    assert.equal(s.availableVersion, null)
    assert.equal(s.error, null)
  })

  it('portable: manual-download и причина portable', () => {
    const s = initialUpdateState('1.0.0', { mode: 'manual-download', unsupportedReason: 'portable' })
    assert.equal(s.status, 'unsupported')
    assert.equal(s.mode, 'manual-download')
  })

  it('getJustUpdated отдаёт значение один раз; onChanged отписывается', () => {
    const u = createUpdater({ version: '1.0.0', isPackaged: true })
    assert.equal(u.getJustUpdated(), null)
    const seen: string[] = []
    const off = u.onChanged((s) => seen.push(s.status))
    off()
    assert.deepEqual(seen, [])
  })
})
