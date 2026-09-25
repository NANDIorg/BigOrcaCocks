import type { AreaDict } from '../types'

/** Общие строки: кнопки, состояния, единицы измерения (их берут хелперы форматирования в `i18n/format.ts`). */
export default {
  close: 'Закрыть',
  loading: 'Загрузка…',
  on: 'вкл',
  off: 'выкл',
  staleApp: 'Приложение запущено со старой версией main/preload. Перезапустите приложение.',
  'unit.lessThanMinute': '<1 мин',
  'unit.min': '{n} мин',
  'unit.hour': '{n} ч',
  'unit.day': '{n} д',
  'unit.thousand': '{n} тыс',
  'unit.million': '{n} млн',
  'unit.billion': '{n} млрд'
} satisfies AreaDict
