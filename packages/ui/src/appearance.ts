import type { AppSettings } from '../shared/ipc'
import { normalizeAppearance, type AppearanceSettings } from '../shared/appearance'
import { getAppTheme, type ThemeDefinition } from '../shared/theme'

interface AppearanceSurface {
  dataset: DOMStringMap
  style: Pick<CSSStyleDeclaration, 'setProperty'>
}
interface AppearanceCache { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface MotionQuery extends EventTarget { readonly matches: boolean }
interface AppearanceSource {
  getSettings(): Promise<Pick<AppSettings, 'appearance'>>
  onChanged?(listener: () => void): () => void
}
export interface AppearanceSnapshot {
  readonly settings: AppearanceSettings
  readonly theme: ThemeDefinition
  readonly reducedMotion: boolean
}

const CACHE_KEY = 'orca.appearance'

/** Один владелец палитры, кэша и движения: xterm подписывается без пересоздания PTY и истории. */
export function createAppearanceController(options: { root?: AppearanceSurface; cache?: AppearanceCache; media?: MotionQuery } = {}) {
  let cached: unknown
  try { cached = JSON.parse(options.cache?.getItem(CACHE_KEY) ?? 'null') } catch { cached = undefined }
  let settings = normalizeAppearance(cached)
  let snapshot: AppearanceSnapshot
  let revision = 0
  const listeners = new Set<() => void>()
  const sources = new Set<() => void>()

  function publish(): void {
    const theme = getAppTheme(settings.theme, settings.highSaturation)
    const reducedMotion = settings.motion === 'reduced' || options.media?.matches === true
    snapshot = { settings, theme, reducedMotion }
    if (options.root) {
      for (const [token, color] of Object.entries(theme.colors)) options.root.style.setProperty(`--${token}`, color)
      options.root.style.setProperty('color-scheme', theme.colorScheme)
      options.root.dataset.theme = settings.theme
      options.root.dataset.motion = reducedMotion ? 'reduced' : 'full'
      options.root.dataset.saturation = settings.highSaturation ? 'high' : 'normal'
    }
    for (const listener of listeners) listener()
  }

  function apply(raw: unknown): void {
    revision++
    settings = normalizeAppearance(raw)
    try { options.cache?.setItem(CACHE_KEY, JSON.stringify(settings)) } catch { /* Основной файл в main остаётся источником истины. */ }
    publish()
  }

  publish()
  options.media?.addEventListener('change', publish)
  return {
    getSnapshot: (): AppearanceSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    apply,
    start(api?: AppearanceSource): () => void {
      if (typeof api?.getSettings !== 'function') return () => {}
      let stopped = false
      const refresh = (): void => {
        const request = ++revision
        api.getSettings().then(value => {
          if (!stopped && request === revision) apply(value.appearance)
        }, () => undefined)
      }
      refresh()
      const unsubscribe = api.onChanged?.(refresh)
      const stop = (): void => { stopped = true; unsubscribe?.(); sources.delete(stop) }
      sources.add(stop)
      return stop
    },
    dispose(): void {
      for (const stop of sources) stop()
      options.media?.removeEventListener('change', publish)
      listeners.clear()
    }
  }
}

function browserCache(): AppearanceCache | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

export const appearance = createAppearanceController({
  root: typeof document === 'undefined' ? undefined : document.documentElement,
  cache: browserCache(),
  media: typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)')
})

export function reducedMotion(): boolean {
  // Системный флаг читается и при первом импорте без окна (тесты и старый renderer).
  return appearance.getSnapshot().reducedMotion || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

/** Явный smooth в DOM не подчиняется CSS scroll-behavior, поэтому выбор общий и для JS. */
export function motionScrollBehavior(): ScrollBehavior {
  return reducedMotion() ? 'auto' : 'smooth'
}
