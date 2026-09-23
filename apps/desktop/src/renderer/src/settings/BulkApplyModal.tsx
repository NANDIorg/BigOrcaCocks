import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TEMPLATE_SECTIONS, TEMPLATE_SECTION_TITLES, type ProjectTemplate, type TemplateSection } from '@orca-board/core'
import type { TaskRef, TemplatesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { ApplyConsequences } from '../ApplyConsequences'
import { TEMPLATES_STALE_MESSAGE, isStaleTemplatesError, templatesApi, type ApplyPreview } from '../projectType'
import {
  applicableIds, applyEach, bulkPreview, initialSelection, resultsText, taskRefsApi, type BulkCandidate, type BulkResults
} from '../bulkApply'

interface Props {
  template: ProjectTemplate
  state: TemplatesState
  /** Все проекты против шаблона (`bulkCandidates`); пересчитываются после применения — строки показывают новое состояние. */
  candidates: BulkCandidate[]
  onClose(): void
  /** После применения: перечитать проекты (список в «Настройках» и в приложении). */
  onApplied(): Promise<void>
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Ошибка IPC по-человечески: старый main без `projects:applyTemplate` — «перезапустите приложение». */
function message(e: unknown): string {
  const msg = ipcErrorMessage(e)
  return isStaleTemplatesError(msg) ? TEMPLATES_STALE_MESSAGE : msg
}

/**
 * «Применить к проектам…»: шаблон в выбранные проекты выбранными разделами. На каждый отмеченный проект — те же
 * последствия, что в «О проекте» (`ApplyConsequences`); проект с ошибкой графа не применяется. Применение —
 * `projects:applyTemplate` по одному проекту, итог — у каждой строки.
 */
export function BulkApplyModal({ template, state, candidates, onClose, onApplied }: Props): React.JSX.Element {
  const [initial] = useState(() => initialSelection(candidates))
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.projectIds))
  const [sections, setSections] = useState<TemplateSection[]>(initial.sections)
  /** Задачи проектов для последствий; null — старый main/preload, счётчиков задач нет. */
  const [tasks, setTasks] = useState<Map<string, TaskRef[]> | null>(new Map())
  const [results, setResults] = useState<BulkResults | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const applyTemplate = templatesApi(window.orca)?.applyTemplate

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Иначе Esc закроет и окно «Настроек» под диалогом.
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Задачи всех проектов — один раз: колонки и роли, на которых они стоят, за время диалога не меняются.
  useEffect(() => {
    const refs = taskRefsApi(window.orca)
    if (!refs) {
      setTasks(null)
      return
    }
    let alive = true
    Promise.all(candidates.map(async (c) => [c.project.id, await refs(c.project.id)] as const)).then(
      (pairs) => alive && setTasks(new Map(pairs)),
      () => alive && setTasks(null)
    )
    return () => {
      alive = false
    }
  }, [])

  const previews = useMemo(() => {
    const m = new Map<string, ApplyPreview | null>()
    for (const c of candidates) {
      m.set(c.project.id, bulkPreview(c.project, template, sections, tasks ? (tasks.get(c.project.id) ?? []) : null))
    }
    return m
  }, [candidates, template, sections, tasks])

  const ids = applicableIds(candidates, selected, previews)
  const blocked = candidates.filter((c) => selected.has(c.project.id) && previews.get(c.project.id)?.error)
  const canApply = !busy && !!applyTemplate && ids.length > 0

  function toggleProject(id: string, on: boolean): void {
    // Итог прошлого применения у строки больше не актуален — снова показываем последствия.
    setResults((cur) => {
      if (!cur || !(id in cur)) return cur
      const { [id]: _, ...rest } = cur
      return rest
    })
    setSelected((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSection(s: TemplateSection, on: boolean): void {
    setSections((cur) => TEMPLATE_SECTIONS.filter((x) => (x === s ? on : cur.includes(x))))
  }

  async function submit(): Promise<void> {
    if (busyRef.current || !canApply || !applyTemplate) return
    busyRef.current = true
    setBusy(true)
    setResults({})
    const applied = await applyEach(ids, (id) => applyTemplate(id, template.id, sections), message, setResults)
    setResults(applied)
    // Отметки снимаем с применённых: повторный клик не применит их второй раз.
    setSelected((cur) => new Set([...cur].filter((id) => applied[id] !== null)))
    // Список проектов перечитываем в любом случае; его ошибка не отменяет применённого.
    await onApplied().catch(() => undefined)
    busyRef.current = false
    setBusy(false)
  }

  const typeTitle = (id: string | undefined): string =>
    id ? (state.templates.find((t) => t.id === id)?.title ?? `${id} (удалён)`) : 'тип не задан'
  const own = candidates.filter((c) => c.own)
  const others = candidates.filter((c) => !c.own)

  function row(c: BulkCandidate): React.JSX.Element {
    const id = c.project.id
    const on = selected.has(id)
    const preview = previews.get(id) ?? null
    const result = results?.[id]
    return (
      <li key={id} className={`bulk-row${on ? ' on' : ''}`}>
        <label className="tpl-check bulk-row-head">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggleProject(id, e.target.checked)} />
          <span className="bulk-row-name" title={c.project.root}>{c.project.name}</span>
          {!c.own && <span className="chip sys">{typeTitle(c.project.templateId)}</span>}
          <span className={`bulk-row-diff${c.differs.length ? '' : ' muted'}`}>
            {c.differs.length ? `отличается: ${c.differs.map((s) => TEMPLATE_SECTION_TITLES[s]).join(', ')}` : 'совпадает с шаблоном'}
          </span>
        </label>
        {result === null && <div className="bulk-row-result ok">Применено.</div>}
        {typeof result === 'string' && <div className="bulk-row-result error-text">{result}</div>}
        {on && preview && result === undefined && (
          <ApplyConsequences preview={preview} typeTitle={template.title} tasksKnown={tasks !== null} />
        )}
      </li>
    )
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal tpl-apply tpl-bulk" role="dialog" aria-modal="true" aria-label="Применить шаблон к проектам" onClick={(e) => e.stopPropagation()}>
        <h3>Применить «{template.title}» к проектам</h3>
        <p className="muted modal-sub">
          Выбранные разделы шаблона заменят настройки отмеченных проектов. Задачи не удаляются; что изменится — под каждым проектом.
        </p>

        <fieldset className="tpl-sections" disabled={busy}>
          <legend className="muted">Что взять из шаблона</legend>
          {TEMPLATE_SECTIONS.map((s) => (
            <label key={s} className="tpl-check">
              <input type="checkbox" checked={sections.includes(s)} onChange={(e) => toggleSection(s, e.target.checked)} />
              {cap(TEMPLATE_SECTION_TITLES[s])}
            </label>
          ))}
        </fieldset>
        {!sections.length && <span className="muted">Выберите хотя бы один раздел.</span>}

        <div className="bulk-list">
          {own.length > 0 && <div className="bulk-group muted">Проекты этого типа</div>}
          <ul>{own.map(row)}</ul>
          {others.length > 0 && <div className="bulk-group muted">Другие проекты</div>}
          <ul>{others.map(row)}</ul>
          {!candidates.length && <span className="muted">Проектов нет.</span>}
        </div>

        {tasks === null && (
          <span className="muted">Число задач в проектах недоступно — перезапустите приложение, чтобы увидеть, сколько задач переедет.</span>
        )}
        {blocked.length > 0 && (
          <span className="error-text">
            Не будут применены из-за ошибки графа: {blocked.map((c) => `«${c.project.name}»`).join(', ')}.
          </span>
        )}
        {!applyTemplate && <span className="error-text">{TEMPLATES_STALE_MESSAGE}</span>}
        {results && !busy && Object.keys(results).length > 0 && <span className="muted">{resultsText(results)}</span>}

        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{results ? 'Готово' : 'Отмена'}</button>
          <button className="btn-primary" disabled={!canApply} onClick={() => void submit()}>
            {busy ? 'Применяю…' : `Применить (${ids.length})`}
          </button>
        </div>
      </div>
    </div>
  )
}
