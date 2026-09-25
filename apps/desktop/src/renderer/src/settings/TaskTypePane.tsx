import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, TaskType } from '@orca-board/core'
import type { Project, TaskTypesState } from '../../../shared/ipc'
import { RolesEditor } from '../RolesEditor'
import { Icon } from '../icons'
import { ipcErrorMessage, useAutoSave } from '../useAutoSave'
import { agentRulesPlaceholder } from '../agentRules'
import { SectionHead } from '../about/parts'
import { useT, type TFunction, type TKey } from '../i18n'
import { PermissionsSection, permissionParts } from '../about/PermissionsSection'
import {
  TASK_TYPE_TABS, libraryAgents, resolveTypeSettings, storedWorkflowNotes, typeColumnChoices,
  typeEditorKey, typeRemovalConfirm, type TaskTypeTab, type TypeUsage
} from '../taskTypeEdit'
import { TaskTypeWorkflow } from './TaskTypeWorkflow'
import type { TaskTypesHook } from './useTaskTypes'
import { builtinText } from '../defaultTitles'

interface Props {
  type: TaskType
  state: TaskTypesState
  /** Где тип используется проектами. */
  usage: TypeUsage | undefined
  /** Агенты реестра: у типа своих агентов нет, в выборе — все установленные. */
  agents: AgentInfo[]
  tab: TaskTypeTab
  onTab(tab: TaskTypeTab): void
  api: TaskTypesHook
  /** Показать другой тип (после «Дублировать» — копию, после удаления — тип по умолчанию). */
  onSelect(id: string | null): void
  /** Все проекты — колонки для нод графа. */
  projects: Project[]
}

const TAB_LABELS: Record<TaskTypeTab, TKey> = {
  roles: 'config.taskType.tab.roles',
  workflow: 'config.taskType.tab.workflow',
  perm: 'config.taskType.tab.perm',
  rules: 'config.taskType.tab.rules'
}

/**
 * Один тип в «Настройки → Типы задач»: шапка (название, отметки, действия) и редакторы разделов типа. Связь живая:
 * глобальные задачи берут роли и правила типа при каждом запуске агента. Все типы равны — и созданные человеком,
 * и заготовки, с которыми приходит приложение: любой правится, переименовывается и удаляется (кроме последнего).
 */
export function TaskTypePane({ type, state, usage, agents, tab, onTab, api, onSelect, projects }: Props): React.JSX.Element {
  const t = useT()
  const editorKey = typeEditorKey(type)
  const isLast = state.taskTypes.length <= 1
  const isDefault = state.defaultTaskTypeId === type.id
  const s = resolveTypeSettings(type.settings)
  const typeAgents = libraryAgents(agents)
  const agentOk = new Set(typeAgents.filter((a) => a.enabled).map((a) => a.id as string))
  const rolesOff = s.roles.filter((r) => !agentOk.has(r.agent)).length

  const [renaming, setRenaming] = useState(false)
  /** Открыто подтверждение удаления. */
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sectionError, setSectionError] = useState<string | null>(null)

  // Ошибки и форма переименования относятся к одному типу.
  useEffect(() => {
    setRenaming(false)
    setConfirming(false)
    setError(null)
    setSectionError(null)
  }, [type.id])
  useEffect(() => setSectionError(null), [tab])

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

  /** Правка раздела с ошибкой под разделом (для редакторов без своего автосохранения). */
  function patchSection(p: Parameters<TaskTypesHook['patch']>[1]): void {
    api.patch(type.id, p).then(() => setSectionError(null), (e: unknown) => setSectionError(ipcErrorMessage(e)))
  }

  const duplicate = (): Promise<void> => act(async () => onSelect((await api.duplicate(type.id)).id))
  const makeDefault = (): Promise<void> => act(() => api.setDefault(type.id))
  const removal = typeRemovalConfirm(type, state, usage)
  const remove = (): Promise<void> =>
    act(async () => {
      await api.remove(type.id)
      setConfirming(false)
      onSelect(null)
    })

  const counts: Record<TaskTypeTab, string> = {
    roles: rolesOff ? `${s.roles.length} · ${rolesOff} !` : String(s.roles.length),
    workflow: `${s.workflow ? t('config.taskType.count.own') : t('config.taskType.count.default')}${storedWorkflowNotes(type.workflowNotes, false, false) ? ' !' : ''}`,
    perm: permissionParts(s.permissionMode).title,
    rules: s.agentRules.trim() ? t('config.taskType.count.yes') : t('config.taskType.count.no')
  }

  function renderTab(): React.ReactNode {
    switch (tab) {
      case 'roles':
        return (
          <>
            <SectionHead
              title={t('config.taskType.tab.roles')}
              hint={t('config.taskType.rolesHint')}
            />
            <RolesEditor
              storageKey={editorKey}
              roles={s.roles}
              agents={typeAgents}
              workflow={s.workflow}
              ofTaskType
              onSave={(next) => api.patch(type.id, { roles: next })}
            />
          </>
        )
      case 'workflow':
        return (
          <TaskTypeWorkflow
            key={editorKey}
            title={type.title}
            workflow={s.workflow}
            roles={s.roles}
            columns={typeColumnChoices(projects)}
            readOnly={false}
            notes={type.workflowNotes}
            onDismissNotes={() => api.patch(type.id, { workflowNotes: [] })}
            onSave={(wf) => api.patch(type.id, { workflow: wf })}
          />
        )
      case 'perm':
        return (
          <PermissionsSection value={s.permissionMode} error={sectionError} onChange={(mode) => patchSection({ permissionMode: mode })} />
        )
      case 'rules':
        return (
          <TypeRules
            key={editorKey}
            storageKey={editorKey}
            text={s.agentRules}
            onSave={(text) => api.patch(type.id, { agentRules: text })}
          />
        )
    }
  }

  return (
    <>
      <div className="tpl-head">
        <div className="tpl-head-text">
          <h2>
            {builtinText(type.title)}
            {isDefault && <span className="chip ok">{t('config.taskType.defaultChip')}</span>}
          </h2>
          {type.description && <p>{builtinText(type.description)}</p>}
          <p className="tpl-usage">{usageText(t, usage)}</p>
        </div>
        <div className="tpl-actions">
          {!isDefault && (
            <button type="button" className="btn-sm" disabled={busy} onClick={() => void makeDefault()} title={t('config.taskType.makeDefaultTitle')}>
              <Icon.star /> {t('config.taskType.makeDefault')}
            </button>
          )}
          <button type="button" className="btn-sm" disabled={busy} onClick={() => void duplicate()}>{t('config.taskType.duplicate')}</button>
          <button type="button" className="btn-sm" disabled={busy || renaming} onClick={() => setRenaming(true)}>
            <Icon.edit /> {t('config.taskType.rename')}
          </button>
          <button
            type="button"
            className="btn-sm danger"
            disabled={busy || confirming || isLast}
            title={isLast ? t('config.taskType.lastTypeTitle') : undefined}
            onClick={() => setConfirming(true)}
          >
            <Icon.trash /> {t('config.taskType.delete')}
          </button>
        </div>
      </div>

      {confirming && (
        <div className="roles-confirm tpl-confirm" role="alertdialog" aria-label={removal.title}>
          <div className="roles-confirm-title">{removal.title}</div>
          <ul>{removal.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <div className="roles-confirm-btns">
            <button type="button" className="btn-sm" autoFocus onClick={() => setConfirming(false)}>{t('config.taskType.cancel')}</button>
            <button type="button" className="btn-sm danger-fill" disabled={busy} onClick={() => void remove()}>{removal.action}</button>
          </div>
        </div>
      )}

      {renaming && (
        <RenameForm
          type={type}
          onCancel={() => setRenaming(false)}
          onSave={(title, description) => act(async () => {
            await api.rename(type.id, title, description)
            setRenaming(false)
          })}
        />
      )}
      {error && <div className="editor-error">{error}</div>}

      <div className="about-banner">
        {t('config.taskType.banner.before')} <b>{t('config.taskType.banner.bold')}</b>{t('config.taskType.banner.after')}
      </div>

      <div className="tpl-tabs" role="tablist" aria-label={t('config.taskType.tabsAria')}>
        {TASK_TYPE_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            onClick={() => onTab(id)}
          >
            {t(TAB_LABELS[id])}
            <span className={`tpl-tab-count${id === 'roles' && rolesOff ? ' warn' : ''}`}>{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="tpl-tabpanel" role="tabpanel">{renderTab()}</div>
    </>
  )
}

/** «По умолчанию в 2 проектах · доступен в 5». */
function usageText(t: TFunction, u: TypeUsage | undefined): string {
  if (!u || u.available === 0) return t('config.taskType.usage.none')
  const parts = [t('config.taskType.usage.available', { count: u.available })]
  if (u.asDefault) parts.push(t('config.taskType.usage.default', { n: u.asDefault }))
  return `${parts.join(' · ')}.`
}

/** Название и описание типа: форма в шапке (window.prompt в Electron не работает). */
function RenameForm({ type, onCancel, onSave }: {
  type: TaskType
  onCancel(): void
  onSave(title: string, description: string): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const [title, setTitle] = useState(type.title)
  const [description, setDescription] = useState(type.description ?? '')
  return (
    <form
      className="tpl-rename"
      onSubmit={(e) => {
        e.preventDefault()
        void onSave(title, description)
      }}
      onKeyDown={(e) => {
        // Esc закрывает форму, а не всё окно настроек.
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <label>
        <span>{t('config.taskType.renameTitle')}</span>
        <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>{t('config.taskType.renameDescription')}</span>
        <input value={description} placeholder={t('config.taskType.renameDescriptionPlaceholder')} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="tpl-rename-btns">
        <button type="submit" className="btn-sm primary" disabled={!title.trim()}>{t('config.taskType.save')}</button>
        <button type="button" className="btn-sm" onClick={onCancel}>{t('config.taskType.cancel')}</button>
      </div>
    </form>
  )
}

/** «Правила доски» типа: блок «Правила проекта» в системном промпте агентов доски. Сохраняются автоматически. */
function TypeRules({ storageKey, text, onSave }: {
  storageKey: string
  text: string
  onSave(text: string): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const { draft, error, update } = useAutoSave(storageKey, text, onSave)
  return (
    <>
      <SectionHead
        title={t('config.taskType.tab.rules')}
        hint={t('config.taskType.rulesHint')}
      />
      <div className="agent-rules">
        <textarea
          value={draft}
          placeholder={agentRulesPlaceholder()}
          rows={12}
          spellCheck={false}
          aria-label={t('config.taskType.rulesAria')}
          onChange={(e) => update(e.target.value, true)}
        />
        {error && <div className="editor-error">{error}</div>}
      </div>
    </>
  )
}
