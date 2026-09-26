import type { AreaTranslation } from '../types'
import type ru from '../ru/common'

export default {
  close: 'Close',
  loading: 'Loading…',
  on: 'on',
  off: 'off',
  staleApp: 'The app is running an old main/preload version. Restart the app.',
  'image.alt': 'Image {n}',
  'image.remove': 'Remove image',
  'image.removeN': 'Remove image {n}',
  'image.open': 'Open image {n}',
  'image.add': 'Add image',
  'image.error': 'Image not added: {error}',
  'image.loadFailed': 'failed to load',
  'image.errFormat': '{type} is not supported (use PNG, JPEG, GIF or WebP)',
  'image.errSize': 'image is larger than {mb} MB',
  'image.errUnknown': 'couldn’t recognize the image',
  'image.errCount': 'you can attach up to {count} images',
  'image.errTotal': 'images add up to more than {mb} MB',
  'image.viewer': 'Viewing image {n} of {total}',
  'image.prev': 'Previous image',
  'image.next': 'Next image',
  'unit.lessThanMinute': '<1 min',
  'unit.min': '{n} min',
  'unit.hour': '{n} h',
  'unit.day': '{n} d',
  'unit.thousand': '{n}K',
  'unit.million': '{n}M',
  'unit.billion': '{n}B'
} satisfies AreaTranslation<typeof ru>
