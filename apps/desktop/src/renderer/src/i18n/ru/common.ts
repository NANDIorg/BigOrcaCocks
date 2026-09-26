import type { AreaDict } from '../types'

/** Общие строки: кнопки, состояния, единицы измерения (их берут хелперы форматирования в `i18n/format.ts`). */
export default {
  close: 'Закрыть',
  loading: 'Загрузка…',
  on: 'вкл',
  off: 'выкл',
  staleApp: 'Приложение запущено со старой версией main/preload. Перезапустите приложение.',
  'image.alt': 'Изображение {n}',
  'image.remove': 'Убрать изображение',
  'image.removeN': 'Убрать изображение {n}',
  'image.open': 'Открыть изображение {n}',
  'image.add': 'Добавить изображение',
  'image.error': 'Изображение не добавлено: {error}',
  'image.loadFailed': 'не загрузилось',
  'image.errFormat': 'формат {type} не поддерживается (нужен PNG, JPEG, GIF или WebP)',
  'image.errSize': 'изображение больше {mb} МБ',
  'image.errUnknown': 'не удалось распознать изображение',
  'image.errCount': 'можно приложить не больше {count} изображений',
  'image.errTotal': 'изображения вместе больше {mb} МБ',
  'image.viewer': 'Просмотр изображения {n} из {total}',
  'image.prev': 'Предыдущее изображение',
  'image.next': 'Следующее изображение',
  'unit.lessThanMinute': '<1 мин',
  'unit.min': '{n} мин',
  'unit.hour': '{n} ч',
  'unit.day': '{n} д',
  'unit.thousand': '{n} тыс',
  'unit.million': '{n} млн',
  'unit.billion': '{n} млрд'
} satisfies AreaDict
