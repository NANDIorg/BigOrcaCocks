// Обновление на Windows. Два режима:
//  • NSIS-установщик — electron-updater по `latest.yml` из GitHub Releases: он сам качает установщик, проверяет sha512 из
//    манифеста и ставит через `quitAndInstall`. Подписи кода у нас нет, поэтому проверка издателя (`publisherName`) не
//    настроена и electron-updater её пропускает — целостность держится на sha512 манифеста;
//  • portable (`PORTABLE_EXECUTABLE_FILE`) — заменить exe на ходу нельзя, только «скачать новый файл»: ищем
//    portable-exe в последнем релизе и отдаём ссылку на страницу релиза (`UpdateState.mode === 'manual-download'`).
// Расписание, состояния и отложенную установку ведёт `Updater` (updater.ts); здесь только «как».
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from '../shared/ipc'
import type { PlatformUpdater } from './updater'
import type { UpdateSupport } from './updateMachine'
import { fetchLatestRelease, portableUpdateInfo, releaseNotesText, releasePageUrl } from './githubRelease'

export interface WinUpdaterEnv {
  version: string
  /** Путь к portable-exe (`process.env.PORTABLE_EXECUTABLE_FILE`); пусто — обычная установка через NSIS. */
  portableExe: string | undefined
}

export function createWinUpdater(env: WinUpdaterEnv): { support: UpdateSupport; backend: PlatformUpdater } {
  if (env.portableExe) {
    return { support: { mode: 'manual-download', unsupportedReason: 'portable' }, backend: portableUpdater(env.version) }
  }
  return { support: { mode: 'auto', unsupportedReason: null }, backend: nsisUpdater() }
}

function nsisUpdater(): PlatformUpdater {
  // Всем управляет `Updater`: автоскачивание и «поставить при выходе» electron-updater не делает сам.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  /** `check()` нашёл обновление — только тогда `download()` имеет смысл. */
  let found = false
  return {
    async check(): Promise<UpdateInfo | null> {
      found = false
      const result = await autoUpdater.checkForUpdates()
      // null — electron-updater отключён (не собранное приложение): считаем, что новее нет.
      if (!result?.isUpdateAvailable) return null
      found = true
      const version = result.updateInfo.version
      return { version, releaseNotes: releaseNotesText(result.updateInfo.releaseNotes), releaseUrl: releasePageUrl(version) }
    },
    async download(onProgress): Promise<void> {
      if (!found) throw new Error('обновление не найдено: сначала нужна проверка')
      const onEvent = (p: { percent: number }): void => onProgress(p.percent)
      autoUpdater.on('download-progress', onEvent)
      try {
        // sha512 скачанного установщика electron-updater сверяет с latest.yml сам и бросает при несовпадении.
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.removeListener('download-progress', onEvent)
      }
    },
    async install(): Promise<void> {
      // isSilent: установка по уже выбранной папке без мастера; forceRunAfter: приложение запускается снова.
      autoUpdater.quitAndInstall(true, true)
    }
  }
}

function portableUpdater(currentVersion: string): PlatformUpdater {
  return {
    async check(): Promise<UpdateInfo | null> {
      return portableUpdateInfo(await fetchLatestRelease(fetch), currentVersion)
    },
    async download(): Promise<void> {
      throw new Error('portable-сборку нельзя обновить на месте: скачайте новый exe со страницы релиза')
    },
    async install(): Promise<void> {
      throw new Error('portable-сборку нельзя обновить на месте: скачайте новый exe со страницы релиза')
    }
  }
}
