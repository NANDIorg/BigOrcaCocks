import type { AreaDict, Locale } from './types'
import ruCommon from './ru/common'
import ruSettings from './ru/settings'
import ruBoard from './ru/board'
import ruShell from './ru/shell'
import ruGlobal from './ru/global'
import ruConfig from './ru/config'
import enCommon from './en/common'
import enSettings from './en/settings'
import enBoard from './en/board'
import enShell from './en/shell'
import enGlobal from './en/global'
import enConfig from './en/config'

/**
 * Русские словари по областям — эталон ключей. Области разнесены по файлам, чтобы задачи перевода
 * разных экранов правили разные файлы и не конфликтовали при мерже. Новая область — файл в `ru/` и `en/`
 * и строка здесь и в `DICTS.en`.
 */
export const RU = {
  common: ruCommon,
  settings: ruSettings,
  board: ruBoard,
  shell: ruShell,
  global: ruGlobal,
  config: ruConfig
}

export type Area = keyof typeof RU

/** Ключ `t()`: `область.ключ` (`'settings.general.title'`). Опечатка в ключе — ошибка типа. */
export type TKey = { [A in Area]: `${A}.${keyof (typeof RU)[A] & string}` }[Area]

/** Словари всех языков. Ключи en сверяет тип `AreaTranslation` в каждом файле `en/*.ts` и тест i18n.test.ts. */
export const DICTS: Record<Locale, Record<Area, AreaDict>> = {
  ru: RU,
  en: {
    common: enCommon,
    settings: enSettings,
    board: enBoard,
    shell: enShell,
    global: enGlobal,
    config: enConfig
  }
}
