import { useEffect, useReducer, useRef, useState } from 'react'
import type { RunImage } from '@orca-board/core'
import { runImagesApi } from './runImages'
import { ipcErrorMessage } from './useAutoSave'

export interface RunImageUrls {
  /** `blob:` URL по id картинки; пока байты не пришли — нет записи. */
  urls: ReadonlyMap<string, string>
  /** id картинок, которые не удалось прочитать. */
  failed: ReadonlySet<string>
  /** Первая ошибка чтения (в том числе «перезапустите приложение»). */
  error: string | null
}

/**
 * Превью сохранённых картинок глобальной задачи: байты по `globalTasks.image` → `blob:` URL (CSP `img-src 'self' blob:`).
 * URL освобождаются, когда картинка исчезла из списка или компонент размонтирован. Компонент с этим хуком
 * должен иметь `key` по id задачи — при смене задачи картинки берутся заново.
 */
export function useRunImageUrls(globalId: string, images: readonly RunImage[] | undefined): RunImageUrls {
  const urls = useRef(new Map<string, string>())
  const failed = useRef(new Set<string>())
  const pending = useRef(new Set<string>())
  const wanted = useRef(new Set<string>())
  const alive = useRef(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [error, setError] = useState<string | null>(null)
  const list = images ?? []
  wanted.current = new Set(list.map((i) => i.id))
  const key = list.map((i) => i.id).join(',')

  useEffect(() => {
    alive.current = true
    for (const [id, url] of urls.current) {
      if (wanted.current.has(id)) continue
      URL.revokeObjectURL(url)
      urls.current.delete(id)
    }
    for (const img of list) {
      if (urls.current.has(img.id) || failed.current.has(img.id) || pending.current.has(img.id)) continue
      pending.current.add(img.id)
      void (async () => {
        try {
          const { mime, data } = await runImagesApi(window.orca).image(globalId, img.id)
          const url = URL.createObjectURL(new Blob([data.slice()], { type: mime }))
          if (alive.current && wanted.current.has(img.id)) urls.current.set(img.id, url)
          else URL.revokeObjectURL(url)
        } catch (e) {
          failed.current.add(img.id)
          if (alive.current) setError((prev) => prev ?? ipcErrorMessage(e))
        } finally {
          pending.current.delete(img.id)
          if (alive.current) rerender()
        }
      })()
    }
    // list и globalId определяются key: тот же набор id — те же картинки.
  }, [globalId, key])

  useEffect(() => {
    return () => {
      alive.current = false
      for (const url of urls.current.values()) URL.revokeObjectURL(url)
      urls.current.clear()
    }
  }, [])

  return { urls: urls.current, failed: failed.current, error }
}
