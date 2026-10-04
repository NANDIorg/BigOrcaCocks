import { useSyncExternalStore } from 'react'
import { appearance, type AppearanceSnapshot } from './appearance'

export function useAppearance(): AppearanceSnapshot {
  return useSyncExternalStore(appearance.subscribe, appearance.getSnapshot)
}
