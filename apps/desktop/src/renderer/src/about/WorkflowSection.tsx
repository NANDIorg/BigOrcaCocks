import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import { defaultWorkflow, validateWorkflow, type AgentInfo, type BoardColumn, type Role, type Workflow } from '@orca-board/core'
import type { Project, ProjectDefaults } from '../../../shared/ipc'
import { WorkflowCanvas } from '../WorkflowCanvas'
import { WorkflowInspector } from '../WorkflowInspector'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import type { WfSelection } from '../workflowEdit'
import {
  WORKFLOW_STALE_MESSAGE, addRetryLimit, exportWorkflowJson, isStaleWorkflowError, parseWorkflowJson, workflowApi,
  workflowFileName
} from '../workflowForm'
import { stable } from './defaultsDiff'
import { SectionHead } from './parts'

interface Props {
  project: Project
  roles: Role[]
  columns: BoardColumn[]
  /** Агенты проекта: выключенный агент роли гейта — предупреждение валидации. */
  agents: AgentInfo[]
  onProjectChanged(): Promise<void>
  /** Патч дефолта для новых проектов (useProjectDefaults); ошибка — в setError. */
  saveDefaults(patch: Partial<ProjectDefaults>, setError: (e: string | null) => void): Promise<void>
}

/** Ошибка IPC по-человечески: старый main без хендлера — «перезапустите приложение». */
function saveError(e: unknown): string {
  const msg = ipcErrorMessage(e)
  return isStaleWorkflowError(msg) ? WORKFLOW_STALE_MESSAGE : msg
}

/**
 * «О проекте → Воркфлоу»: граф этапов рабочей задачи — холст, инспектор выбранной ноды и живая валидация.
 * В отличие от ролей и колонок сохраняется кнопкой, а не автоматически: промежуточный граф почти всегда
 * невалиден (нода без переходов), и main его не примет. Ошибки блокируют «Сохранить», предупреждения — нет.
 */
export function WorkflowSection({ project, roles, columns, agents, onProjectChanged, saveDefaults }: Props): React.JSX.Element {
  // Старый preload этих методов не знает — редактор только для просмотра и сообщение «перезапустите».
  const stale = !window.orca.projects.setWorkflow || !window.orca.workflow

  /** Что сохранено: свой граф проекта или дефолтный по ролям (его main подставляет сам). */
  const saved = useMemo(() => project.workflow ?? defaultWorkflow(roles), [project.workflow, roles])
  const [draft, setDraft] = useState<Workflow>(saved)
  const [selection, setSelection] = useState<WfSelection>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Растёт при замене графа целиком (импорт, сброс): холст пересоздаётся и заново вписывает граф в окно. */
  const [canvasRev, setCanvasRev] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled).map((a) => a.id as string), [agents])
  const issues = useMemo(() => validateWorkflow(draft, { roles, columns, enabledAgents }), [draft, roles, columns, enabledAgents])
  const dirty = stable(draft) !== stable(saved)
  const custom = project.workflow !== undefined

  function edit(wf: Workflow): void {
    setDraft(wf)
    setNotice(null)
  }

  function replace(wf: Workflow, message: string | null): void {
    setDraft(wf)
    setSelection(null)
    setCanvasRev((r) => r + 1)
    setNotice(message)
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(saveError(e))
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      await workflowApi(window.orca).setWorkflow(project.id, draft)
      await onProjectChanged()
      setNotice('Сохранено. Новый граф действует с нового прогона — идущие прогоны доживают на своём снимке.')
    })

  const resetToDefault = (): Promise<void> => {
    const ok = confirm(
      `Вернуть проекту «${project.name}» дефолтный воркфлоу?\n\n` +
        'Свой граф удалится. Дефолт строится по ролям: есть роль reviewer — ревью делает агент, нет — человек.'
    )
    if (!ok) return Promise.resolve()
    return run(async () => {
      const api = workflowApi(window.orca)
      const def = await api.defaultWorkflow(roles)
      await api.setWorkflow(project.id, null)
      await onProjectChanged()
      replace(def, 'Проект снова на дефолтном воркфлоу.')
    })
  }

  const makeDefault = async (): Promise<void> => {
    if (!confirm(`Сделать воркфлоу проекта «${project.name}» дефолтом для новых проектов?`)) return
    let failed: string | null = null
    await saveDefaults({ workflow: draft }, (e) => { failed = e })
    setError(failed)
    if (!failed) setNotice('Воркфлоу сохранён как дефолт для новых проектов.')
  }

  function exportJson(): void {
    const url = URL.createObjectURL(new Blob([exportWorkflowJson(draft)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = workflowFileName(project.name)
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

  const { errors, warnings } = issues
  const selectIssue = (nodeId?: string, edgeId?: string): void => {
    if (edgeId) setSelection({ kind: 'edge', id: edgeId })
    else if (nodeId) setSelection({ kind: 'node', id: nodeId })
  }

  return (
    <>
      <SectionHead
        title="Воркфлоу"
        hint="Этапы, которые проходит рабочая задача после создания: работа, проверки, решение человека, мерж. Задачи-ответы идут мимо воркфлоу."
      />
      <div className="wf-section">
        <div className="wf-status">
          <span className={`chip ${custom ? 'ok' : 'sys'}`}>{custom ? 'свой граф проекта' : 'дефолтный граф'}</span>
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
          <WorkflowInspector
            workflow={draft}
            selection={selection}
            onChange={edit}
            onSelect={setSelection}
            roles={roles}
            columns={columns}
            issues={issues}
          />
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
          <button
            type="button"
            className="btn-sm primary"
            disabled={stale || busy || !dirty || errors.length > 0}
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
          <button type="button" className="btn-sm" onClick={exportJson}>Экспорт JSON</button>
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
          <button type="button" className="btn-sm" disabled={stale || busy || (!custom && !dirty)} onClick={() => void resetToDefault()}>
            <Icon.refresh /> Сбросить к дефолтному
          </button>
          <button
            type="button"
            className="btn-sm"
            disabled={busy || dirty || errors.length > 0}
            title={dirty ? 'Сначала сохраните граф проекта' : undefined}
            onClick={() => void makeDefault()}
          >
            <Icon.star /> Сделать дефолтом для новых проектов
          </button>
        </div>

        {(stale || error) && <div className="editor-error">{stale ? WORKFLOW_STALE_MESSAGE : error}</div>}
        {notice && !error && <div className="hint wf-notice">{notice}</div>}
      </div>
    </>
  )
}
