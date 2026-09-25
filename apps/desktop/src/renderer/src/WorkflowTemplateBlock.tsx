import type React from 'react'
import { useState } from 'react'
import type { WfNode, Workflow } from '@orca-board/core'
import { useT } from './i18n'
import { formatDateTime } from './i18n/format'
import {
  applyTemplate, defaultTemplateTitle, linkTemplate, templateInput, templateMisfit, templateSync, type NodeTemplatesHook
} from './nodeTemplates'
import type { WfScope } from './workflowNav'
import { ipcErrorMessage } from './ipcError'

interface Props {
  node: WfNode
  workflow: Workflow
  onChange(wf: Workflow): void
  library: NodeTemplatesHook
  scope: WfScope
}

/**
 * «Своя нода» в инспекторе: сохранить выбранную ноду в библиотеку и держать связь с шаблоном. Нода, вставленная из
 * шаблона, сверяется с ним: разошлись — «Обновить из шаблона» (или «Записать в шаблон» в обратную сторону).
 * Компонент монтируется с `key` по id ноды: введённое название и сообщения не переходят на другую ноду.
 */
export function WorkflowTemplateBlock({ node, workflow, onChange, library, scope }: Props): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const sync = templateSync(node, library.templates)

  async function run(action: () => Promise<string | null>): Promise<void> {
    setBusy(true)
    try {
      setNotice(await action())
      setError(null)
    } catch (e) {
      setNotice(null)
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveNew = (): Promise<void> =>
    run(async () => {
      const title = name.trim() || defaultTemplateTitle(node)
      const saved = await library.save(templateInput(node, title))
      onChange(linkTemplate(workflow, node.id, saved.id))
      setName('')
      return t('config.nodeTpl.insp.saved', { title: saved.title })
    })

  const overwrite = (id: string, title: string, description: string | undefined): Promise<void> => {
    if (!confirm(t('config.nodeTpl.insp.overwriteConfirm', { title }))) return Promise.resolve()
    return run(async () => {
      await library.save(templateInput(node, title, description, id))
      return t('config.nodeTpl.insp.overwritten', { title })
    })
  }

  const blocked = sync.kind === 'differs' ? templateMisfit(sync.template, scope) : null

  return (
    <fieldset className="wf-tpl">
      <legend>{t('config.nodeTpl.insp.legend')}</legend>

      {sync.kind === 'unknown' && <p className="hint">{t('config.nodeTpl.insp.unknown')}</p>}
      {sync.kind === 'missing' && <p className="hint">{t('config.nodeTpl.insp.missing')}</p>}
      {sync.kind === 'same' && <p className="hint">{t('config.nodeTpl.insp.same', { title: sync.template.title })}</p>}
      {sync.kind === 'differs' && (
        <>
          <p className="hint">
            {t('config.nodeTpl.insp.differs', { title: sync.template.title, date: formatDateTime(sync.template.updatedAt) })}
          </p>
          {blocked !== null && <p className="hint">{t('config.nodeTpl.insp.blocked', { reason: blocked })}</p>}
          <div className="wf-tpl-actions">
            <button
              type="button"
              className="btn-sm"
              disabled={busy || blocked !== null || node.type === 'start'}
              onClick={() => {
                onChange(applyTemplate(workflow, node.id, sync.template))
                setNotice(t('config.nodeTpl.insp.updated', { title: sync.template.title }))
                setError(null)
              }}
            >
              {t('config.nodeTpl.insp.update')}
            </button>
            <button
              type="button"
              className="btn-sm"
              disabled={busy}
              title={t('config.nodeTpl.insp.overwriteHint')}
              onClick={() => void overwrite(sync.template.id, sync.template.title, sync.template.description)}
            >
              {t('config.nodeTpl.insp.overwrite')}
            </button>
          </div>
        </>
      )}

      {node.type !== 'start' && !library.stale && (
        <>
          <label className="wf-field">
            <span>{t('config.nodeTpl.insp.nameLabel')}</span>
            <input value={name} placeholder={defaultTemplateTitle(node)} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="wf-tpl-actions">
            <button type="button" className="btn-sm" disabled={busy} onClick={() => void saveNew()}>
              {t('config.nodeTpl.insp.save')}
            </button>
          </div>
        </>
      )}
      {library.stale && <p className="hint">{library.error}</p>}
      {error && <div className="editor-error">{error}</div>}
      {notice && !error && <div className="hint">{notice}</div>}
    </fieldset>
  )
}
