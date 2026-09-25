// Запуск: pnpm --filter @orca-board/desktop test. Мастер первого запуска: когда показывать и как пережить
// старый main/preload; общий хелпер записи настроек (язык сразу, «поле отброшено» → staleApp).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings, OnboardingCompleteInput, OnboardingState } from '../../shared/ipc'
import { completeOnboarding, isStaleOnboardingError, loadOnboarding, onboardingApi, shouldShowOnboarding } from './onboarding'
import { droppedPatch, saveAppSettings } from './appSettingsSave'
import { getLocale, setLocale, t } from './i18n'

afterEach(() => setLocale('ru'))

const PENDING: OnboardingState = { required: true, status: 'pending', version: 1 }
const DONE: OnboardingState = { required: false, status: 'completed', version: 1, at: 1 }
const STALE = new Error("Error invoking remote method 'onboarding:getState': Error: No handler registered for 'onboarding:getState'")

test('onboardingApi — старый preload без onboarding или без методов: undefined', () => {
  assert.equal(onboardingApi(undefined), undefined)
  assert.equal(onboardingApi({}), undefined)
  assert.equal(onboardingApi({ onboarding: { getState: async () => PENDING } }), undefined)
  assert.ok(onboardingApi({ onboarding: { getState: async () => PENDING, complete: async () => DONE } }))
})

test('onboardingApi — методы вызываются на своём объекте', async () => {
  const host = {
    onboarding: {
      tag: 'x',
      async getState(this: { tag: string }): Promise<OnboardingState> {
        assert.equal(this.tag, 'x')
        return PENDING
      },
      async complete(this: { tag: string }): Promise<OnboardingState> {
        assert.equal(this.tag, 'x')
        return DONE
      }
    }
  }
  const api = onboardingApi(host)
  assert.deepEqual(await api?.getState(), PENDING)
  assert.deepEqual(await api?.complete(), DONE)
})

test('isStaleOnboardingError — только «нет хендлера onboarding:*»', () => {
  assert.equal(isStaleOnboardingError("Error invoking remote method 'onboarding:complete': Error: No handler registered for 'onboarding:complete'"), true)
  assert.equal(isStaleOnboardingError("No handler registered for 'docs:list'"), false)
  assert.equal(isStaleOnboardingError('projects.json повреждён'), false)
})

test('loadOnboarding — состояние, а при старом preload, старом main и любом сбое — null', async () => {
  assert.deepEqual(await loadOnboarding({ onboarding: { getState: async () => PENDING, complete: async () => DONE } }), PENDING)
  assert.equal(await loadOnboarding(undefined), null)
  assert.equal(await loadOnboarding({}), null)
  const stale = { onboarding: { getState: async () => { throw STALE }, complete: async () => DONE } }
  assert.equal(await loadOnboarding(stale), null)
  const broken = { onboarding: { getState: async () => { throw new Error('boom') }, complete: async () => DONE } }
  assert.equal(await loadOnboarding(broken), null)
})

test('shouldShowOnboarding — только required === true (инверсия: неизвестное состояние не показывает мастер)', () => {
  assert.equal(shouldShowOnboarding(PENDING), true)
  assert.equal(shouldShowOnboarding(DONE), false)
  assert.equal(shouldShowOnboarding(null), false)
  assert.equal(shouldShowOnboarding(undefined), false)
  // Старый main мог не прислать поле: «нет required» не значит «показать».
  assert.equal(shouldShowOnboarding({} as OnboardingState), false)
  assert.equal(shouldShowOnboarding({ required: 'yes' } as unknown as OnboardingState), false)
})

test('completeOnboarding — skipped передаётся в main, «Готово» — без аргумента; сбой не бросает', async () => {
  const calls: (OnboardingCompleteInput | undefined)[] = []
  const host = { onboarding: { getState: async () => PENDING, complete: async (i?: OnboardingCompleteInput) => { calls.push(i); return DONE } } }
  await completeOnboarding(host, true)
  await completeOnboarding(host, false)
  assert.deepEqual(calls, [{ skipped: true }, undefined])
  await completeOnboarding({}, true)
  await completeOnboarding({ onboarding: { getState: async () => PENDING, complete: async () => { throw STALE } } }, false)
})

const SETTINGS = { language: 'en', keepInBackground: true } as unknown as AppSettings

test('saveAppSettings — язык меняется сразу, ещё до ответа main', async () => {
  let seen = ''
  const res = await saveAppSettings({ setSettings: async () => { seen = getLocale(); return SETTINGS } }, { language: 'en' })
  assert.equal(seen, 'en')
  assert.equal(res.settings, SETTINGS)
  assert.equal(res.error, null)
})

test('saveAppSettings — старый main отбросил язык: staleApp; ошибка main — её текст, настройки не меняются', async () => {
  const dropped = await saveAppSettings({ setSettings: async () => ({ keepInBackground: true } as unknown as AppSettings) }, { language: 'en' })
  assert.equal(dropped.error, t('common.staleApp'))
  const failed = await saveAppSettings({ setSettings: async () => { throw new Error("Error invoking remote method 'app:setSettings': Error: диск полон") } }, { keepInBackground: false })
  assert.equal(failed.settings, null)
  assert.equal(failed.error, 'диск полон')
})

test('droppedPatch — язык и updates', () => {
  assert.equal(droppedPatch({ language: 'ru' }, { language: 'ru', updates: undefined as never }), false)
  assert.equal(droppedPatch({ language: 'ru' }, { language: 'en', updates: undefined as never }), true)
  assert.equal(droppedPatch({ updates: { autoCheck: true } }, { language: 'ru', updates: undefined as never }), true)
  assert.equal(droppedPatch({ keepInBackground: false }, { language: 'ru', updates: undefined as never }), false)
})
