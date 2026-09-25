import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { DispatchShowcase } from '@orca-board/core'
import type { ShowcaseFileData } from '../../shared/ipc'
import { Markdown } from './Markdown'
import { autoPreviewPaths, showcaseApi, showcaseErrorText, showcaseFiles, type ShowcaseFileItem } from './showcase'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'

interface Props {
  /** Задача, из worktree которой main читает файлы (IPC showcase:*). */
  taskId: string
  showcase: DispatchShowcase
  /** Без рамки и заголовка: модалка задачи, где заголовок — у раздела. */
  bare?: boolean
}

const errorText = (e: unknown): string => showcaseErrorText(ipcErrorMessage(e))

/**
 * Показ человеку с ноды «Работа» (Dispatch.showcase): описание воркера и файлы из ветки задачи. Картинки —
 * превью по байтам из main (blob-URL: CSP renderer пускает только `blob:`), markdown — по кнопке через
 * Markdown.tsx, HTML и PDF — только «Открыть» приложением системы. Файлы не из белого списка — просто путь.
 */
export function ShowcaseBlock({ taskId, showcase, bare = false }: Props): React.JSX.Element {
  const t = useT()
  const items = useMemo(() => showcaseFiles(showcase.files), [showcase.files])
  const auto = useMemo(() => autoPreviewPaths(items), [items])
  return (
    <section className={`showcase${bare ? ' bare' : ''}`} aria-label={t('board.showcase.title')}>
      {!bare && <div className="showcase-head">{t('board.showcase.title')}</div>}
      {showcase.text && <Markdown text={showcase.text} className="showcase-md" />}
      {items.length > 0 && (
        <ul className="showcase-files">
          {items.map((f) => <ShowcaseFile key={f.path} taskId={taskId} file={f} autoPreview={auto.has(f.path)} />)}
        </ul>
      )}
    </section>
  )
}

function ShowcaseFile({ taskId, file, autoPreview }: { taskId: string; file: ShowcaseFileItem; autoPreview: boolean }): React.JSX.Element {
  const t = useT()
  const [shown, setShown] = useState(autoPreview)
  const [error, setError] = useState<string | null>(null)

  const act = (fn: (api: ReturnType<typeof showcaseApi>) => Promise<void>): void => {
    setError(null)
    try {
      fn(showcaseApi(window.orca)).catch((e: unknown) => setError(errorText(e)))
    } catch (e) {
      setError(errorText(e))
    }
  }
  const canOpen = file.view !== 'none'
  const canPreview = file.view === 'image' || file.view === 'markdown'

  return (
    <li className="showcase-file">
      <div className="showcase-file-head">
        <div className="showcase-file-title" title={file.path}>
          <span className="showcase-file-name">{file.name}</span>
          {file.name !== file.path && <span className="showcase-file-path">{file.path}</span>}
        </div>
        {canPreview && (
          <button className="btn-text" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
            {shown ? t('board.showcase.hide') : file.view === 'image' ? t('board.showcase.preview') : t('board.showcase.text')}
          </button>
        )}
        {canOpen && (
          <>
            <button className="btn-sm" onClick={() => act((api) => api.open(taskId, file.path))} title={t('board.showcase.openTitle')}>{t('board.showcase.open')}</button>
            <button className="btn-sm" onClick={() => act((api) => api.reveal(taskId, file.path))}>{t('board.showcase.reveal')}</button>
          </>
        )}
      </div>
      {!canOpen && <div className="muted showcase-note">{t('board.showcase.cantOpen')}</div>}
      {shown && file.view === 'image' && <ImagePreview taskId={taskId} file={file} onOpen={() => act((api) => api.open(taskId, file.path))} />}
      {shown && file.view === 'markdown' && <MarkdownPreview taskId={taskId} file={file} />}
      {error && <span className="error-text">{error}</span>}
    </li>
  )
}

/** Байты файла из main; ошибка — текстом. Повторный вызов при смене файла, ответ устаревшего запроса отбрасывается. */
function useShowcaseBytes(taskId: string, path: string): { data?: ShowcaseFileData; error?: string } {
  const [state, setState] = useState<{ data?: ShowcaseFileData; error?: string }>({})
  useEffect(() => {
    let alive = true
    setState({})
    try {
      showcaseApi(window.orca).read(taskId, path).then(
        (data) => alive && setState({ data }),
        (e: unknown) => alive && setState({ error: errorText(e) })
      )
    } catch (e) {
      setState({ error: errorText(e) })
    }
    return () => {
      alive = false
    }
  }, [taskId, path])
  return state
}

function ImagePreview({ taskId, file, onOpen }: { taskId: string; file: ShowcaseFileItem; onOpen(): void }): React.JSX.Element {
  const t = useT()
  const { data, error } = useShowcaseBytes(taskId, file.path)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data) return
    // Копия в свой ArrayBuffer: Blob не принимает view на SharedArrayBuffer (так типизирован Uint8Array из IPC).
    const u = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.mime }))
    setUrl(u)
    return () => {
      URL.revokeObjectURL(u)
      setUrl(null)
    }
  }, [data])
  if (error) return <span className="error-text">{error}</span>
  if (!url) return <div className="muted showcase-note">{t('common.loading')}</div>
  return (
    <button className="showcase-img" onClick={onOpen} title={t('board.showcase.fullSize')}>
      <img src={url} alt={file.name} />
    </button>
  )
}

function MarkdownPreview({ taskId, file }: { taskId: string; file: ShowcaseFileItem }): React.JSX.Element {
  const t = useT()
  const { data, error } = useShowcaseBytes(taskId, file.path)
  const text = useMemo(() => (data ? new TextDecoder().decode(data.bytes) : null), [data])
  if (error) return <span className="error-text">{error}</span>
  if (text === null) return <div className="muted showcase-note">{t('common.loading')}</div>
  return <Markdown text={text} className="showcase-md showcase-file-md" />
}
