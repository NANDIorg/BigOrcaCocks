import type { AreaTranslation } from '../types'
import type ru from '../ru/common'

export default {
  close: 'Close',
  loading: 'Loading…',
  on: 'on',
  off: 'off',
  staleApp: 'The app is running an old main/preload version. Restart the app.',
  'unit.lessThanMinute': '<1 min',
  'unit.min': '{n} min',
  'unit.hour': '{n} h',
  'unit.day': '{n} d',
  'unit.thousand': '{n}K',
  'unit.million': '{n}M',
  'unit.billion': '{n}B'
} satisfies AreaTranslation<typeof ru>
