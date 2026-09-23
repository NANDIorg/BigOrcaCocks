import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { TEMPLATE_SECTIONS, TEMPLATE_SECTION_TITLES, type Task, type TemplateSection } from '@orca-board/core'
import type { Project, TemplatesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { applyPreview, type ApplyRequest } from '../projectType'
import { ApplyConsequences } from '../ApplyConsequences'

interface Props {
  project: Project
  state: TemplatesState
  tasks: Task[]
  /** type — «Сменить тип…»: шаблон и разделы выбираются; take — «Взять из шаблона» у строки отличий, всё задано. */
  mode: 'type' | 'take'
  initial: ApplyRequest
  onClose(): void
  /** Применить; ошибка main остаётся в модалке. */
  onApply(req: ApplyRequest): Promise<void>
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Подтверждение применения шаблона: что исчезнет (колонки → бэклог, роли → задачи без роли) и ошибки графа — до клика. */
export function ApplyTemplateModal({ project, state, tasks, mode, initial, onClose, onApply }: Props): React.JSX.Element {
  const [templateId, setTemplateId] = useState(initial.templateId)
  const [sections, setSections] = useState<TemplateSection[]>(initial.sections)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const template = state.templates.find((t) => t.id === templateId)
  const req: ApplyRequest = { templateId, sections, ...(initial.roleIds ? { roleIds: initial.roleIds } : {}) }
  const preview = template && sections.length ? applyPreview(project, template.settings, req, tasks) : null
  const canApply = !busy && preview !== null && preview.error === null

  function toggle(s: TemplateSection, on: boolean): void {
    setSections((cur) => TEMPLATE_SECTIONS.filter((x) => (x === s ? on : cur.includes(x))))
  }

  async function submit(): Promise<void> {
    if (busyRef.current || !canApply) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onApply(req)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const roleTitle = (id: string): string =>
    template?.settings.roles?.find((r) => r.id === id)?.title ?? project.roles?.find((r) => r.id === id)?.title ?? id
  const what = initial.roleIds
    ? initial.roleIds.map((id) => `роль «${roleTitle(id)}»`).join(', ')
    : sections.map((s) => TEMPLATE_SECTION_TITLES[s]).join(', ')

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal tpl-apply" role="dialog" aria-modal="true" aria-label="Применить шаблон" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'type' ? 'Сменить тип проекта' : `Взять из шаблона «${template?.title ?? templateId}»`}</h3>
        <p className="muted modal-sub" title={project.name}>
          {mode === 'type' ? project.name : `${project.name}: ${what}`}
        </p>

        {mode === 'type' && (
          <>
            <label>
              Шаблон
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {state.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}{t.builtin ? ' · встроенный' : ''}{t.id === state.defaultTemplateId ? ' · по умолчанию' : ''}
                  </option>
                ))}
              </select>
            </label>
            {template?.description && <span className="muted tpl-desc">{template.description}</span>}
            <fieldset className="tpl-sections">
              <legend className="muted">Что взять из шаблона</legend>
              {TEMPLATE_SECTIONS.map((s) => (
                <label key={s} className="tpl-check">
                  <input type="checkbox" checked={sections.includes(s)} onChange={(e) => toggle(s, e.target.checked)} />
                  {cap(TEMPLATE_SECTION_TITLES[s])}
                </label>
              ))}
            </fieldset>
          </>
        )}

        {preview && <ApplyConsequences preview={preview} typeTitle={mode === 'type' ? (template?.title ?? templateId) : undefined} />}
        {mode === 'type' && !sections.length && <span className="muted">Выберите хотя бы один раздел.</span>}
        {error && <span className="error-text">{error}</span>}

        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button className="btn-primary" disabled={!canApply} onClick={() => void submit()}>
            {busy ? 'Применяю…' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  )
}
