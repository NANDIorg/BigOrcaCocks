import type { AppLanguage } from '../shared/ipc'
import ru from './strings/ru'
import en from './strings/en'

/**
 * Тексты main, которые видит человек (трей, уведомления, нативные диалоги, ошибки IPC), на языке интерфейса
 * (docs/architecture.md → «Язык интерфейса» → «main»). Свой маленький модуль, а не i18n renderer: тот тянет React.
 * Язык — модульное состояние, его ставит `index.ts` из `AppSettings.language` при старте и при `app:setSettings`.
 * Промпты, skills и всё, что читают агенты через сокет и CLI, остаётся русским.
 */

export type MainLocale = AppLanguage

/** Формы множественного числа по `Intl.PluralRules`: ru — one/few/many, en — one/other. */
export interface PluralMessage {
  one: string
  few?: string
  many?: string
  other?: string
}

export type Message = string | PluralMessage
export type MKey = keyof typeof ru

/** Значение параметра: текст, число или вложенное сообщение (переводится на тот же язык). */
export type MParam = string | number | MText
export type MParams = Record<string, MParam>

/** Сообщение, которое ещё не переведено: ключ и параметры. Переводится на нужный язык при показе. */
export interface MText {
  key: MKey
  params?: MParams
}

const DICTS: Record<MainLocale, Record<MKey, Message>> = { ru, en }

let current: MainLocale = 'ru'

export function mainLocale(): MainLocale {
  return current
}

/** Язык из настроек: не выбран (первый запуск, старая версия) — русский, как в renderer (`settingsLocale`). */
export function setMainLocale(locale: AppLanguage | undefined): void {
  current = locale === 'en' ? 'en' : 'ru'
}

export function isMText(v: unknown): v is MText {
  return typeof v === 'object' && v !== null && typeof (v as MText).key === 'string' && (v as MText).key in ru
}

function pick(m: Message, locale: MainLocale, n: number): string {
  if (typeof m === 'string') return m
  const cat = new Intl.PluralRules(locale).select(n)
  return (cat === 'one' ? m.one : cat === 'few' ? m.few : cat === 'many' ? m.many : m.other) ?? m.other ?? m.many ?? m.one
}

/** Перевод на заданном языке; параметра нет — плейсхолдер остаётся, чтобы пропуск было видно. */
export function mtIn(locale: MainLocale, key: MKey, params?: MParams): string {
  const m = DICTS[locale][key] ?? DICTS.ru[key]
  if (m === undefined) return key
  const text = pick(m, locale, Number(params?.count ?? 0))
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (all, name: string) => {
    const v = params[name]
    if (v === undefined) return all
    return isMText(v) ? mtIn(locale, v.key, v.params) : String(v)
  })
}

/** Перевод на текущем языке интерфейса. */
export function mt(key: MKey, params?: MParams): string {
  return mtIn(current, key, params)
}

/**
 * Ошибка с ключом словаря. `message` — по-русски: его получают сокет и CLI (агенты читают русский), тесты и логи.
 * Для renderer её переводит `ipcError` в обёртке `handle` (`index.ts`).
 */
export class OrcaError extends Error {
  readonly key: MKey
  readonly params: MParams | undefined

  constructor(key: MKey, params?: MParams) {
    super(mtIn('ru', key, params))
    this.name = 'OrcaError'
    this.key = key
    this.params = params
  }

  static of(m: MText): OrcaError {
    return new OrcaError(m.key, m.params)
  }
}

/**
 * Ошибка для ответа IPC: `OrcaError` — текст на языке интерфейса и код в имени. Electron передаёт в renderer
 * только `String(error)` («имя: сообщение»), поэтому стабильный код едет в имени: `OrcaError[docs.notFound]`.
 * renderer достаёт его `ipcErrorCode()` и распознаёт ошибку по коду, а не по тексту на каком-то языке.
 * Остальные ошибки — как есть.
 */
export function ipcError(e: unknown): unknown {
  if (!(e instanceof OrcaError)) return e
  const out = new Error(mt(e.key, e.params))
  out.name = `OrcaError[${e.key}]`
  return out
}
