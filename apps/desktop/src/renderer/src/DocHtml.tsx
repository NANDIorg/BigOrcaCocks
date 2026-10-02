import type React from 'react'
import { CodeView } from './CodeView'
import { PreviewFrame } from './PreviewFrame'
import { DocLoading, DocStub } from './DocStub'
import { DocIcon } from './docsIcons'
import { useDocPreviewUrl, type DocLoad } from './docViewApi'
import type { DocAction, DocActions } from './docView'
import { SHOWCASE_VIEWPORTS } from './showcase'
import { useT } from './i18n'

interface Props {
  source: string
  path: string
  name: string
  /** «Код» — по умолчанию: сайт на Vite/Next в изолированном фрейме пуст (`/src/main.tsx` фрейму недоступен). */
  mode: 'code' | 'preview'
  /** Исходник для «Кода» (`useDocSourceText`). */
  code: DocLoad<string>
  /** Новое значение — превью получает свежий адрес и страница грузится заново («Обновить превью»). */
  reload: number
  now: number
  actions: DocActions
  onAction(action: DocAction): void
  onRetry?(): void
  codeRef?: React.Ref<HTMLElement>
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?(e: React.UIEvent<HTMLDivElement>): void
}

/**
 * HTML-файл проекта: «Код» — `CodeView`, «Превью» — страница в `PreviewFrame` (`sandbox="allow-scripts"`, без
 * `allow-same-origin`) по адресу `docs:previewUrl`, **всегда без сети**: HTML проекта — недоверенный код, а корень
 * источника — живой worktree, не снимок. Баннер говорит, почему страница может быть пустой. Адрес превью
 * запрашивается, только когда человек выбрал «Превью».
 */
export function DocHtml(props: Props): React.JSX.Element {
  const { path, name, mode, code, now, actions, onAction, onRetry } = props
  if (mode === 'preview') return <HtmlPreview {...props} />
  if (code.failure) return <DocStub path={path} failure={code.failure} now={now} actions={actions} onAction={onAction} onRetry={onRetry} />
  if (code.data === undefined) return <DocLoading name={name} />
  return <CodeView text={code.data} name={name} path={path} codeRef={props.codeRef} scrollRef={props.scrollRef} onScroll={props.onScroll} />
}

function HtmlPreview({ source, path, name, reload, now, actions, onAction, onRetry }: Props): React.JSX.Element {
  const t = useT()
  const { data, failure } = useDocPreviewUrl(source, path, reload)
  if (failure) return <DocStub path={path} failure={failure} now={now} actions={actions} onAction={onAction} onRetry={onRetry} />
  if (!data) return <DocLoading name={name} />
  return (
    <div className="docs-html">
      <div className="banner" role="note">
        <DocIcon.lock />
        <span className="grow"><b>{t('config.docs.view.isolatedBanner')}</b> {t('config.docs.view.isolatedHint')}</span>
      </div>
      <div className="frame-wrap">
        <PreviewFrame url={data.url} title={t('config.docs.view.frameTitle', { name })} viewport={SHOWCASE_VIEWPORTS.desktop} device="desktop" reload={reload} />
      </div>
    </div>
  )
}
