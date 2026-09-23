import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import { defaultWorkflow, stableJson, validateWorkflow, type BoardColumn, type Role, type Workflow } from '@orca-board/core'
import { WorkflowCanvas } from '../WorkflowCanvas'
import { WorkflowInspector } from '../WorkflowInspector'
import { Icon } from '../icons'
import type { WfSelection } from '../workflowEdit'
import { addRetryLimit, exportWorkflowJson, parseWorkflowJson, workflowFileName } from '../workflowForm'
import { SectionHead } from '../about/parts'

interface Props {
  /** Название типа — имя файла экспорта. */
  title: string
  /** Свой граф типа; нет — дефолтный по ролям типа. */
  workflow: Workflow | undefined
  roles: Role[]
  /**
   * Колонки для выбора в нодах (встроенные и колонки проектов). По ним граф не проверяется: тип общий для досок
   * с разными колонками, колонку проверяет доска конкретного проекта.
   */
  columns: BoardColumn[]
  readOnly: boolean
  /** null — вернуть дефолтный граф (поле удаляется из типа). Ошибка — наружу, покажем под кнопками. */
  onSave(wf: Workflow | null): Promise<void>
}

/**
 * «Типы задач → Воркфлоу»: холст и инспектор графа типа. Сохраняется кнопкой: промежуточный граф почти всегда
 * невалиден. Встроенный тип — только просмотр: холст не меняет граф, инспектор недоступен. Компонент монтируется
 * с `key` по id типа, поэтому черновик другого типа сюда не протекает.
 */
export function TaskTypeWorkflow({ title, workflow, roles, columns, readOnly, onSave }: Props): React.JSX.Element {
  const saved = useMemo(() => workflow ?? defaultWorkflow(roles), [workflow, roles])
  const [draft, setDraft] = useState<Workflow>(saved)
  const [selection, setSelection] = useState<WfSelection>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Растёт при замене графа целиком (импорт, сброс): холст заново вписывает граф в окно. */
  const [canvasRev, setCanvasRev] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  // Без колонок и агентов: и то и другое у проекта, а тип общий для всех проектов.
  const issues = useMemo(() => validateWorkflow(draft, { roles }), [draft, roles])
  const dirty = stableJson(draft) !== stableJson(saved)
  const custom = workflow !== undefined
  const { errors, warnings } = issues

  function edit(wf: Workflow): void {
    if (readOnly) return
    setDraft(wf)
    setNotice(null)
  }

  function replace(wf: Workflow, message: string | null): void {
    setDraft(wf)
    setSelection(null)
    setCanvasRev((r) => r + 1)
    setNotice(message)
  }

  async function run(action: () => Promise<void>, message: string): Promise<void> {
    setBusy(true)
    try {
      await action()
      setError(null)
      setNotice(message)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(() => onSave(draft), 'Сохранено. Граф получат новые глобальные задачи этого типа; уже созданные идут по своему снимку графа.')

  const reset = (): Promise<void> => {
    if (!confirm(`Вернуть типу «${title}» дефолтный воркфлоу?\n\nДефолт строится по ролям: есть роль reviewer — ревью делает агент, нет — человек.`)) {
      return Promise.resolve()
    }
    return run(async () => {
      await onSave(null)
      replace(defaultWorkflow(roles), null)
    }, 'Тип снова на дефолтном воркфлоу.')
  }

  function exportJson(): void {
    const url = URL.createObjectURL(new Blob([exportWorkflowJson(draft)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = workflowFileName(title)
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importJson(file: File): Promise<void> {
    const res = parseWorkflowJson(await file.text())
    if ('error' in res) {
      setError(`Импорт «${file.name}»: ${res.error}`)
      return
    }
    setError(null)
    replace(res.workflow, `Импортирован «${file.name}». Проверьте граф и нажмите «Сохранить».`)
  }

  function presetLimit(): void {
    const res = addRetryLimit(draft)
    if ('error' in res) {
      setNotice(res.error)
      return
    }
    edit(res.workflow)
    setNotice('Добавлен лимит: после третьего отказа проверки решает человек. Проверьте граф и нажмите «Сохранить».')
  }

  const selectIssue = (nodeId?: string, edgeId?: string): void => {
    if (edgeId) setSelection({ kind: 'edge', id: edgeId })
    else if (nodeId) setSelection({ kind: 'node', id: nodeId })
  }

  return (
    <>
      <SectionHead
        title="Воркфлоу"
        hint="Этапы подзадачи глобальной задачи этого типа: работа, проверки, решение человека, мерж. Роли в графе — роли этого типа."
      />
      <div className="about-banner">
        Колонки в нодах графа <b>проверяются по доске конкретного проекта</b>: тип общий для проектов с разными колонками.
        Если колонки нет на доске проекта, задача в неё не переедет — этап пройдёт без смены колонки.
      </div>
      <div className="wf-section">
        <div className="wf-status">
          <span className={`chip ${custom ? 'ok' : 'sys'}`}>{custom ? 'свой граф типа' : 'дефолтный граф'}</span>
          {dirty && <span className="chip warn">есть несохранённые изменения</span>}
          {errors.length > 0 && <span className="wf-count wf-count--error">ошибок: {errors.length}</span>}
          {warnings.length > 0 && <span className="wf-count wf-count--warning">предупреждений: {warnings.length}</span>}
          {errors.length === 0 && warnings.length === 0 && <span className="wf-count">граф без замечаний</span>}
        </div>

        <div className="wf-editor">
          <WorkflowCanvas
            key={canvasRev}
            workflow={draft}
            onChange={edit}
            selection={selection}
            onSelect={setSelection}
            issues={issues}
          />
          {/* Встроенный тип: инспектор показывает выбранную ноду, но поля недоступны. */}
          <fieldset className="tpl-fieldset" disabled={readOnly}>
            <WorkflowInspector
              workflow={draft}
              selection={selection}
              onChange={edit}
              onSelect={setSelection}
              roles={roles}
              columns={columns}
              issues={issues}
            />
          </fieldset>
        </div>

        {(errors.length > 0 || warnings.length > 0) && (
          <div className="wf-problems">
            {[...errors.map((i) => ({ ...i, level: 'error' as const })), ...warnings.map((i) => ({ ...i, level: 'warning' as const }))].map((i, k) => (
              <button
                key={k}
                type="button"
                className={`wf-problem wf-problem--${i.level}`}
                disabled={!i.nodeId && !i.edgeId}
                onClick={() => selectIssue(i.nodeId, i.edgeId)}
              >
                <span className="wf-problem-kind">{i.level === 'error' ? 'Ошибка' : 'Внимание'}</span>
                {i.message}
              </button>
            ))}
          </div>
        )}

        <div className="wf-actions">
          {!readOnly && (
            <>
              <button
                type="button"
                className="btn-sm primary"
                disabled={busy || !dirty || errors.length > 0}
                title={errors.length > 0 ? 'Сначала исправьте ошибки графа' : !dirty ? 'Изменений нет' : undefined}
                onClick={() => void save()}
              >
                Сохранить
              </button>
              <button type="button" className="btn-sm" disabled={!dirty || busy} onClick={() => replace(saved, null)}>
                Отменить правки
              </button>
              <span className="wf-actions-sep" />
              <button type="button" className="btn-sm" onClick={presetLimit} title="Отказ проверки идёт через условие «заходов в работу ≥ 3»: на третьем решает человек">
                3 отказа → человек
              </button>
              <span className="wf-actions-sep" />
            </>
          )}
          <button type="button" className="btn-sm" onClick={exportJson}>Экспорт JSON</button>
          {!readOnly && (
            <>
              <button type="button" className="btn-sm" onClick={() => fileRef.current?.click()}>Импорт JSON</button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void importJson(f)
                }}
              />
              <span className="wf-actions-sep" />
              <button type="button" className="btn-sm" disabled={busy || (!custom && !dirty)} onClick={() => void reset()}>
                <Icon.refresh /> Сбросить к дефолтному
              </button>
            </>
          )}
        </div>

        {error && <div className="editor-error">{error}</div>}
        {notice && !error && <div className="hint wf-notice">{notice}</div>}
      </div>
    </>
  )
}
