import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ASSISTANT_SETTINGS } from '@orca-board/core'
import { appearance, createAppearanceController, motionScrollBehavior } from './appearance'
import { getAppTheme } from '../shared/theme'
import { droppedPatch, saveAppSettings } from './appSettingsSave'
import { DEFAULT_UPDATE_SETTINGS, type AppSettings } from '../shared/ipc'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../shared/notifications'
import { normalizeAppearance } from '../shared/appearance'

class MotionQuery extends EventTarget {
  matches = false
  reduce(on: boolean): void { this.matches = on; this.dispatchEvent(new Event('change')) }
}

function surface() {
  const values = new Map<string, string>()
  return { dataset: {} as DOMStringMap, values, style: {
    setProperty(name: string, value: string): void { values.set(name, value) }
  } }
}

test('кэш устраняет вспышку старой темы; подтверждённая смена обновляет все токены и сохраняет выбор', () => {
  const root = surface()
  const cache = new Map([['orca.appearance', JSON.stringify({ theme: 'slate', motion: 'system' })]])
  const store = createAppearanceController({ root, cache: {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => { cache.set(key, value) }
  } })
  assert.equal(root.dataset.theme, 'slate')
  let calls = 0
  const stop = store.subscribe(() => { calls++ })
  store.apply({ theme: 'paper', motion: 'reduced' })
  for (const [token, color] of Object.entries(getAppTheme('paper').colors)) assert.equal(root.values.get(`--${token}`), color)
  assert.equal(root.values.get('color-scheme'), 'light')
  assert.equal(root.dataset.motion, 'reduced')
  assert.deepEqual(JSON.parse(cache.get('orca.appearance')!), { theme: 'paper', motion: 'reduced', highSaturation: false })
  assert.equal(calls, 1)
  stop()
  store.dispose()
})

test('системное уменьшение движения применяется живьём; ручное уменьшение не отменяется системой', () => {
  const media = new MotionQuery()
  const root = surface()
  const store = createAppearanceController({ root, media })
  media.reduce(true)
  assert.equal(store.getSnapshot().reducedMotion, true)
  media.reduce(false)
  assert.equal(store.getSnapshot().reducedMotion, false)
  store.apply({ theme: 'graphite', motion: 'reduced' })
  media.reduce(true)
  media.reduce(false)
  assert.equal(store.getSnapshot().reducedMotion, true)
  store.apply({ theme: 'graphite', motion: 'system' })
  assert.equal(root.dataset.motion, 'full')
  store.dispose()
  media.reduce(true)
  assert.equal(root.dataset.motion, 'full')
})

test('повышенная насыщенность применяется из кэша сразу, обновляется с темой и полностью отключается', () => {
  const root = surface()
  const cache = new Map([['orca.appearance', JSON.stringify({ theme: 'slate', motion: 'system', highSaturation: true })]])
  const options = { root, cache: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => { cache.set(key, value) }
  } }
  const store = createAppearanceController(options)
  assert.equal(store.getSnapshot().settings.highSaturation, true)
  assert.equal(root.dataset.saturation, 'high')
  assert.notEqual(root.values.get('--accent'), getAppTheme('slate').colors.accent)
  assert.equal(root.values.get('--page'), '#23282d')
  store.apply({ theme: 'forest', motion: 'reduced', highSaturation: true })
  assert.equal(root.dataset.theme, 'forest')
  assert.equal(root.dataset.motion, 'reduced')
  assert.notEqual(root.values.get('--col-done'), getAppTheme('forest').colors['col-done'])
  store.dispose()
  const restored = createAppearanceController(options)
  assert.equal(restored.getSnapshot().settings.highSaturation, true)
  restored.apply({ theme: 'forest', motion: 'reduced', highSaturation: false })
  for (const [token, color] of Object.entries(getAppTheme('forest').colors)) assert.equal(root.values.get(`--${token}`), color)
  assert.equal(root.dataset.saturation, 'normal')
  assert.equal(JSON.parse(cache.get('orca.appearance')!).highSaturation, false)
  restored.dispose()
})

test('запоздалое чтение настроек при старте не откатывает уже подтверждённую смену темы', async () => {
  const store = createAppearanceController()
  let resolve!: (value: Pick<AppSettings, 'appearance'>) => void
  const stop = store.start({ getSettings: () => new Promise(done => { resolve = done }) })
  store.apply({ theme: 'forest', motion: 'system' })
  resolve({ appearance: normalizeAppearance({ theme: 'graphite', motion: 'system' }) })
  await Promise.resolve()
  assert.equal(store.getSnapshot().settings.theme, 'forest')
  stop()
  store.dispose()
})

test('старый main и повреждённый/недоступный кэш безопасно возвращают графит', async () => {
  const store = createAppearanceController({ cache: {
    getItem: () => '{broken', setItem: () => { throw new Error('denied') }
  } })
  store.apply({ theme: 'slate', motion: 'system' })
  const stop = store.start({ getSettings: async () => ({}) })
  await Promise.resolve()
  assert.equal(store.getSnapshot().settings.theme, 'graphite')
  stop()
  store.dispose()
})

test('старый main не может молча принять и потерять оформление; проверяется каждое поле патча', () => {
  assert.equal(droppedPatch({ appearance: { theme: 'slate' } }, {}), true)
  assert.equal(droppedPatch({ appearance: { theme: 'slate' } }, { appearance: normalizeAppearance({ theme: 'graphite', motion: 'system' }) }), true)
  assert.equal(droppedPatch({ appearance: { motion: 'reduced' } }, { appearance: normalizeAppearance({ theme: 'slate', motion: 'system' }) }), true)
  assert.equal(droppedPatch({ appearance: { theme: 'slate' } }, { appearance: normalizeAppearance({ theme: 'slate', motion: 'system' }) }), false)
  const legacy = normalizeAppearance({ theme: 'slate', motion: 'system' })
  Reflect.deleteProperty(legacy, 'highSaturation')
  assert.equal(droppedPatch({ appearance: { highSaturation: true } }, { appearance: legacy }), true)
  assert.equal(droppedPatch({ appearance: { highSaturation: false } }, { appearance: legacy }), true)
})

test('сбой и отброшенный патч сохраняют подтверждённую тему; успех меняет тему и JS-прокрутку', async () => {
  const previous = appearance.getSnapshot().settings
  const settings: AppSettings = { keepInBackground: true, notifications: DEFAULT_NOTIFICATION_SETTINGS, updates: DEFAULT_UPDATE_SETTINGS, assistant: DEFAULT_ASSISTANT_SETTINGS, appearance: { theme: 'slate', motion: 'system', highSaturation: false } }
  appearance.apply(settings.appearance)
  try {
    const failed = await saveAppSettings({ setSettings: async () => { throw new Error('disk failed') } }, { appearance: { theme: 'paper' } })
    assert.equal(failed.settings, null)
    assert.equal(failed.error, 'disk failed')
    assert.equal(appearance.getSnapshot().settings.theme, 'slate')
    const stale = await saveAppSettings({ setSettings: async () => settings }, { appearance: { theme: 'paper' } })
    assert.ok(stale.error)
    assert.equal(appearance.getSnapshot().settings.theme, 'slate')
    const saved = await saveAppSettings({ setSettings: async () => ({ ...settings, appearance: { theme: 'paper', motion: 'reduced', highSaturation: false } }) }, { appearance: { theme: 'paper', motion: 'reduced' } })
    assert.equal(saved.error, null)
    assert.equal(appearance.getSnapshot().settings.theme, 'paper')
    assert.equal(motionScrollBehavior(), 'auto')
  } finally { appearance.apply(previous) }
})

test('сбой записи и старый main не включают насыщенность; подтверждённое сохранение включает её', async () => {
  const previous = appearance.getSnapshot().settings
  const settings: AppSettings = { keepInBackground: true, notifications: DEFAULT_NOTIFICATION_SETTINGS, updates: DEFAULT_UPDATE_SETTINGS, assistant: DEFAULT_ASSISTANT_SETTINGS, appearance: { theme: 'slate', motion: 'system', highSaturation: false } }
  appearance.apply(settings.appearance)
  try {
    const patch = { appearance: { highSaturation: true } }
    const failed = await saveAppSettings({ setSettings: async () => { throw new Error('disk failed') } }, patch)
    assert.equal(failed.error, 'disk failed')
    assert.equal(appearance.getSnapshot().settings.highSaturation, false)
    const stale = await saveAppSettings({ setSettings: async () => settings }, patch)
    assert.ok(stale.error)
    assert.equal(appearance.getSnapshot().settings.highSaturation, false)
    const saved = await saveAppSettings({ setSettings: async () => ({ ...settings, appearance: { theme: 'slate', motion: 'system', highSaturation: true } }) }, patch)
    assert.equal(saved.error, null)
    assert.equal(appearance.getSnapshot().settings.highSaturation, true)
    assert.notEqual(appearance.getSnapshot().theme.colors.accent, getAppTheme('slate').colors.accent)
  } finally { appearance.apply(previous) }
})
