// Логика просмотра приложенных изображений (ImageAttachments + ImageLightbox) без DOM и React — под тестом.

/** Миниатюра: `url` нет — ещё грузится (или `failed`). */
export interface ViewerThumb {
  key: string
  url?: string
  failed?: boolean
}

/** Класс корня оверлея: по нему модалки узнают, что Esc сейчас принадлежит просмотру. */
export const LIGHTBOX_CLASS = 'lightbox'

/**
 * Что показать в просмотре по клику на миниатюру `key`: только загрузившиеся картинки, индекс — среди них.
 * Ключ, а не индекс миниатюры: открытый просмотр переживает удаление соседней картинки. `null` — показывать нечего.
 */
export function viewerItems(items: readonly ViewerThumb[], key: string | null): { urls: string[]; keys: string[]; index: number } | null {
  if (key === null) return null
  const loaded = items.filter((i): i is ViewerThumb & { url: string } => !!i.url && !i.failed)
  const index = loaded.findIndex((i) => i.key === key)
  if (index < 0) return null
  return { urls: loaded.map((i) => i.url), keys: loaded.map((i) => i.key), index }
}

export type ViewerKeyAction = { kind: 'close' } | { kind: 'go'; index: number } | { kind: 'swallow' } | { kind: 'pass' }

/**
 * Реакция просмотра на клавишу. Всё, кроме Tab, поглощается: иначе цифры, G, M, S и стрелки сработают
 * в доске или вкладках под оверлеем. Стрелка на краю списка — тоже `swallow`, не `pass`.
 */
export function viewerKeyAction(key: string, at: number, last: number): ViewerKeyAction {
  if (key === 'Escape') return { kind: 'close' }
  if (key === 'ArrowLeft') return at > 0 ? { kind: 'go', index: at - 1 } : { kind: 'swallow' }
  if (key === 'ArrowRight') return at < last ? { kind: 'go', index: at + 1 } : { kind: 'swallow' }
  if (key === 'Tab') return { kind: 'pass' }
  return { kind: 'swallow' }
}

/**
 * Открыт ли просмотр. Модалки со своим Esc на `window` (capture) спрашивают это перед закрытием: слушатели одного
 * `window` вызываются в порядке регистрации, и модалка, подписавшаяся раньше, иначе закрылась бы вместе с просмотром.
 */
export function lightboxOpen(root: { querySelector(selector: string): unknown } = document): boolean {
  return root.querySelector(`.${LIGHTBOX_CLASS}`) !== null
}
