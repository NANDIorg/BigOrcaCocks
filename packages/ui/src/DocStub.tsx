import { getUiApi } from './host'
import type React from 'react'
import type { DocView } from '../shared/ipc'
import { DocIcon } from './docsIcons'
import { docKindLabel, docStubInfo, type DocAction, type DocActions, type DocStubInfo } from './docView'
import type { DocViewFailure } from './docViewApi'
import { formatSize } from './docLinks'
import { longTime } from './docTree'
import { useT } from './i18n'

type StubIcon = keyof typeof DocIcon

interface Shown extends Omit<DocStubInfo, 'icon'> {
  icon: StubIcon
}

/** Ошибка как заглушка: ссылка наружу, не файл, файла нет, устаревшее приложение. */
function failureInfo(failure: DocViewFailure): Shown {
  switch (failure.kind) {
    case 'stale':
      return { icon: 'warn', tone: 'warn', title: failure.title, text: failure.message }
    case 'outside':
      return { icon: 'link', tone: 'danger', title: failure.title, text: failure.message }
    case 'missing':
      return { icon: 'file', tone: 'warn', title: failure.title, text: failure.message }
    default:
      return { icon: 'file', tone: 'danger', title: failure.title, text: failure.message }
  }
}

interface Props {
  path: string
  /** Заглушка `docs:view` (`stub`, а также PDF и бинарный вид). */
  view?: DocView
  /** Или ошибка, которую окно решило показать на месте просмотра, а не баннером. */
  failure?: DocViewFailure
  now: number
  actions: DocActions
  onAction(action: DocAction): void
  /** «Повторить» у ошибки (файл вернули, main перезапустили). */
  onRetry?(): void
}

/**
 * Заглушка вместо содержимого — обычный результат, а не ошибка: человек выбрал файл и видит «бинарный файл, 3,2 МБ».
 * Значок, заголовок, причина, чипы (тип, размер, время) и действия. «Открыть» — только у белого списка
 * (`actions.open`); у остальных — пояснение, почему кнопки нет. «Показать в папке» и «Копировать путь» — у всех.
 */
export function DocStub({ path, view, failure, now, actions, onAction, onRetry }: Props): React.JSX.Element | null {
  const t = useT()
  const fromView = view ? docStubInfo(view, path) : undefined
  const info: Shown | undefined = failure ? failureInfo(failure) : fromView
  if (!info) return null
  const stale = failure?.kind === 'stale'
  const chips = view && !failure ? [docKindLabel(path, view.kind), formatSize(view.size), view.mtime > 0 ? t('config.docs.view.modified', { when: longTime(view.mtime, now) }) : ''] : []
  const Ill = DocIcon[info.icon]
  return (
    <div className="docs-blank docs-stub" role={failure ? 'alert' : 'status'}>
      <div className="box">
        <div className={`ill tone-${info.tone}`}><Ill /></div>
        <h2>{info.title}</h2>
        <p>{info.text}</p>
        {chips.some(Boolean) && (
          <div className="meta">
            {chips.filter(Boolean).map((c) => <span key={c} className="docs-stub-chip">{c}</span>)}
          </div>
        )}
        {stale ? (
          <p className="hint">{t('config.docs.view.staleHint')}</p>
        ) : (
          <>
            <div className="acts">
              {actions.open && !failure && (
                <button type="button" className="btn-sm primary" onClick={() => onAction('open')}><DocIcon.external />{t('config.docs.view.openShort')}</button>
              )}
              {failure && onRetry && (
                <button type="button" className="btn-sm primary" onClick={onRetry}><DocIcon.refresh />{t('config.docs.view.retry')}</button>
              )}
              {actions.reveal && failure?.kind !== 'missing' && (
                <button type="button" className="btn-sm" onClick={() => onAction('reveal')}><DocIcon.reveal />{(getUiApi().app.environment === 'web' ? t('shell.web.download') : t('config.docs.view.reveal'))}</button>
              )}
              {actions.copy && (
                <button type="button" className="btn-sm" onClick={() => onAction('copy')}><DocIcon.copy />{t('config.docs.view.copyPath')}</button>
              )}
            </div>
            {view && !failure && !actions.open && <p className="hint">{t('config.docs.stub.noOpen')}</p>}
          </>
        )}
      </div>
    </div>
  )
}

/** Файл ещё грузится: скелет строк, подпись — для скринридера и долгой загрузки. */
export function DocLoading({ name }: { name: string }): React.JSX.Element {
  const t = useT()
  return (
    <div className="docs-blank docs-stub docs-loading" role="status" aria-live="polite">
      <div className="box">
        <div className="sv-skel" aria-hidden="true"><i style={{ width: '70%' }} /><i style={{ width: '88%' }} /><i style={{ width: '52%' }} /><i style={{ width: '64%' }} /></div>
        <p>{t('config.docs.view.loading', { name })}</p>
      </div>
    </div>
  )
}
