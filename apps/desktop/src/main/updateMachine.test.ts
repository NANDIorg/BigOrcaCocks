// Запуск: pnpm --filter @orca-board/desktop test. Чистые переходы и решения машины состояний обновления.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canCheck,
  canDownload,
  checkFailed,
  checkFinished,
  checkStarted,
  compareVersions,
  downloadDone,
  downloadFailed,
  downloadProgress,
  downloadStarted,
  errorText,
  idleAction,
  initialUpdateState,
  installFailed,
  installStarted,
  installsOnQuit,
  isNewer,
  manualInfo,
  pendingAfterReady,
  shouldAutoDownload,
  withPending
} from './updateMachine'
import { DEFAULT_UPDATE_SETTINGS, type UpdateInfo, type UpdateState } from '../shared/ipc'

const INFO: UpdateInfo = { version: '1.3.0', releaseNotes: 'notes', releaseUrl: 'https://example.test' }
const idle = (): UpdateState => initialUpdateState('1.2.3', { mode: 'auto', unsupportedReason: null })
const ready = (pending: 'idle' | 'quit' = 'quit'): UpdateState => downloadDone(downloadStarted(checkFinished(idle(), INFO)), pending)

describe('compareVersions / isNewer', () => {
  it('числовое сравнение по компонентам, а не строковое', () => {
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
    assert.equal(compareVersions('1.2', '1.2.0'), 0)
  })
  it('префикс v и суффикс -beta / +сборка отбрасываются', () => {
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3+45', '1.2.2'), 1)
  })
  it('isNewer: только строго новее', () => {
    assert.equal(isNewer('0.0.7', '0.0.6'), true)
    assert.equal(isNewer('0.0.6', '0.0.6'), false)
    assert.equal(isNewer('0.0.5', '0.0.6'), false)
  })
})

describe('переходы', () => {
  it('idle → checking → available (с заметками и ссылкой) → downloading → ready', () => {
    const c = checkStarted(idle())
    assert.equal(c.status, 'checking')
    const a = checkFinished(c, INFO)
    assert.deepEqual([a.status, a.availableVersion, a.releaseNotes, a.releaseUrl], ['available', '1.3.0', 'notes', 'https://example.test'])
    const d = downloadStarted(a)
    assert.deepEqual([d.status, d.percent], ['downloading', 0])
    const r = downloadDone(d, 'quit')
    assert.deepEqual([r.status, r.percent, r.installPending, r.availableVersion], ['ready', null, 'quit', '1.3.0'])
  })

  it('проверка без находки очищает найденную версию', () => {
    const s = checkFinished(checkStarted(checkFinished(idle(), INFO)), null)
    assert.deepEqual([s.status, s.availableVersion, s.releaseNotes, s.releaseUrl], ['idle', null, null, null])
  })

  it('прогресс: округление, границы, тот же объект при том же проценте, вне downloading — игнор', () => {
    const d = downloadStarted(checkFinished(idle(), INFO))
    const p = downloadProgress(d, 41.6)
    assert.equal(p.percent, 42)
    assert.equal(downloadProgress(p, 42.2), p)
    assert.equal(downloadProgress(p, 250).percent, 100)
    assert.equal(downloadProgress(p, -5).percent, 0)
    const a = checkFinished(idle(), INFO)
    assert.equal(downloadProgress(a, 50), a)
  })

  it('ошибки: error с текстом, версия сохраняется, percent и pending сброшены', () => {
    const f = downloadFailed(downloadStarted(checkFinished(idle(), INFO)), 'boom')
    assert.deepEqual([f.status, f.error, f.availableVersion, f.percent, f.installPending], ['error', 'boom', '1.3.0', null, null])
    assert.equal(checkFailed(idle(), 'x').status, 'error')
    const i = installFailed(installStarted(ready()), 'y')
    assert.deepEqual([i.status, i.error, i.installPending], ['error', 'y', null])
    assert.equal(installStarted(ready()).installPending, null)
  })

  it('следующая проверка после ошибки снимает error', () => {
    assert.equal(checkStarted(checkFailed(idle(), 'x')).error, null)
  })

  it('withPending меняет только ready и не плодит объекты', () => {
    const r = ready()
    assert.equal(withPending(r, 'quit'), r)
    assert.equal(withPending(r, 'idle').installPending, 'idle')
    assert.equal(withPending(r, null).installPending, null)
    const a = checkFinished(idle(), INFO)
    assert.equal(withPending(a, 'idle'), a)
  })

  it('manualInfo (portable): статус не меняется, версия заполняется и очищается', () => {
    const u = initialUpdateState('1.2.3', { mode: 'manual-download', unsupportedReason: 'portable' })
    const s = manualInfo(u, INFO)
    assert.deepEqual([s.status, s.availableVersion, s.releaseUrl, s.unsupportedReason], ['unsupported', '1.3.0', 'https://example.test', 'portable'])
    assert.equal(manualInfo(s, null).availableVersion, null)
  })
})

describe('решения', () => {
  it('canCheck / canDownload по статусам', () => {
    assert.equal(canCheck(idle()), true)
    assert.equal(canCheck(checkStarted(idle())), false)
    assert.equal(canCheck(ready()), false)
    assert.equal(canCheck(initialUpdateState('1', { mode: 'auto', unsupportedReason: 'dev' })), false)
    assert.equal(canDownload(checkFinished(idle(), INFO)), true)
    assert.equal(canDownload(idle()), false)
    assert.equal(canDownload(downloadFailed(downloadStarted(checkFinished(idle(), INFO)), 'x')), true, 'повтор после сбоя загрузки')
    assert.equal(canDownload(checkFailed(idle(), 'x')), false, 'сбой проверки: версии нет, качать нечего')
  })

  it('pendingAfterReady: по умолчанию при выходе, с installWhenIdle — по освобождению агентов', () => {
    assert.equal(pendingAfterReady(DEFAULT_UPDATE_SETTINGS), 'quit')
    assert.equal(pendingAfterReady({ ...DEFAULT_UPDATE_SETTINGS, installWhenIdle: true }), 'idle')
  })

  it('shouldAutoDownload: только available и включённая настройка', () => {
    const a = checkFinished(idle(), INFO)
    assert.equal(shouldAutoDownload(a, DEFAULT_UPDATE_SETTINGS), true)
    assert.equal(shouldAutoDownload(a, { ...DEFAULT_UPDATE_SETTINGS, autoDownload: false }), false)
    assert.equal(shouldAutoDownload(idle(), DEFAULT_UPDATE_SETTINGS), false)
  })

  it('installsOnQuit: ready и установка не снята', () => {
    assert.equal(installsOnQuit(ready('quit')), true)
    assert.equal(installsOnQuit(ready('idle')), true)
    assert.equal(installsOnQuit(withPending(ready(), null)), false)
    assert.equal(installsOnQuit(checkFinished(idle(), INFO)), false)
  })

  it('idleAction: ждём при работающих агентах, потом ставим или спрашиваем', () => {
    const s = DEFAULT_UPDATE_SETTINGS
    assert.equal(idleAction(ready('idle'), s, 2), 'wait')
    assert.equal(idleAction(ready('idle'), s, 0), 'ask')
    assert.equal(idleAction(ready('idle'), { ...s, installWhenIdle: true }, 0), 'install')
    assert.equal(idleAction(ready('quit'), s, 0), 'wait', 'ждём только при installPending = idle')
    assert.equal(idleAction(checkFinished(idle(), INFO), s, 0), 'wait')
  })

  it('errorText: контекст + причина', () => {
    assert.equal(errorText('Не удалось', new Error('нет сети')), 'Не удалось: нет сети')
    assert.equal(errorText('Не удалось', 'строка'), 'Не удалось: строка')
  })
})
