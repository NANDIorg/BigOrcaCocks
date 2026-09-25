import { Tray, Menu, nativeImage, type NativeImage } from 'electron'
import { deflateSync } from 'node:zlib'
import { mt } from './i18n'

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
 * Монохромная иконка «orca»: кольцо с плавником. Рисуется программно (16px и 32px для Retina),
 * чтобы не тащить ресурсы в сборку. На macOS — template: система сама красит её под тему строки меню.
 */
function trayIcon(): NativeImage {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: encodePng(16, drawIcon(16)) })
  image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: encodePng(32, drawIcon(32)) })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

/** RGBA-пиксели: чёрный цвет, форма в альфа-канале; сглаживание — суперсэмплингом 4×4. */
function drawIcon(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4)
  const k = size / 16
  const cx = 8 * k
  const cy = 9 * k
  const outer = 6 * k
  const inner = 3.6 * k
  const inside = (x: number, y: number): boolean => {
    const d = Math.hypot(x - cx, y - cy)
    if (d <= outer && d >= inner) return true
    // Плавник: треугольник над кольцом, наклонён назад.
    return inTriangle(x, y, 7 * k, 3.5 * k, 10.5 * k, 3.5 * k, 8.5 * k, 0.5 * k)
  }
  const ss = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) if (inside(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) hit++
      px[(y * size + x) * 4 + 3] = Math.round((hit / (ss * ss)) * 255)
    }
  }
  return px
}

function inTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const s = (x1: number, y1: number, x2: number, y2: number): number => (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
  const d1 = s(ax, ay, bx, by)
  const d2 = s(bx, by, cx, cy)
  const d3 = s(cx, cy, ax, ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/** Минимальный PNG-энкодер: RGBA 8 бит, без фильтров, IDAT через zlib. */
function encodePng(size: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // глубина
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
