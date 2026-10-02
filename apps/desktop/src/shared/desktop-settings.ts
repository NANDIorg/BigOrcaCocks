import type { AppLanguage, PermissionMode, NotificationSettings, NotificationSettingsPatch, AppearanceSettings } from '@orca-board/contracts'
import type { AssistantSettings } from '@orca-board/core'

/** Глобальные настройки приложения (не проекта). */
export interface AppSettings {
  /** Закрытие окна не завершает приложение: PTY живут, иконка в трее. По умолчанию true. */
  keepInBackground: boolean
  /** Язык интерфейса; не выбран — русский (язык системы не угадываем, см. `settingsLocale`). */
  language?: AppLanguage
  /** Тема и движение; поле отсутствует у старого main. */
  appearance?: AppearanceSettings
  /** Системные уведомления: фильтры по ролям, видам событий, тихие часы. */
  notifications: NotificationSettings
  /** Автообновление приложения (docs/architecture.md → «Обновление»). */
  updates: UpdateSettings
  /**
   * Ассистент доски: агент, модель, effort, инструкции. Не роль типа задачи — ассистент один на приложение.
   * Применяется к следующему запуску («Новый диалог»), живой ассистент не перезапускается.
   */
  assistant: AssistantSettings
}

/** Настройки автообновления. Дефолты — `DEFAULT_UPDATE_SETTINGS`. */
export interface UpdateSettings {
  /** Проверять наличие новой версии в фоне (при старте и раз в несколько часов). По умолчанию true. */
  autoCheck: boolean
  /** Скачивать найденную версию сразу, без клика. По умолчанию true. */
  autoDownload: boolean
  /**
   * Ставить скачанное обновление, когда у агентов не осталось живых сессий (а не только при выходе).
   * По умолчанию false: без явного решения человека приложение само не перезапускается.
   */
  installWhenIdle: boolean
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true, autoDownload: true, installWhenIdle: false }

/** Патч настроек приложения: notifications, updates и assistant мержатся по полям. */
export interface AppSettingsPatch {
  keepInBackground?: boolean
  language?: AppLanguage
  appearance?: Partial<AppearanceSettings>
  notifications?: NotificationSettingsPatch
  updates?: Partial<UpdateSettings>
  /**
   * Пустая строка в model/effort/systemPrompt/extraArgs очищает поле; смена агента без model/effort/extraArgs
   * сбрасывает их. `extraArgs` — строка как введена, невалидную (`parseExtraArgs`) main отвергает.
   */
  assistant?: Partial<AssistantSettings>
}

/** Способ обновления на этой платформе. */
export type UpdateMode =
  /** Скачивание и установка внутри приложения (Windows NSIS — electron-updater, macOS — свой установщик). */
  | 'auto'
  /** Установить не можем (portable Windows): показываем версию и ссылку `releaseUrl`, человек скачивает сам. */
  | 'manual-download'

/** Почему обновление недоступно (`UpdateState.status === 'unsupported'`). */
export type UpdateUnsupportedReason =
  /** Запуск из исходников/`pnpm dev` (`!app.isPackaged`). */
  | 'dev'
  /** Portable-сборка Windows: заменить exe на ходу нельзя. Состояние — `unsupported`, `mode: 'manual-download'`. */
  | 'portable'
  /** macOS: приложение запущено не из /Applications (например, прямо из dmg или Загрузок). */
  | 'not-in-applications'
  /** macOS: у пользователя нет прав на запись в папку с приложением. */
  | 'no-write-access'
  /** macOS: App Translocation — система запустила копию из read-only образа, подменять нечего. */
  | 'translocated'
  /** Для этой платформы установщика нет (Linux). */
  | 'platform'

/** Что известно о новой версии; отдаёт `PlatformUpdater.check()`. */
export interface UpdateInfo {
  /** Версия без префикса `v` (semver), например `0.4.2`. */
  version: string
  /** Заметки релиза, markdown (тело GitHub Release); нет — пустая строка. */
  releaseNotes: string
  /** Страница релиза на GitHub — для «что нового» и для `manual-download`. */
  releaseUrl: string
}

/**
 * Состояние обновления — машина состояний в main (`main/updater.ts`), единственный источник правды.
 * Переходы: idle → checking → (idle | available | error); available → downloading → (ready | error);
 * ready → installing → перезапуск. `unsupported` — терминальное: проверки и загрузка ничего не делают.
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** Версия запущенного приложения (`app.getVersion()`). */
  currentVersion: string
  /** Найденная версия; null, пока проверка не нашла новой. Сохраняется в downloading/ready/installing/error после находки. */
  availableVersion: string | null
  /** Заметки найденной версии, markdown; null, если версии нет. */
  releaseNotes: string | null
  /** Страница релиза; null, если версии нет. */
  releaseUrl: string | null
  /** Прогресс скачивания 0–100; только при `downloading`, иначе null. */
  percent: number | null
  /**
   * Отложенная установка: `'quit'` — при выходе из приложения, `'idle'` — когда у агентов не останется живых сессий
   * (ставит `install({when})` или `settings.updates.installWhenIdle`); null — ничего не запланировано.
   */
  installPending: 'idle' | 'quit' | null
  /** Способ обновления на этой платформе. */
  mode: UpdateMode
  /** Причина, только при `status === 'unsupported'`. */
  unsupportedReason: UpdateUnsupportedReason | null
  /** Текст ошибки по-русски, только при `status === 'error'`; иначе null. */
  error: string | null
}

/** Когда ставить скачанное обновление (`updates.install`). */
export type UpdateInstallWhen =
  /** Выйти и установить сейчас (с обычным подтверждением выхода, если работают агенты). */
  | 'now'
  /** Когда у агентов не останется живых сессий. */
  | 'idle'
  /** При следующем выходе из приложения. */
  | 'quit'

export const PERMISSION_MODES: Record<PermissionMode, string> = {
  auto: 'Авто — агент работает самостоятельно, при необходимости спросит',
  bypassPermissions: 'Без подтверждений — полностью автономно',
  acceptEdits: 'Только правки файлов — остальное спросит в терминале'
}
