import type { AssistantSettings } from '@orca-board/core'
import type { AppearanceSettings } from './appearance.ts'
import type { NotificationSettings, NotificationSettingsPatch } from './notifications.ts'

/** Общие настройки владельца данных; поведение окна и обновления добавляет хост. */
export interface RuntimeSettings {
  language?: AppLanguage
  appearance?: AppearanceSettings
  notifications: NotificationSettings
  assistant: AssistantSettings
}

/** Вложенные разделы объединяются по полям; пустые строки ассистента очищают поле. */
export interface RuntimeSettingsPatch {
  language?: AppLanguage
  appearance?: Partial<AppearanceSettings>
  notifications?: NotificationSettingsPatch
  assistant?: Partial<AssistantSettings>
}

/** Язык интерфейса (renderer/src/i18n). */
export type AppLanguage = 'ru' | 'en'

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

/** Текущая версия мастера первого запуска (main пишет её в projects.json, renderer сверяет). */
export const ONBOARDING_VERSION = 1

/** Состояние мастера первого запуска. Не входит в `AppSettings`: человек меняет его только через `onboarding:complete`. */
export interface OnboardingState {
  /** Мастер нужно показать при старте: статус `pending`. Новый main всегда отдаёт boolean. */
  required: boolean
  status: 'pending' | 'completed' | 'skipped'
  /** Версия мастера, с которой записан статус. */
  version: number
  /** Когда пройден/пропущен (мс); у `pending` нет. */
  at?: number
}

export interface OnboardingCompleteInput {
  /** true — «Пропустить» (status 'skipped'), иначе 'completed'. По умолчанию false. */
  skipped?: boolean
}
