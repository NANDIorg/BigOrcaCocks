import { useMemo, useSyncExternalStore } from 'react'
import type { AppSettings } from '../../../shared/ipc'
import { DICTS, type TKey } from './dict'
import type { Locale, Message, Params } from './types'

export type { Locale, Message, Params, PluralMessage } from './types'
export type { Area, TKey } from './dict'

/**
 * i18n интерфейса (docs/architecture.md → «Язык интерфейса»). Текущий язык — модульное состояние:
 * его читают и `t()` в модулях логики (`duration.ts`, `statsFormat.ts`), и хук `useT()`, который
 * перерисовывает компонент при смене языка. Язык по умолчанию — русский.
 */

export const LOCALES: Locale[] = ['ru', 'en']
export const DEFAULT_LOCALE: Locale = 'ru'

/** Названия языков в переключателе — каждый на своём языке. */
export const LOCALE_NAMES: Record<Locale, string> = { ru: 'Русский', en: 'English' }

/** Кэш выбора в localStorage: чтобы окно не мигало русским, пока main отдаёт настройки. */
const CACHE_KEY = 'orca.locale'

export function isLocale(v: unknown): v is Locale {
  return v === 'ru' || v === 'en'
}

let current: Locale = DEFAULT_LOCALE
const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return current
}

/** Сменить язык: перерисовываются все компоненты с `useT()` / `useLocale()`. */
export function setLocale(locale: Locale): void {
  if (locale === current) return
  current = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  try {
    localStorage.setItem(CACHE_KEY, locale)
  } catch {
    // Нет localStorage (тесты, запрет) — язык всё равно придёт из настроек main.
  }
  for (const l of listeners) l()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Язык из настроек приложения: выбран явно — он, не выбран (первый запуск, старый main) — русский.
 * Язык системы не угадываем: `navigator.language` в Electron — язык самого приложения (`en-US`
 * при русской macOS), и автоопределение переключило бы на английский всех, кто обновился.
 */
export function settingsLocale(settings: Pick<AppSettings, 'language'> | null | undefined): Locale {
  return isLocale(settings?.language) ? settings.language : DEFAULT_LOCALE
}

/**
 * Язык при старте окна: сразу — из кэша (чтобы английский интерфейс не мигал русским), затем — из
 * настроек main. Без `window.orca.app` (старый preload) или при ошибке — кэш или русский, окно не падает.
 */
export function initLocale(api: { getSettings(): Promise<Pick<AppSettings, 'language'>> } | undefined): void {
  let cached: string | null = null
  try {
    cached = localStorage.getItem(CACHE_KEY)
  } catch {
    cached = null
  }
  setLocale(isLocale(cached) ? cached : DEFAULT_LOCALE)
  if (typeof api?.getSettings !== 'function') return
  api.getSettings().then((s) => setLocale(settingsLocale(s)), () => undefined)
}

/** Категория множественного числа по правилам языка. */
export function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(n)
}

function pick(m: Message, locale: Locale, params: Params | undefined): string {
  if (typeof m === 'string') return m
  const n = Number(params?.count ?? 0)
  return m[pluralCategory(locale, n)] ?? m.other ?? m.many ?? m.one
}

/** Подставить `{name}`; параметра нет — плейсхолдер остаётся как есть, чтобы пропуск было видно. */
export function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
}

/**
 * Перевод на заданном языке. Ключа нет в словаре языка — русский текст, нет и там — сам ключ
 * (типы такого не допустят, но данные из старого кэша HMR — могут).
 */
export function translate(locale: Locale, key: TKey, params?: Params): string {
  const dot = key.indexOf('.')
  const area = key.slice(0, dot) as keyof (typeof DICTS)['ru']
  const sub = key.slice(dot + 1)
  const m = DICTS[locale][area]?.[sub] ?? DICTS[DEFAULT_LOCALE][area]?.[sub]
  return m === undefined ? key : interpolate(pick(m, locale, params), params)
}

/** Перевод на текущем языке. В компонентах — через `useT()`, иначе смена языка их не перерисует. */
export function t(key: TKey, params?: Params): string {
  return translate(current, key, params)
}

export type TFunction = (key: TKey, params?: Params) => string

/** Текущий язык; компонент перерисовывается при смене. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

/** `t` для компонента: `const t = useT()`, затем `t('settings.title')`. Смена языка перерисует компонент. */
export function useT(): TFunction {
  const locale = useLocale()
  return useMemo(() => (key: TKey, params?: Params) => translate(locale, key, params), [locale])
}
