import type React from 'react'
import { useState } from 'react'
import type { AttachmentKind } from '@orca-board/core'
import { useT } from './i18n'
import { Icon } from './icons'
import { ImageLightbox } from './ImageLightbox'
import { viewerItems, type ViewerThumb } from './imageViewer'
import { attachmentChip } from './attachmentChip'

/** Сколько символов имени влезает в карточку файла (232 px, 13 px) и в тесную (184 px, 12 px). */
const CHIP_NAME_CARD = 20
const CHIP_NAME_COMPACT = 16

/**
 * Одно вложение в ряду. Картинка — миниатюра (`url` нет — ещё грузится или `failed`), файл — карточка с бейджем
 * расширения, именем и размером (`attachmentChip`). `ext` — сохранённое main; нет — берётся из `name`.
 */
export interface AttachmentTile extends ViewerThumb {
  kind: AttachmentKind
  name?: string
  ext?: string
  bytes: number
}

interface Props {
  items: AttachmentTile[]
  /** Сколько файлов ещё читается — плитка-заглушка в конце ряда. */
  reading?: number
  /** Убрать вложение; нет — ряд только для просмотра. */
  onRemove?(key: string): void
  /** «Показать в папке» у карточки файла — только у сохранённых вложений (у черновика формы файла на диске ещё нет). */
  onReveal?(key: string): void
  /** «Открыть» приложением системы — только у файлов из белого списка (`AttachmentChip.openable`). */
  onOpen?(key: string): void
  disabled?: boolean
  /** Тесное место (карточка запроса, лента): 48 px вместо 72, у файла — одна строка без размера. */
  compact?: boolean
}

/**
 * Ряд вложений: миниатюры картинок (клик — на весь экран, `ImageLightbox`) и карточки файлов. Общий для всех мест
 * с вложениями: поле формы (`AttachmentField`), сохранённые вложения задачи (`RunImageGallery`). Открытую картинку
 * помним по ключу — просмотр переживает удаление соседней. Файл приложение не показывает и не запускает: только
 * «Показать в папке» и «Открыть» для белого списка.
 */
export function AttachmentList({ items, reading = 0, onRemove, onReveal, onOpen, disabled = false, compact = false }: Props): React.JSX.Element | null {
  const t = useT()
  const [openKey, setOpenKey] = useState<string | null>(null)
  if (items.length === 0 && reading === 0) return null
  // Лайтбокс листает только картинки: у карточек файлов нет `url`.
  const viewer = viewerItems(items, openKey)
  let imageN = 0
  return (
    <div className={compact ? 'attach-images compact' : 'attach-images'}>
      {items.map((it) => {
        if (it.kind === 'image') {
          const n = ++imageN
          return (
            <div key={it.key} className="attach-image">
              {it.url && !it.failed ? (
                <button
                  type="button"
                  className="attach-image-open"
                  title={t('common.image.open', { n })}
                  aria-label={t('common.image.open', { n })}
                  onClick={(e) => {
                    // Карточка запроса кликабельна целиком — клик по миниатюре не должен её выбирать.
                    e.stopPropagation()
                    setOpenKey(it.key)
                  }}
                >
                  <img src={it.url} alt={t('common.image.alt', { n })} decoding="async" />
                </button>
              ) : (
                <div className="attach-image-loading" role="img" aria-label={t('common.image.alt', { n })} title={it.failed ? t('common.image.loadFailed') : undefined}>
                  {it.failed ? '!' : '…'}
                </div>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="attach-image-remove"
                  title={t('common.image.remove')}
                  aria-label={t('common.image.removeN', { n })}
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(it.key)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        }
        // Подпись под ширину карточки: обрезка посередине должна уложиться целиком, без второго «…» от CSS.
        const chip = attachmentChip(it, compact ? CHIP_NAME_COMPACT : CHIP_NAME_CARD)
        const label = `${chip.name} · ${chip.size}`
        return (
          <div key={it.key} className="attach-file" role="group" aria-label={label} title={label}>
            <span className="attach-file-icon" aria-hidden="true">
              <Icon.doc />
              <span className="attach-file-ext">{chip.extLabel}</span>
            </span>
            <span className="attach-file-body">
              <span className="attach-file-name">{chip.shortName}</span>
              {!compact && <span className="attach-file-size">{chip.size}</span>}
            </span>
            {(onOpen && chip.openable) || onReveal || onRemove ? (
              <span className="attach-file-actions">
                {onOpen && chip.openable && (
                  <button
                    type="button"
                    className="attach-file-btn"
                    title={t('common.attach.open', { name: chip.name })}
                    aria-label={t('common.attach.open', { name: chip.name })}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpen(it.key)
                    }}
                  >
                    <Icon.external />
                  </button>
                )}
                {onReveal && (
                  <button
                    type="button"
                    className="attach-file-btn"
                    title={t('common.attach.reveal')}
                    aria-label={t('common.attach.revealN', { name: chip.name })}
                    onClick={(e) => {
                      e.stopPropagation()
                      onReveal(it.key)
                    }}
                  >
                    <Icon.folder />
                  </button>
                )}
                {onRemove && (
                  <button
                    type="button"
                    className="attach-file-btn attach-file-remove"
                    title={t('common.attach.remove', { name: chip.name })}
                    aria-label={t('common.attach.remove', { name: chip.name })}
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(it.key)
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ) : null}
          </div>
        )
      })}
      {reading > 0 && (
        <div className="attach-image">
          <div className="attach-image-loading" role="status" aria-label={t('common.attach.reading')}>…</div>
        </div>
      )}
      {viewer && <ImageLightbox urls={viewer.urls} index={viewer.index} onIndex={(j) => setOpenKey(viewer.keys[j] ?? null)} onClose={() => setOpenKey(null)} />}
    </div>
  )
}
