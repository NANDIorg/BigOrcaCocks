import type { AppLanguage } from '../../../shared/ipc'

/** Язык интерфейса. Совпадает с `AppSettings.language`, который хранит main. */
export type Locale = AppLanguage

/**
 * Формы множественного числа по категориям `Intl.PluralRules`. Русскому нужны one/few/many
 * (1 задача, 2 задачи, 5 задач), английскому — one/other. Нет нужной категории — берётся other, затем many.
 * zero/two — для будущих языков с такими категориями.
 */
export interface PluralMessage {
  zero?: string
  one: string
  two?: string
  few?: string
  many?: string
  other?: string
}

/** Строка словаря: текст с параметрами `{name}` или формы множественного числа (число — параметр `count`). */
export type Message = string | PluralMessage

/** Словарь одной области: плоские ключи внутри области (`'general.title'`). */
export type AreaDict = Record<string, Message>

/** Словарь области на другом языке: ровно те же ключи, что в русском (лишний или пропущенный — ошибка типа). */
export type AreaTranslation<Ru extends AreaDict> = { [K in keyof Ru]: Message }

/** Параметры подстановки `{name}`. */
export type Params = Record<string, string | number>
