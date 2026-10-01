import type React from 'react'
import { useEffect, useRef } from 'react'
import { useBlobUrl } from './ShowcaseViewer'
import { DocLoading, DocStub } from './DocStub'
import { useDocBytes } from './docViewApi'
import type { DocAction, DocActions, DocZoom } from './docView'
import { useT } from './i18n'

interface Props {
  source: string
  path: string
  name: string
  zoom: DocZoom
  reload: number
  now: number
  actions: DocActions
  onAction(action: DocAction): void
  onRetry?(): void
  /** Натуральный размер, когда картинка загрузилась (строка статуса); новый файл — сначала undefined. */
  onDims?(dims: { width: number; height: number } | undefined): void
}

/**
 * Картинка проекта: байты из `docs:bytes` (≤ `DOC_IMAGE_MAX_BYTES`) → `blob:` в `<img>`. SVG — тоже `<img>`: скрипты
 * внутри картинки не исполняются. «Вписать» — по размеру области, «100 %» — натуральный размер с прокруткой;
 * шахматный фон показывает прозрачность.
 */
export function DocImage({ source, path, name, zoom, reload, now, actions, onAction, onRetry, onDims }: Props): React.JSX.Element {
  const t = useT()
  const { data, failure } = useDocBytes(source, path, reload)
  const url = useBlobUrl(data)
  // Свежий колбэк без перезапуска эффекта: родитель может передать новую стрелку на каждый рендер.
  const dimsRef = useRef(onDims)
  dimsRef.current = onDims
  useEffect(() => dimsRef.current?.(undefined), [source, path, reload])
  if (failure) return <DocStub path={path} failure={failure} now={now} actions={actions} onAction={onAction} onRetry={onRetry} />
  if (!url) return <DocLoading name={name} />
  return (
    <div className={`docs-img ${zoom}`} tabIndex={0} role="region" aria-label={t('config.docs.view.imageAria', { name })}>
      <img
        src={url}
        alt={name}
        draggable={false}
        onLoad={(e) => dimsRef.current?.({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      />
    </div>
  )
}
