import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fitFrame, isPreviewUrl, showcaseFailure, showcasePreviewApi, type FrameFit, type FrameViewport, type ShowcaseFailure } from './showcase'
import { t } from './i18n'

/** Адрес страницы показа: пока нет — загрузка, ошибка — состояние просмотрщика. */
export interface PreviewUrlState {
  url?: string
  failure?: ShowcaseFailure
}

/**
 * Адрес `orca-preview://` файла показа (IPC `showcase:previewUrl`). Запрашивается только когда компонент смонтирован —
 * то есть человек нажал «Превью» или открыл просмотрщик. `reload` — новый запрос (кнопка «Обновить», «Повторить»).
 * Ответ проверяется `isPreviewUrl`: чужой адрес во фрейм не ставится.
 */
export function usePreviewUrl(dispatchId: string, path: string, network: boolean, reload: number): PreviewUrlState {
  const [state, setState] = useState<PreviewUrlState>({})
  useEffect(() => {
    let alive = true
    setState({})
    try {
      showcasePreviewApi(window.orca)(dispatchId, path, { network }).then(
        (res) => {
          if (!alive) return
          if (isPreviewUrl(res?.url)) setState({ url: res.url })
          else setState({ failure: { kind: 'error', message: t('board.showcase.viewer.badUrl') } })
        },
        (e: unknown) => alive && setState({ failure: showcaseFailure(e) })
      )
    } catch (e) {
      setState({ failure: showcaseFailure(e) })
    }
    return () => {
      alive = false
    }
  }, [dispatchId, path, network, reload])
  return state
}

interface Props {
  /** Уже проверенный `isPreviewUrl` адрес; на всякий случай проверяется ещё раз. */
  url: string
  title: string
  viewport: FrameViewport
  /** Класс рамки: `desktop` / `tablet` / `mobile` (рамка устройства) или `inline` (карточка). */
  device: string
  /** Новое значение — фрейм пересоздаётся и страница грузится заново. */
  reload: number
  onFit?(fit: FrameFit): void
}

/**
 * Страница агента в изолированном фрейме: `sandbox="allow-scripts"` без `allow-same-origin` (opaque origin — нет доступа
 * к DOM и `window.orca` приложения), без попапов, форм и навигации верхнего уровня; сеть и чужие файлы закрывает CSP
 * ответа протокола `orca-preview://` (main/preview-protocol.ts), уход фрейма на другой адрес — `will-frame-navigate` в main.
 * Страница видит ширину `viewport.width` и вписывается в место масштабом. Единственное место с `<iframe>` показа —
 * заменить его на `<webview>` можно здесь, не трогая протокол и снимок.
 */
export function PreviewFrame({ url, title, viewport, device, reload, onFit }: Props): React.JSX.Element | null {
  const hostRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<FrameFit | null>(null)
  const [loaded, setLoaded] = useState(false)
  const onFitRef = useRef(onFit)
  onFitRef.current = onFit

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      const next = fitFrame(viewport, host.clientWidth, host.clientHeight)
      setFit(next)
      onFitRef.current?.(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [viewport])

  useEffect(() => setLoaded(false), [url, reload])

  if (!isPreviewUrl(url)) return null
  return (
    <div ref={hostRef} className="pf-host">
      {fit && (
        <div className={`sv-dev ${device}${loaded ? '' : ' loading'}`} style={{ width: fit.outerWidth, height: fit.outerHeight }}>
          <iframe
            key={`${url}#${reload}`}
            src={url}
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            style={{ width: fit.frameWidth, height: fit.frameHeight, transform: `scale(${fit.scale})` }}
          />
        </div>
      )}
    </div>
  )
}
