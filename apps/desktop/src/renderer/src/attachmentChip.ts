import { attachmentDisplayName, sanitizeAttachmentName, type AttachmentKind } from '@orca-board/core'
import { attachmentOpenable } from '../../shared/showcase'
import { t } from './i18n'
import { formatBytes } from './i18n/format'

/**
 * Модель чипа вложения без React: что показать на плитке картинки или карточке файла. Общая для вложений формы
 * (`attachmentDrafts`) и сохранённых у глобальной задачи (`RunImage`).
 */
export interface AttachmentChip {
  kind: AttachmentKind
  /** Бейдж расширения: «PDF», «LOG»; без расширения — «файл». */
  extLabel: string
  /** Полное имя для `title` и подписей доступности; нет имени — «без имени». */
  name: string
  /** Имя с обрезкой посередине: расширение и конец имени видны всегда. */
  shortName: string
  /** Размер на языке интерфейса: «1,2 МБ». */
  size: string
  /**
   * Можно ли предложить «Открыть» приложением системы: только расширения из белого списка показа
   * (`SHOWCASE_FILE_TYPES`) без HTML и SVG — запускать произвольный файл (`.sh`, `.app`) нельзя, а HTML и SVG из
   * вложения открылись бы в браузере со скриптами. Остальным — только «Показать в папке».
   */
  openable: boolean
}

/** Длина подписи имени в чипе по умолчанию: карточка файла узкая, полное имя — в `title`. */
export const CHIP_NAME_MAX = 28

/** Расширения, которые можно открыть кнопкой «Открыть» — тот же список, что проверяет main (`attachmentOpenable`). */
export function isOpenableExt(ext: string): boolean {
  return attachmentOpenable(ext)
}

/**
 * Обрезка посередине по символам (не по UTF-16): «очень-длинный-отчёт.pdf» → «очень-дл…отчёт.pdf».
 * Хвост чуть длиннее головы — в нём расширение и обычно номер версии.
 */
export function truncateMiddle(s: string, max: number): string {
  const chars = Array.from(s)
  if (chars.length <= max) return s
  if (max <= 1) return '…'
  const keep = max - 1
  const head = Math.floor(keep / 2)
  const tail = keep - head
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

/**
 * Чип по вложению: `ext` — сохранённое main (`RunImage.ext`); нет — берётся из имени так же, как его возьмёт main
 * (`sanitizeAttachmentName`). Нет `kind` — картинка (записи до вложений-файлов).
 */
export function attachmentChip(x: { kind?: AttachmentKind; name?: string; ext?: string; bytes: number }, max = CHIP_NAME_MAX): AttachmentChip {
  const name = attachmentDisplayName(x.name) || t('common.attach.unnamed')
  const ext = (x.ext ?? sanitizeAttachmentName(x.name).ext).toLowerCase()
  return {
    kind: x.kind ?? 'image',
    extLabel: ext ? ext.toUpperCase() : t('common.attach.noExt'),
    name,
    shortName: truncateMiddle(name, max),
    size: formatBytes(x.bytes),
    openable: ext !== '' && isOpenableExt(ext)
  }
}
