// Запуск: pnpm --filter @orca-board/desktop test. Мастер первого запуска в ProjectManager: флаг `onboarding` в
// projects.json (явный `pending`, миграция файла до мастера, битый файл), `completeOnboarding` (идемпотентность,
// проверка ввода) и то, что поле переживает `setSettings` и `markRun`.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_COLUMNS } from '@orca-board/core'
import { ProjectManager } from './projects'
import { OrcaError } from './i18n'
import { PROJECTS_FILE_VERSION } from './task-types-migration'
import { ONBOARDING_VERSION } from '../shared/ipc'

let tmp: string
const file = (): string => path.join(tmp, 'projects.json')

function saved(): Record<string, unknown> {
  return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
}

/** projects.json нового формата без ключа `onboarding` — как у версии до мастера. */
function writeLegacy(extra: Record<string, unknown> = {}, withProject = false): void {
  writeFileSync(file(), JSON.stringify({
    version: PROJECTS_FILE_VERSION,
    projects: withProject ? [{ id: 'p1', root: path.join(tmp, 'repo'), name: 'repo', columns: DEFAULT_COLUMNS }] : [],
    activeId: withProject ? 'p1' : null,
    ...extra
  }))
}

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-onboarding-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('первый запуск', () => {
  it('нет файла → pending, required', () => {
    const state = new ProjectManager(tmp).onboardingState()
    assert.deepEqual(state, { required: true, status: 'pending', version: ONBOARDING_VERSION })
  })

  it('закрыли посреди мастера → снова открыли → всё ещё pending, даже когда markRun уже создал файл', () => {
    const first = new ProjectManager(tmp)
    first.markRun('1.0.0')
    assert.equal((saved().onboarding as { status: string }).status, 'pending', 'pending записан явно')
    assert.equal(new ProjectManager(tmp).onboardingState().required, true)
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'pending')
  })

  it('setSettings при первом запуске создаёт файл, но мастер остаётся pending', () => {
    new ProjectManager(tmp).setSettings({ language: 'en' })
    const again = new ProjectManager(tmp)
    assert.equal(again.onboardingState().status, 'pending')
    assert.equal(again.settings().language, 'en')
  })
})

describe('миграция файла без ключа onboarding', () => {
  it('есть проекты → completed, reason existing, записано в файл', () => {
    writeLegacy({}, true)
    const pm = new ProjectManager(tmp)
    const state = pm.onboardingState()
    assert.equal(state.required, false)
    assert.equal(state.status, 'completed')
    assert.equal(typeof state.at, 'number')
    const stored = saved().onboarding as { status: string; reason?: string }
    assert.equal(stored.status, 'completed')
    assert.equal(stored.reason, 'existing')
  })

  it('заданы settings → completed, existing', () => {
    writeLegacy({ settings: { language: 'ru' } })
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'completed')
    assert.equal((saved().onboarding as { reason?: string }).reason, 'existing')
  })

  it('ни проектов, ни настроек (только lastRunVersion) → pending', () => {
    writeLegacy({ lastRunVersion: '1.0.0' })
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'pending')
    assert.equal(new ProjectManager(tmp).onboardingState().required, true, 'решение записано и не пересчитывается')
  })

  it('пустой объект settings не считается заданными настройками', () => {
    writeLegacy({ settings: {} })
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'pending')
  })

  it('невалидное поле onboarding → как «нет ключа»', () => {
    for (const bad of ['done', 42, null, [], { status: 'weird', version: 1 }]) {
      rmSync(file(), { force: true })
      writeLegacy({ onboarding: bad }, true)
      assert.equal(new ProjectManager(tmp).onboardingState().status, 'completed', JSON.stringify(bad))
      assert.equal((saved().onboarding as { reason?: string }).reason, 'existing')
    }
    writeLegacy({ onboarding: { status: 'weird' } })
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'pending')
  })

  it('валидное поле не трогается', () => {
    writeLegacy({ onboarding: { status: 'skipped', version: 1, at: 123 } }, true)
    assert.deepEqual(new ProjectManager(tmp).onboardingState(), { required: false, status: 'skipped', version: 1, at: 123 })
  })

  it('версия из файла сохраняется как есть, без логики «показать новый шаг»', () => {
    writeLegacy({ onboarding: { status: 'completed', version: 0, at: 5 } })
    assert.deepEqual(new ProjectManager(tmp).onboardingState(), { required: false, status: 'completed', version: 0, at: 5 })
  })

  it('старый формат (до типов задач) с проектами → completed', () => {
    writeFileSync(file(), JSON.stringify({ projects: [{ id: 'p1', root: path.join(tmp, 'repo'), name: 'repo', columns: DEFAULT_COLUMNS }], activeId: 'p1' }))
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'completed')
    assert.equal((saved().onboarding as { reason?: string }).reason, 'existing')
  })
})

describe('битый файл', () => {
  it('невалидный JSON → completed, existing; после рестарта не превращается в pending', () => {
    writeFileSync(file(), '{ не json')
    const pm = new ProjectManager(tmp)
    assert.equal(pm.stateWarnings().length, 1)
    assert.equal(pm.onboardingState().status, 'completed')
    assert.equal((saved().onboarding as { reason?: string }).reason, 'existing')
    assert.ok(readdirSync(tmp).some((f) => f.includes('.corrupt-')), 'битый файл отложен')
    const again = new ProjectManager(tmp)
    assert.equal(again.onboardingState().status, 'completed')
    assert.equal(again.onboardingState().required, false)
  })

  it('JSON не объект → completed, existing', () => {
    writeFileSync(file(), '[1, 2]')
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'completed')
  })
})

describe('completeOnboarding', () => {
  it('pending → completed с временем, записывается в файл', () => {
    const pm = new ProjectManager(tmp)
    const state = pm.completeOnboarding()
    assert.equal(state.required, false)
    assert.equal(state.status, 'completed')
    assert.equal(state.version, ONBOARDING_VERSION)
    assert.equal(typeof state.at, 'number')
    assert.equal((saved().onboarding as { status: string }).status, 'completed')
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'completed')
  })

  it('{ skipped: true } → skipped, { skipped: false } → completed', () => {
    assert.equal(new ProjectManager(tmp).completeOnboarding({ skipped: true }).status, 'skipped')
    rmSync(file())
    assert.equal(new ProjectManager(tmp).completeOnboarding({ skipped: false }).status, 'completed')
  })

  it('идемпотентно: повтор не понижает статус и не меняет время', () => {
    const pm = new ProjectManager(tmp)
    const first = pm.completeOnboarding({ skipped: true })
    const before = readFileSync(file(), 'utf8')
    const second = pm.completeOnboarding()
    assert.deepEqual(second, first)
    assert.equal(readFileSync(file(), 'utf8'), before, 'файл не переписывается')
    assert.equal(pm.completeOnboarding({ skipped: true }).status, 'skipped')
  })

  it('существующий пользователь: complete не затирает reason existing', () => {
    writeLegacy({}, true)
    const pm = new ProjectManager(tmp)
    const before = pm.onboardingState()
    assert.deepEqual(pm.completeOnboarding({ skipped: true }), before)
    assert.equal((saved().onboarding as { reason?: string }).reason, 'existing')
  })

  it('невалидный ввод → OrcaError onboarding.invalidInput, состояние не меняется', () => {
    const pm = new ProjectManager(tmp)
    for (const bad of ['yes', 1, true, [], { skipped: 'true' }, { skipped: 1 }, { skipped: null }]) {
      assert.throws(
        () => pm.completeOnboarding(bad as never),
        (e: unknown) => e instanceof OrcaError && e.key === 'onboarding.invalidInput' && /мастер/.test(e.message),
        JSON.stringify(bad)
      )
    }
    assert.equal(pm.onboardingState().status, 'pending')
  })

  it('undefined, null и пустой объект — валидны (completed)', () => {
    assert.equal(new ProjectManager(tmp).completeOnboarding(undefined).status, 'completed')
    rmSync(file())
    assert.equal(new ProjectManager(tmp).completeOnboarding(null as never).status, 'completed')
    rmSync(file())
    assert.equal(new ProjectManager(tmp).completeOnboarding({}).status, 'completed')
  })
})

describe('поле переживает другие записи', () => {
  it('setSettings и markRun не затирают onboarding — ни pending, ни completed', () => {
    const pm = new ProjectManager(tmp)
    pm.setSettings({ keepInBackground: false })
    pm.markRun('1.2.3')
    assert.equal(saved().lastRunVersion, '1.2.3')
    assert.equal(new ProjectManager(tmp).onboardingState().status, 'pending')
    pm.completeOnboarding({ skipped: true })
    const at = pm.onboardingState().at
    pm.setSettings({ language: 'en' })
    pm.markRun('1.2.4')
    const again = new ProjectManager(tmp)
    assert.equal(again.onboardingState().status, 'skipped')
    assert.equal(again.onboardingState().at, at)
  })

  it('поле не попадает в app:getSettings и не меняется через setSettings', () => {
    const pm = new ProjectManager(tmp)
    assert.equal('onboarding' in pm.settings(), false)
    pm.setSettings({ onboarding: { status: 'completed' } } as never)
    assert.equal(pm.onboardingState().status, 'pending')
  })
})
