import type { AreaTranslation } from '../types'
import type ru from '../ru/common'

export default {
  close: 'Close',
  loading: 'Loading…',
  on: 'on',
  off: 'off',
  staleApp: 'The app is running an old main/preload version. Restart the app.',
  'attach.add': 'Attach',
  'attach.addTitle': 'Attach an image: PNG, JPEG, GIF or WebP',
  'attach.hint': 'Paste a screenshot with {keys} or drop a file onto the field — the agent gets it as a file.',
  'attach.image': 'Image {n}',
  'attach.removeImage': 'Remove image',
  'attach.removeImageN': 'Remove image {n}',
  'attach.imageError': 'Image not added: {error}',
  'attach.errFormat': '{type} is not supported (PNG, JPEG, GIF or WebP required)',
  'attach.errSize': 'the image is larger than {mb} MB',
  'attach.errUnknown': 'could not recognize the image',
  'attach.errCount': 'at most {count} images can be attached',
  'attach.errTotal': 'the images together are larger than {mb} MB',
  'attach.stale': 'The app is running an old main/preload version without images for feedback. Restart the app.',
  'unit.lessThanMinute': '<1 min',
  'unit.min': '{n} min',
  'unit.hour': '{n} h',
  'unit.day': '{n} d',
  'unit.thousand': '{n}K',
  'unit.million': '{n}M',
  'unit.billion': '{n}B'
} satisfies AreaTranslation<typeof ru>
