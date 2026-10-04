import type React from 'react'
import { useState } from 'react'
import type { WfNodeTemplate } from '@orca-board/core'
import { Icon, WfNodeIcon } from '../icons'
import { SectionHead } from '../about/parts'
import { useT } from '../i18n'
import { ipcErrorMessage } from '../ipcError'
import { renamedTemplateInput, templateHint, templateSummary, type NodeTemplatesHook } from '../nodeTemplates'

/**
 * «Настройки → Свои ноды»: список шаблонов библиотеки — переименовать (название и описание) и удалить. Содержимое
 * шаблона правят в редакторе воркфлоу: «Сохранить как свою ноду» / «Записать в шаблон» в инспекторе ноды.
 */
export function NodeTemplatesSection({ library }: { library: NodeTemplatesHook }): React.JSX.Element {
  const t = useT()
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function startEdit(tpl: WfNodeTemplate): void {
    setEditing(tpl.id)
    setTitle(tpl.title)
    setDescription(tpl.description ?? '')
    setError(null)
  }

  const rename = (tpl: WfNodeTemplate): Promise<void> =>
    act(async () => {
      await library.save(renamedTemplateInput(tpl, title, description))
      setEditing(null)
    })

  const remove = (tpl: WfNodeTemplate): Promise<void> => {
    if (!confirm(t('settings.nodeTpl.removeConfirm', { title: tpl.title }))) return Promise.resolve()
    return act(async () => {
      await library.remove(tpl.id)
      if (editing === tpl.id) setEditing(null)
    })
  }

  return (
    <>
      <SectionHead title={t('settings.nodeTpl.title')} hint={t('settings.nodeTpl.hint')} />
      {library.templates === null ? (
        <div className={library.error ? 'editor-error' : 'muted'}>{library.error ?? t('common.loading')}</div>
      ) : (
        <>
          <p className="hint">{t('settings.nodeTpl.howTo')}</p>
          {library.templates.length === 0 ? (
            <div className="muted">{t('settings.nodeTpl.empty')}</div>
          ) : (
            <ul className="tpl-list">
              {library.templates.map((tpl) => {
                const NodeIcon = WfNodeIcon[tpl.node.type]
                return (
                  <li key={tpl.id} className="tpl-row">
                    <span className={`wf-insp-icon wf-node--${tpl.node.type}`}><NodeIcon /></span>
                    {editing === tpl.id ? (
                      <form
                        className="tpl-row-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (title.trim()) void rename(tpl)
                        }}
                      >
                        <label className="wf-field">
                          <span>{t('settings.nodeTpl.name')}</span>
                          <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
                        </label>
                        <label className="wf-field">
                          <span>{t('settings.nodeTpl.description')}</span>
                          <input value={description} placeholder={t('settings.nodeTpl.descriptionPlaceholder')} onChange={(e) => setDescription(e.target.value)} />
                        </label>
                        <div className="tpl-row-actions">
                          <button type="submit" className="btn-sm primary" disabled={busy || !title.trim()}>{t('settings.nodeTpl.save')}</button>
                          <button type="button" className="btn-sm" disabled={busy} onClick={() => setEditing(null)}>{t('settings.nodeTpl.cancel')}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="tpl-row-main" title={templateHint(tpl)}>
                          <b>{tpl.title}</b>
                          {tpl.description && <small>{tpl.description}</small>}
                          <small>{templateSummary(tpl)}</small>
                        </div>
                        <div className="tpl-row-actions">
                          <button type="button" className="btn-sm" disabled={busy} onClick={() => startEdit(tpl)}>
                            <Icon.edit /> {t('settings.nodeTpl.rename')}
                          </button>
                          <button type="button" className="btn-sm danger" disabled={busy} onClick={() => void remove(tpl)}>
                            <Icon.trash /> {t('settings.nodeTpl.remove')}
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
