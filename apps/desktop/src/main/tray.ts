import { Tray, Menu, nativeImage, type NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { mt } from './i18n'
import templatePath from '../../build/tray/orcaTemplate.png?asset'
import templateRetinaPath from '../../build/tray/orcaTemplate@2x.png?asset'
import windowsIconPath from '../../build/tray/orca-color.ico?asset'
import colorIconPath from '../../build/tray/orca-color.png?asset'

export interface TrayHandlers {
  /** Показать окно (создать, если закрыто). */
  open(): void
  /** Выход через подтверждение. */
  quit(): void
  /** Число задач в работе для пункта меню. */
  activeCount(): number
  /** Версия скачанного обновления, готового к установке; null — пункта «Перезапустить и обновить» нет. */
  readyUpdate(): string | null
  /** «Перезапустить и обновить»: установка с обычным подтверждением, если работают агенты. */
  installUpdate(): void
}

// Модульная ссылка: без неё GC соберёт Tray, и иконка пропадёт из строки меню.
let tray: Tray | null = null
let handlers: TrayHandlers | null = null

/** Иконка в строке меню (macOS) / трее (Windows, Linux). Вызывать один раз после whenReady. */
export function createTray(h: TrayHandlers): Tray {
  handlers = h
  tray = new Tray(trayIcon())
  tray.setToolTip('orca-board')
  // На macOS клик по иконке открывает контекстное меню сам; на Windows/Linux клик — показать окно.
  if (process.platform !== 'darwin') tray.on('click', () => h.open())
  refreshTray()
  return tray
}

/** Пересобрать меню (число задач в работе, язык интерфейса — зовётся и после смены языка). */
export function refreshTray(): void {
  if (!tray || tray.isDestroyed() || !handlers) return
  const h = handlers
  const update = h.readyUpdate()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: mt('tray.open'), click: () => h.open() },
      { label: mt('tray.active', { count: h.activeCount() }), enabled: false },
      ...(update ? [{ label: mt('tray.restartUpdate', { version: update }), click: () => h.installUpdate() }] : []),
      { type: 'separator' },
      { label: mt('tray.quit'), click: () => h.quit() }
    ])
  )
}

/**
 * Варианты авторского логотипа: маска 18/36 px для macOS, цветной ICO с размерами
 * под DPI Windows и PNG для Linux. ?asset включает файлы в main-сборку.
 */
function trayIcon(): NativeImage | string {
  if (process.platform === 'win32') return windowsIconPath
  if (process.platform !== 'darwin') return nativeImage.createFromPath(colorIconPath)

  // Сборщик хеширует имена: задаём Retina и template явно, не полагаясь на суффиксы файлов.
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, buffer: readFileSync(templatePath) })
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(templateRetinaPath) })
  image.setTemplateImage(true)
  return image
}
