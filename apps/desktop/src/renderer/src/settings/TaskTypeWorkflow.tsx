import type React from 'react'
import { Fragment, useMemo, useRef, useState } from 'react'
import { defaultWorkflow, stableJson, validateWorkflow, type BoardColumn, type Role, type WfMigrationNote, type Workflow } from '@orca-board/core'
import { WorkflowCanvas } from '../WorkflowCanvas'
import { WorkflowInspector } from '../WorkflowInspector'
import { Icon } from '../icons'
import type { WfSelection } from '../workflowEdit'
import {
  canOpenPath, crumbs, graphAt, levelIssues, locateId, resolvePath, scopeOf, startCustomSubflow, writeGraphAt, type WfPath
} from '../workflowNav'
import { addRetryLimit, exportWorkflowJson, parseWorkflowJson, workflowFileName, type WorkflowMigrationInfo } from '../workflowForm'
import { SectionHead } from '../about/parts'
import { useLocale, useT } from '../i18n'
import { nodeTitle, wfIssueText } from '../defaultTitles'
import { ipcErrorMessage } from '../ipcError'
import { storedWorkflowNotes } from '../taskTypeEdit'
import type { NodeTemplatesHook } from '../nodeTemplates'

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
  /** Библиотека своих нод: палитра «Свои ноды» над холстом и блок «Своя нода» в инспекторе. Нет — их нет. */
  library?: NodeTemplatesHook
  /** Предупреждения автомиграции сохранённого графа (`TaskType.workflowNotes`); показываются, пока их не закрыли. */
  notes?: WfMigrationNote[]
  /** «Понятно»: убрать предупреждения из типа. Нет (старый main) — кнопки нет, замечания уйдут с правкой графа. */
  onDismissNotes?(): Promise<void>
  /** null — вернуть дефолтный граф (поле удаляется из типа). Ошибка — наружу, покажем под кнопками. */
  onSave(wf: Workflow | null): Promise<void>
}

/**
 * «Типы задач → Воркфлоу»: холст и инспектор графа типа. Сохраняется кнопкой: промежуточный граф почти всегда
 * невалиден. `readOnly` — только просмотр: холст не меняет граф, инспектор недоступен. Компонент монтируется
 * с `key` по id типа, поэтому черновик другого типа сюда не протекает.
 *
 * Вход в ноду «Работа»: `path` — стек id нод «Работа» (`[]` — граф типа, `['impl']` — путь подзадачи этапа). Черновик
 * один — граф типа: правки пути пишутся в `work.subflow` (`writeGraphAt`), поэтому сохранение, экспорт и валидация не
 * знают про уровни. У ноды без своего пути показан образец по умолчанию — только просмотр, пока не заведут свой.
 */
export function TaskTypeWorkflow({ title, workflow, roles, columns, readOnly, library, notes, onDismissNotes, onSave }: Props): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const saved = useMemo(() => workflow ?? defaultWorkflow(roles), [workflow, roles])
  const [draft, setDraft] = useState<Workflow>(saved)
  const [selection, setSelection] = useState<WfSelection>(null)
  const [path, setPath] = useState<WfPath>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Что изменила миграция графа старого формата при импорте: показывается, пока граф не заменили или не сохранили. */
  const [migration, setMigration] = useState<WorkflowMigrationInfo | null>(null)
  /** Растёт при замене графа целиком (импорт, сброс): холст заново вписывает граф в окно. */
  const [canvasRev, setCanvasRev] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  // Без колонок и агентов: и то и другое у проекта, а тип общий для всех проектов.
  // Язык — в зависимостях: тексты проблем и названия нод в них переводятся при проверке.
  const issues = useMemo(() => validateWorkflow(draft, { roles, nodeTitle }), [draft, roles, locale])
  // Замена графа целиком (импорт, сброс) могла убрать ноду, в которую вошли: берём то, что ещё существует.
  const at = resolvePath(draft, path)
  const level = graphAt(draft, at) ?? { graph: draft, isDefault: false }
  const scope = scopeOf(at)
  /** Образец пути по умолчанию нельзя править — сначала заводят свой путь. */
  const levelReadOnly = readOnly || level.isDefault
  const levelIssuesShown = useMemo(() => levelIssues(issues, at), [issues, at.join('/')])
  const dirty = stableJson(draft) !== stableJson(saved)
  const custom = workflow !== undefined
  const { errors, warnings } = issues
  const stored = storedWorkflowNotes(notes, readOnly, onDismissNotes !== undefined)

  /** Правка графа текущего уровня: на уровне пути она записывается в `work.subflow` ноды. */
  function edit(wf: Workflow): void {
    if (levelReadOnly) return
    setDraft(writeGraphAt(draft, at, wf))
    setNotice(null)
  }

  /** Правка графа типа целиком (не текущего уровня): заводит собственный путь у ноды, в которую вошли. */
  function editRoot(wf: Workflow): void {
    if (readOnly) return
    setDraft(wf)
    setNotice(null)
  }

  /** Вход в путь подзадачи ноды «Работа». */
  function open(nodeId: string): void {
    if (!canOpenPath(draft, at, nodeId)) return
    setPath([...at, nodeId])
    setSelection(null)
  }

  /** Переход по крошке; при выходе вверх выделяется нода, из которой вышли. */
  function goTo(target: WfPath): void {
    const from = at[target.length]
    setPath(target)
    setSelection(from !== undefined && target.length < at.length ? { kind: 'node', id: from } : null)
  }

  function replace(wf: Workflow, message: string | null): void {
    setMigration(null)
    setDraft(wf)
    setPath([])
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
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      await onSave(draft)
      setMigration(null)
    }, t('config.wf.tab.saved'))

  const reset = (): Promise<void> => {
    if (!confirm(t('config.wf.tab.resetConfirm', { title }))) {
      return Promise.resolve()
    }
    return run(async () => {
      await onSave(null)
      replace(defaultWorkflow(roles), null)
    }, t('config.wf.tab.resetDone'))
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
      setError(t('config.wf.tab.importError', { file: file.name, error: res.error }))
      return
    }
    setError(null)
    replace(res.workflow, t('config.wf.tab.imported', { file: file.name }))
    if (res.migration) setMigration(res.migration)
  }

  async function dismissNotes(dismiss: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await dismiss()
      setError(null)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function presetLimit(): void {
    const res = addRetryLimit(level.graph)
    if ('error' in res) {
      setNotice(res.error)
      return
    }
    edit(res.workflow)
    setNotice(t('config.wf.tab.limitAdded'))
  }

  /** Проблема пути (`impl/rev`) открывает путь ноды `impl` и выделяет `rev`. */
  const selectIssue = (nodeId?: string, edgeId?: string): void => {
    const kind = edgeId ? 'edge' : 'node'
    const id = edgeId ?? nodeId
    if (!id) return
    const target = locateId(draft, kind, id)
    setPath(target.path)
    setSelection({ kind, id: target.id })
  }

  return (
    <>
      <SectionHead
        title={t('config.wf.tab.title')}
        hint={t('config.wf.tab.hint')}
      />
      <div className="about-banner">
        {t('config.wf.tab.bannerBefore')} <b>{t('config.wf.tab.bannerStrong')}</b>{t('config.wf.tab.bannerAfter')}
      </div>
      <div className="wf-section">
        <div className="wf-status">
          <span className={`chip ${custom ? 'ok' : 'sys'}`}>{custom ? t('config.wf.tab.custom') : t('config.wf.tab.default')}</span>
          {dirty && <span className="chip warn">{t('config.wf.tab.dirty')}</span>}
          {errors.length > 0 && <span className="wf-count wf-count--error">{t('config.wf.tab.errors', { count: errors.length })}</span>}
          {warnings.length > 0 && <span className="wf-count wf-count--warning">{t('config.wf.tab.warnings', { count: warnings.length })}</span>}
          {errors.length === 0 && warnings.length === 0 && <span className="wf-count">{t('config.wf.tab.clean')}</span>}
        </div>

        {stored && (
          <div className="wf-migration wf-migration--stored" role="alert">
            <b>{t('config.wf.tab.storedMigrated')}</b>
            <ul>{stored.messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
            {stored.dismissable && onDismissNotes && (
              <div>
                <button type="button" className="btn-sm" disabled={busy} onClick={() => void dismissNotes(onDismissNotes)}>
                  {t('config.wf.tab.storedMigratedDismiss')}
                </button>
              </div>
            )}
          </div>
        )}

        {at.length > 0 && (
          <>
            <nav className="wf-crumbs" aria-label={t('config.wf.nav.aria')}>
              {crumbs(draft, at).map((c, i, all) => (
                <Fragment key={i}>
                  {i > 0 && <span className="wf-crumb-sep" aria-hidden>›</span>}
                  {i === all.length - 1
                    ? <b className="wf-crumb current" aria-current="page">{c.title}</b>
                    : <button type="button" className="wf-crumb" onClick={() => goTo(c.path)}>{c.title}</button>}
                </Fragment>
              ))}
              <span className={`chip ${level.isDefault ? 'sys' : 'ok'}`}>{level.isDefault ? t('config.wf.path.modeDefault') : t('config.wf.path.modeCustom')}</span>
            </nav>
            <div className="wf-path-banner" role="note">
              <span>{level.isDefault ? t('config.wf.path.bannerDefault') : t('config.wf.path.banner')}</span>
              {level.isDefault && !readOnly && (
                <button type="button" className="btn-sm" onClick={() => editRoot(startCustomSubflow(draft, at[at.length - 1]))}>
                  {t('config.wf.path.startCustom')}
                </button>
              )}
            </div>
          </>
        )}

        <div className="wf-editor">
          <WorkflowCanvas
            key={`${canvasRev}:${at.join('/')}`}
            workflow={level.graph}
            onChange={edit}
            selection={selection}
            onSelect={setSelection}
            issues={levelIssuesShown}
            scope={scope}
            onOpenNode={open}
            library={readOnly || levelReadOnly ? undefined : library}
          />
          {/* Только просмотр: инспектор показывает выбранную ноду, но поля недоступны. */}
          <fieldset className="tpl-fieldset" disabled={levelReadOnly}>
            <WorkflowInspector
              workflow={level.graph}
              selection={selection}
              onChange={edit}
              onSelect={setSelection}
              roles={roles}
              columns={columns}
              issues={levelIssuesShown}
              scope={scope}
              onOpenPath={scope === 'run' ? open : undefined}
              library={library}
            />
          </fieldset>
        </div>

        {migration && (
          <div className="wf-migration" role="status">
            <span>{t('config.wf.tab.importMigrated', { version: migration.fromVersion })}</span>
            {migration.notes.length > 0 && <ul>{migration.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>
        )}

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
                <span className="wf-problem-kind">{i.level === 'error' ? t('config.wf.tab.problemError') : t('config.wf.tab.problemWarning')}</span>
                {wfIssueText(i)}
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
                title={errors.length > 0 ? t('config.wf.tab.fixFirst') : !dirty ? t('config.wf.tab.noChanges') : undefined}
                onClick={() => void save()}
              >
                {t('config.wf.tab.save')}
              </button>
              <button type="button" className="btn-sm" disabled={!dirty || busy} onClick={() => replace(saved, null)}>
                {t('config.wf.tab.revert')}
              </button>
              <span className="wf-actions-sep" />
              <button type="button" className="btn-sm" disabled={levelReadOnly} onClick={presetLimit} title={t('config.wf.tab.limitHint')}>
                {t('config.wf.tab.limit')}
              </button>
              <span className="wf-actions-sep" />
            </>
          )}
          <button type="button" className="btn-sm" onClick={exportJson}>{t('config.wf.tab.export')}</button>
          {!readOnly && (
            <>
              <button type="button" className="btn-sm" onClick={() => fileRef.current?.click()}>{t('config.wf.tab.import')}</button>
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
                <Icon.refresh /> {t('config.wf.tab.reset')}
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
