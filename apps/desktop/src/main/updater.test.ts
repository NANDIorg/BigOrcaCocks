// Запуск: pnpm --filter @orca-board/desktop test. Настройки обновления и Updater поверх фейкового бэкенда/хоста.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectManager } from './projects'
import { createUpdater, type InstallChoice, type InstallRequest, type PlatformUpdater, type Updater, type UpdaterHost, type UpdaterTimers } from './updater'
import { CHECK_INTERVAL_MS, IDLE_POLL_MS, INITIAL_CHECK_DELAY_MS, initialUpdateState, type UpdateSupport } from './updateMachine'
import { DEFAULT_UPDATE_SETTINGS, type UpdateInfo, type UpdateSettings } from '../shared/ipc'

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

const INFO: UpdateInfo = { version: '1.3.0', releaseNotes: '## Что нового', releaseUrl: 'https://example.test/v1.3.0' }
const AUTO: UpdateSupport = { mode: 'auto', unsupportedReason: null }

/** Бэкенд, который управляется из теста: что вернёт check, упадёт ли download/install. */
function fakeBackend(): PlatformUpdater & { info: UpdateInfo | null; checks: number; downloads: number; installs: number; failCheck?: string; failDownload?: string; failInstall?: string; gate?: Promise<void>; progress: number[] } {
  const b = {
    info: INFO as UpdateInfo | null,
    checks: 0,
    downloads: 0,
    installs: 0,
    progress: [] as number[],
    failCheck: undefined as string | undefined,
    failDownload: undefined as string | undefined,
    failInstall: undefined as string | undefined,
    gate: undefined as Promise<void> | undefined,
    async check() {
      b.checks++
      if (b.failCheck) throw new Error(b.failCheck)
      return b.info
    },
    async download(onProgress: (p: number) => void) {
      b.downloads++
      for (const p of b.progress) onProgress(p)
      if (b.gate) await b.gate
      if (b.failDownload) throw new Error(b.failDownload)
    },
    async install() {
      b.installs++
      if (b.failInstall) throw new Error(b.failInstall)
    }
  }
  return b
}

/** Хост-фейк: журнал вызовов, управляемые настройки/агенты/ответ на диалог и ручные таймеры. */
function fakeHost() {
  const h = {
    settings: { ...DEFAULT_UPDATE_SETTINGS } as UpdateSettings,
    workers: 0,
    choice: 'now' as InstallChoice,
    requests: [] as InstallRequest[],
    calls: [] as string[],
    justUpdated: null as string | null,
    quitThrows: false,
    afters: [] as Array<() => void>,
    everys: new Map<number, Array<() => void>>(),
    timers: undefined as unknown as UpdaterTimers
  }
  h.timers = {
    after: (_ms, fn) => {
      h.afters.push(fn)
      return () => undefined
    },
    every: (ms, fn) => {
      const list = h.everys.get(ms) ?? []
      list.push(fn)
      h.everys.set(ms, list)
      return () => {
        h.everys.set(ms, (h.everys.get(ms) ?? []).filter((f) => f !== fn))
      }
    }
  }
  const host: UpdaterHost = {
    settings: () => h.settings,
    liveWorkerCount: () => h.workers,
    confirmInstall: async (req) => {
      h.requests.push(req)
      return h.choice
    },
    lockQuit: () => void h.calls.push('lock'),
    unlockQuit: () => void h.calls.push('unlock'),
    quit: () => {
      h.calls.push('quit')
      if (h.quitThrows) throw new Error('выход сорвался')
    },
    takeJustUpdated: () => h.justUpdated,
    timers: h.timers
  }
  return { h, host }
}

function make(opts: { support?: UpdateSupport; backend?: PlatformUpdater | null } = {}) {
  const backend = opts.backend === undefined ? fakeBackend() : opts.backend
  const { h, host } = fakeHost()
  const u: Updater = createUpdater({ version: '1.2.3', support: opts.support ?? AUTO, backend, host })
  const seen: string[] = []
  u.onChanged((s) => seen.push(s.status))
  return { u, h, backend: backend as ReturnType<typeof fakeBackend>, seen }
}

describe('Updater: недоступное обновление', () => {
  it('dev: unsupported, все действия — no-op без ошибок и без запросов', async () => {
    const { u, backend } = make({ support: { mode: 'auto', unsupportedReason: 'dev' }, backend: null })
    const s = u.getState()
    assert.equal(s.status, 'unsupported')
    assert.equal(s.unsupportedReason, 'dev')
    assert.equal(s.currentVersion, '1.2.3')
    assert.deepEqual(await u.check(), s)
    assert.deepEqual(await u.download(), s)
    assert.deepEqual(await u.install({ when: 'now' }), s)
    assert.deepEqual(await u.cancelPending(), s)
    u.start()
    assert.equal(backend, null)
  })

  it('portable: статус unsupported, но проверка заполняет версию и ссылку на релиз', async () => {
    const { u, backend, seen } = make({ support: { mode: 'manual-download', unsupportedReason: 'portable' } })
    const s = await u.check()
    assert.equal(backend.checks, 1)
    assert.equal(s.status, 'unsupported')
    assert.equal(s.mode, 'manual-download')
    assert.equal(s.availableVersion, '1.3.0')
    assert.equal(s.releaseUrl, INFO.releaseUrl)
    assert.deepEqual(seen, ['unsupported'])
    assert.equal(backend.downloads, 0, 'portable ничего не качает')
    backend.info = null
    assert.equal((await u.check()).availableVersion, null)
  })

  it('portable: сбой проверки молча ничего не меняет', async () => {
    const { u, backend } = make({ support: { mode: 'manual-download', unsupportedReason: 'portable' } })
    backend.failCheck = 'нет сети'
    const s = await u.check()
    assert.equal(s.status, 'unsupported')
    assert.equal(s.error, null)
  })
})

describe('Updater: проверка и загрузка', () => {
  it('новее нет: checking → idle', async () => {
    const { u, backend, seen } = make()
    backend.info = null
    const s = await u.check()
    assert.equal(s.status, 'idle')
    assert.deepEqual(seen, ['checking', 'idle'])
  })

  it('версия не новее запущенной — как «новее нет» (защита от даунгрейда)', async () => {
    const { u, backend } = make()
    backend.info = { ...INFO, version: '1.2.3' }
    assert.equal((await u.check()).status, 'idle')
  })

  it('autoDownload: найдено → downloading(percent) → ready, по умолчанию установка при выходе', async () => {
    const { u, backend, seen } = make()
    backend.progress = [10, 10.4, 55, 100]
    const percents: Array<number | null> = []
    u.onChanged((s) => s.status === 'downloading' && percents.push(s.percent))
    const s = await u.check()
    assert.deepEqual(seen, ['checking', 'available', 'downloading', 'downloading', 'downloading', 'downloading', 'ready'])
    assert.deepEqual(percents, [0, 10, 55, 100], 'дубли одного процента не рассылаются')
    assert.equal(s.status, 'ready')
    assert.equal(s.availableVersion, '1.3.0')
    assert.equal(s.releaseNotes, '## Что нового')
    assert.equal(s.percent, null)
    assert.equal(s.installPending, 'quit')
    assert.equal(u.readyVersion(), '1.3.0')
  })

  it('autoDownload выключен: available, download() качает по кнопке', async () => {
    const { u, h, backend } = make()
    h.settings.autoDownload = false
    assert.equal((await u.check()).status, 'available')
    assert.equal(backend.downloads, 0)
    assert.equal((await u.download()).status, 'ready')
    assert.equal(backend.downloads, 1)
  })

  it('включили autoDownload при найденной версии — settingsChanged докачивает', async () => {
    const { u, h, backend } = make()
    h.settings.autoDownload = false
    await u.check()
    h.settings.autoDownload = true
    u.settingsChanged()
    await new Promise((r) => setImmediate(r))
    assert.equal(u.getState().status, 'ready')
    assert.equal(backend.downloads, 1)
  })

  it('download() вне available — no-op', async () => {
    const { u, backend } = make()
    assert.equal((await u.download()).status, 'idle')
    assert.equal(backend.downloads, 0)
  })

  it('ручная проверка при сбое → error с контекстом; повторная проверка выходит из error', async () => {
    const { u, backend } = make()
    backend.failCheck = 'ENOTFOUND'
    const s = await u.check()
    assert.equal(s.status, 'error')
    assert.equal(s.error, 'Не удалось проверить обновления: ENOTFOUND')
    backend.failCheck = undefined
    assert.equal((await u.check()).status, 'ready')
    assert.equal(u.getState().error, null)
  })

  it('сбой загрузки → error, версия сохранена; download() повторяет', async () => {
    const { u, h, backend } = make()
    h.settings.autoDownload = false
    await u.check()
    backend.failDownload = 'sha512 не совпал'
    const failed = await u.download()
    assert.equal(failed.status, 'error')
    assert.equal(failed.error, 'Не удалось скачать обновление: sha512 не совпал')
    assert.equal(failed.availableVersion, '1.3.0')
    backend.failDownload = undefined
    assert.equal((await u.download()).status, 'ready')
  })

  it('параллельные check/download не дублируют работу', async () => {
    const { u, h, backend } = make()
    let release!: () => void
    backend.gate = new Promise<void>((r) => (release = r))
    const first = u.check()
    await new Promise((r) => setImmediate(r))
    assert.equal(u.getState().status, 'downloading')
    await u.check()
    await u.download()
    release()
    await first
    assert.equal(backend.checks, 1)
    assert.equal(backend.downloads, 1)
    assert.equal(h.calls.length, 0)
  })
})

describe('Updater: расписание', () => {
  it('start: проверка после задержки и по интервалу; фоновый сбой не рисует error', async () => {
    const { u, h, backend } = make()
    u.start()
    assert.equal(h.afters.length, 1)
    assert.equal(h.everys.get(CHECK_INTERVAL_MS)?.length, 1)
    assert.ok(INITIAL_CHECK_DELAY_MS > 0)
    backend.failCheck = 'нет сети'
    h.afters[0]()
    await new Promise((r) => setImmediate(r))
    assert.equal(backend.checks, 1)
    assert.equal(u.getState().status, 'idle', 'состояние вернулось к прежнему')
    assert.equal(u.getState().error, null)
    backend.failCheck = undefined
    h.everys.get(CHECK_INTERVAL_MS)![0]()
    await new Promise((r) => setImmediate(r))
    assert.equal(u.getState().status, 'ready')
  })

  it('autoCheck выключен — фоновая проверка ничего не делает, ручная работает', async () => {
    const { u, h, backend } = make()
    h.settings.autoCheck = false
    u.start()
    h.afters[0]()
    await new Promise((r) => setImmediate(r))
    assert.equal(backend.checks, 0)
    await u.check()
    assert.equal(backend.checks, 1)
  })

  it('в dev расписание не запускается', () => {
    const { u, h } = make({ support: { mode: 'auto', unsupportedReason: 'dev' }, backend: null })
    u.start()
    assert.equal(h.afters.length, 0)
    assert.equal(h.everys.size, 0)
  })

  it('во время ready фоновая проверка не запускается', async () => {
    const { u, h, backend } = make()
    await u.check()
    u.start()
    h.everys.get(CHECK_INTERVAL_MS)![0]()
    await new Promise((r) => setImmediate(r))
    assert.equal(backend.checks, 1)
  })
})

describe('Updater: установка', () => {
  async function ready() {
    const m = make()
    await m.u.check()
    assert.equal(m.u.getState().status, 'ready')
    return m
  }

  it('install вне ready — ошибка, в installing — no-op', async () => {
    const { u } = make()
    await assert.rejects(u.install({ when: 'now' }), /ещё не готово к установке/)
  })

  it('now без агентов: без диалога, lock → installing → install → quit', async () => {
    const { u, h, backend } = await ready()
    const s = await u.install({ when: 'now' })
    assert.equal(s.status, 'installing')
    assert.equal(h.requests.length, 0)
    assert.equal(backend.installs, 1)
    assert.deepEqual(h.calls, ['lock', 'quit'])
    assert.equal((await u.install({ when: 'now' })).status, 'installing')
    assert.equal(backend.installs, 1)
  })

  it('now с агентами: диалог; «сейчас» — устанавливаем', async () => {
    const { u, h, backend } = await ready()
    h.workers = 2
    h.choice = 'now'
    await u.install({ when: 'now' })
    assert.deepEqual(h.requests, [{ reason: 'user', workers: 2, version: '1.3.0' }])
    assert.equal(backend.installs, 1)
  })

  it('now с агентами: «когда закончат» → installPending idle; «отмена» — ничего', async () => {
    const { u, h, backend } = await ready()
    h.workers = 1
    h.choice = 'cancel'
    let s = await u.install({ when: 'now' })
    assert.equal(s.status, 'ready')
    assert.equal(s.installPending, 'quit', 'отмена диалога не трогает запланированное')
    h.choice = 'idle'
    s = await u.install({ when: 'now' })
    assert.equal(s.installPending, 'idle')
    assert.equal(backend.installs, 0)
  })

  it('quit: только ставит installPending', async () => {
    const { u, h } = await ready()
    await u.cancelPending()
    assert.equal(u.getState().installPending, null)
    const s = await u.install({ when: 'quit' })
    assert.equal(s.installPending, 'quit')
    assert.equal(h.requests.length, 0)
  })

  it('idle с работающими агентами: ждём; опрос ставит, когда они закончились (спрашивает)', async () => {
    const { u, h, backend } = await ready()
    h.workers = 2
    const s = await u.install({ when: 'idle' })
    assert.equal(s.installPending, 'idle')
    const tick = h.everys.get(IDLE_POLL_MS)![0]
    tick()
    await new Promise((r) => setImmediate(r))
    assert.equal(backend.installs, 0)
    assert.equal(h.requests.length, 0)
    h.workers = 0
    h.choice = 'now'
    tick()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(h.requests, [{ reason: 'idle-reached', workers: 0, version: '1.3.0' }])
    assert.equal(backend.installs, 1)
    assert.equal(h.everys.get(IDLE_POLL_MS)!.length, 0, 'опрос остановлен')
  })

  it('idle: «Позже» после вопроса переводит установку на «при выходе»', async () => {
    const { u, h, backend } = await ready()
    h.workers = 1
    await u.install({ when: 'idle' })
    h.workers = 0
    h.choice = 'cancel'
    h.everys.get(IDLE_POLL_MS)![0]()
    await new Promise((r) => setImmediate(r))
    assert.equal(u.getState().installPending, 'quit')
    assert.equal(backend.installs, 0)
    assert.equal(h.everys.get(IDLE_POLL_MS)!.length, 0)
  })

  it('idle без живых агентов = now (без второго вопроса)', async () => {
    const { u, h, backend } = await ready()
    assert.equal((await u.install({ when: 'idle' })).status, 'installing')
    assert.equal(h.requests.length, 0)
    assert.equal(backend.installs, 1)
  })

  it('installWhenIdle: после загрузки ждём агентов и ставим сразу, без вопроса', async () => {
    const { u, h, backend } = make()
    h.settings.installWhenIdle = true
    h.workers = 1
    await u.check()
    assert.equal(u.getState().installPending, 'idle')
    h.workers = 0
    h.everys.get(IDLE_POLL_MS)![0]()
    await new Promise((r) => setImmediate(r))
    assert.equal(h.requests.length, 0)
    assert.equal(backend.installs, 1)
    assert.equal(u.getState().status, 'installing')
  })

  it('installWhenIdle и агентов нет к моменту загрузки — ставим сразу', async () => {
    const { u, h, backend } = make()
    h.settings.installWhenIdle = true
    await u.check()
    assert.equal(backend.installs, 1)
    assert.deepEqual(h.calls, ['lock', 'quit'])
  })

  it('включили installWhenIdle при готовом обновлении с «при выходе» — переходим на ожидание агентов', async () => {
    const { u, h } = await ready()
    h.workers = 1
    h.settings.installWhenIdle = true
    u.settingsChanged()
    assert.equal(u.getState().installPending, 'idle')
  })

  it('сбой установки → error, выход снова спрашивает; при выходе — выходим всё равно', async () => {
    const { u, h, backend } = await ready()
    backend.failInstall = 'файл занят'
    const s = await u.install({ when: 'now' })
    assert.equal(s.status, 'error')
    assert.equal(s.error, 'Не удалось установить обновление: файл занят')
    assert.deepEqual(h.calls, ['lock', 'unlock'])

    const q = await ready()
    q.backend.failInstall = 'файл занят'
    assert.equal(q.u.installOnQuit(), true)
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(q.h.calls, ['lock', 'quit'])
  })

  it('backend.install вызывается один раз: параллельные «установить» и выход не запускают второй установщик', async () => {
    const { u, backend } = await ready()
    await Promise.all([u.install({ when: 'now' }), u.install({ when: 'now' })])
    assert.equal(u.installOnQuit(), false)
    await new Promise((r) => setImmediate(r))
    assert.equal(backend.installs, 1)
  })

  it('выход сорвался после install: повторная установка (после новой загрузки) не зовёт backend.install снова', async () => {
    const { u, h, backend } = await ready()
    h.quitThrows = true
    const s = await u.install({ when: 'now' })
    assert.equal(s.status, 'error')
    assert.equal(backend.installs, 1)
    // Обновление снова готово (человек нажал «Скачать») — установщик первого запуска уже ждёт выхода.
    await u.download()
    assert.equal(u.getState().status, 'ready')
    h.quitThrows = false
    h.calls.length = 0
    await u.install({ when: 'now' })
    assert.equal(backend.installs, 1, 'второй установщик не запущен')
    assert.deepEqual(h.calls, ['lock', 'quit'], 'но выход состоялся')
  })

  it('installOnQuit: ставит при ready и не снятом installPending, иначе false', async () => {
    const { u, h, backend } = make()
    assert.equal(u.installOnQuit(), false, 'нечего ставить')
    await u.check()
    await u.cancelPending()
    assert.equal(u.installOnQuit(), false, 'установка снята человеком')
    await u.install({ when: 'quit' })
    assert.equal(u.installOnQuit(), true)
    await new Promise((r) => setImmediate(r))
    assert.equal(backend.installs, 1)
    assert.deepEqual(h.calls, ['lock', 'quit'])
    assert.equal(u.installOnQuit(), false, 'уже installing')
  })
})

describe('Updater: прочее', () => {
  it('getJustUpdated берёт значение у хоста один раз', () => {
    const { u, h } = make()
    h.justUpdated = '1.2.3'
    assert.equal(u.getJustUpdated(), '1.2.3')
    assert.equal(u.getJustUpdated(), null)
  })

  it('getJustUpdated: маркер бэкенда вызывается всегда (чистка), но приоритет у хоста', () => {
    let consumed = 0
    const backend = Object.assign(fakeBackend(), { consumeJustUpdated: () => (consumed++, '1.0.0') })
    const a = make({ backend })
    assert.equal(a.u.getJustUpdated(), '1.0.0', 'хост молчит — берём у бэкенда')
    assert.equal(a.u.getJustUpdated(), null)
    assert.equal(consumed, 1)
    const b = make({ backend })
    b.h.justUpdated = '0.9.0'
    assert.equal(b.u.getJustUpdated(), '0.9.0')
    assert.equal(consumed, 2, 'маркер всё равно убран')
  })

  it('onChanged отписывается; dispose гасит таймеры', () => {
    const { u, h } = make()
    const seen: string[] = []
    const off = u.onChanged((s) => seen.push(s.status))
    off()
    u.start()
    u.dispose()
    assert.deepEqual(seen, [])
    assert.equal(h.everys.get(CHECK_INTERVAL_MS)!.length, 0)
  })

  it('initialUpdateState: portable — unsupported/manual-download', () => {
    const s = initialUpdateState('1.0.0', { mode: 'manual-download', unsupportedReason: 'portable' })
    assert.equal(s.status, 'unsupported')
    assert.equal(s.mode, 'manual-download')
  })
})
