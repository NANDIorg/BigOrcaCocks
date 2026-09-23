import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, TaskType } from '@orca-board/core'
import type { Project, TaskTypesState } from '../../../shared/ipc'
import { RolesEditor } from '../RolesEditor'
import { Icon } from '../icons'
import { ipcErrorMessage, useAutoSave } from '../useAutoSave'
import { AGENT_RULES_PLACEHOLDER } from '../agentRules'
import { SectionHead, plural } from '../about/parts'
import { PermissionsSection, permissionParts } from '../about/PermissionsSection'
import {
  TASK_TYPE_TABS, deleteTypeConfirmText, isBuiltinLike, libraryAgents, overridesBuiltinType, resolveTypeSettings,
  typeColumnChoices, typeEditorKey, type TaskTypeTab, type TypeUsage
} from '../taskTypeEdit'
import { TaskTypeWorkflow } from './TaskTypeWorkflow'
import type { TaskTypesHook } from './useTaskTypes'

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

const TAB_LABELS: Record<TaskTypeTab, string> = {
  roles: 'Роли',
  workflow: 'Воркфлоу',
  perm: 'Разрешения',
  rules: 'Правила доски'
}

/**
 * Один тип в «Настройки → Типы задач»: шапка (название, отметки, действия) и редакторы разделов типа. Связь живая:
 * глобальные задачи берут роли и правила типа при каждом запуске агента. У встроенного типа (и его изменённой
 * копии) на месте меняются исполнитель ролей, их системные промпты и правила доски — первая такая правка
 * сохраняет «изменённый встроенный» с тем же id; состав ролей, граф и разрешения — только в дубле.
 */
export function TaskTypePane({ type: t, state, usage, agents, tab, onTab, api, onSelect, projects }: Props): React.JSX.Element {
  const builtinLike = isBuiltinLike(t)
  /** Растёт после «Вернуть встроенный»: id тот же, а редакторы должны взять встроенные значения. */
  const [rev, setRev] = useState(0)
  const editorKey = typeEditorKey(t, rev)
  const isDefault = state.defaultTaskTypeId === t.id
  const s = resolveTypeSettings(t.settings)
  const typeAgents = libraryAgents(agents)
  const agentOk = new Set(typeAgents.filter((a) => a.enabled).map((a) => a.id as string))
  const rolesOff = s.roles.filter((r) => !agentOk.has(r.agent)).length

  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sectionError, setSectionError] = useState<string | null>(null)

  // Ошибки и форма переименования относятся к одному типу.
  useEffect(() => {
    setRenaming(false)
    setError(null)
    setSectionError(null)
  }, [t.id])
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
    api.patch(t.id, p).then(() => setSectionError(null), (e: unknown) => setSectionError(ipcErrorMessage(e)))
  }

  const duplicate = (): Promise<void> => act(async () => onSelect((await api.duplicate(t.id)).id))
  const makeDefault = (): Promise<void> => act(() => api.setDefault(t.id))
  const remove = (): Promise<void> => {
    if (!confirm(deleteTypeConfirmText(t, state, usage))) return Promise.resolve()
    return act(async () => {
      await api.remove(t.id)
      // Копия встроенного после удаления снова встроенный тип с тем же id — остаёмся на нём.
      if (overridesBuiltinType(t)) {
        setRev((r) => r + 1)
        onSelect(t.id)
      } else {
        onSelect(null)
      }
    })
  }

  const counts: Record<TaskTypeTab, string> = {
    roles: rolesOff ? `${s.roles.length} · ${rolesOff} !` : String(s.roles.length),
    workflow: s.workflow ? 'свой' : 'дефолт',
    perm: permissionParts(s.permissionMode).title,
    rules: s.agentRules.trim() ? 'есть' : 'нет'
  }

  function renderTab(): React.ReactNode {
    switch (tab) {
      case 'roles':
        return (
          <>
            <SectionHead
              title="Роли"
              hint={builtinLike
                ? 'Во встроенном типе у ролей меняются агент, модель, усилие и инструкции роли. Состав и назначение ролей — через «Дублировать».'
                : 'Кто выполняет подзадачи глобальной задачи этого типа: агент, модель, усилие и инструкция. Порядок — как в «Новой задаче».'}
            />
            <RolesEditor
              storageKey={editorKey}
              roles={s.roles}
              agents={typeAgents}
              workflow={s.workflow}
              executorOnly={builtinLike}
              onSave={(next) => api.patch(t.id, { roles: next })}
            />
          </>
        )
      case 'workflow':
        return (
          <TaskTypeWorkflow
            key={editorKey}
            title={t.title}
            workflow={s.workflow}
            roles={s.roles}
            columns={typeColumnChoices(projects)}
            readOnly={builtinLike}
            onSave={(wf) => api.patch(t.id, { workflow: wf })}
          />
        )
      case 'perm':
        return (
          <fieldset className="tpl-fieldset" disabled={builtinLike}>
            <PermissionsSection value={s.permissionMode} error={sectionError} onChange={(mode) => patchSection({ permissionMode: mode })} />
          </fieldset>
        )
      case 'rules':
        return (
          <TypeRules
            key={editorKey}
            storageKey={editorKey}
            text={s.agentRules}
            onSave={(text) => api.patch(t.id, { agentRules: text })}
          />
        )
    }
  }

  return (
    <>
      <div className="tpl-head">
        <div className="tpl-head-text">
          <h2>
            {t.title}
            {t.builtin && <span className="chip sys">встроенный</span>}
            {overridesBuiltinType(t) && <span className="chip sys" title="Своя версия встроенного типа: «Вернуть встроенный» удалит правки">изменённый встроенный</span>}
            {isDefault && <span className="chip ok">по умолчанию</span>}
          </h2>
          {t.description && <p>{t.description}</p>}
          <p className="tpl-usage">{usageText(usage)}</p>
        </div>
        <div className="tpl-actions">
          {!isDefault && (
            <button type="button" className="btn-sm" disabled={busy} onClick={() => void makeDefault()} title="Тип новых проектов и проектов, у которых свой тип по умолчанию удалён">
              <Icon.star /> По умолчанию
            </button>
          )}
          <button type="button" className="btn-sm" disabled={busy} onClick={() => void duplicate()}>Дублировать</button>
          {!t.builtin && (overridesBuiltinType(t) ? (
            <button type="button" className="btn-sm danger" disabled={busy} onClick={() => void remove()} title="Удалить свои правки — вернётся встроенный тип">
              <Icon.trash /> Вернуть встроенный
            </button>
          ) : (
            <>
              <button type="button" className="btn-sm" disabled={busy || renaming} onClick={() => setRenaming(true)}>
                <Icon.edit /> Переименовать
              </button>
              <button type="button" className="btn-sm danger" disabled={busy} onClick={() => void remove()}>
                <Icon.trash /> Удалить
              </button>
            </>
          ))}
        </div>
      </div>

      {renaming && (
        <RenameForm
          type={t}
          onCancel={() => setRenaming(false)}
          onSave={(title, description) => act(async () => {
            await api.rename(t.id, title, description)
            setRenaming(false)
          })}
        />
      )}
      {error && <div className="editor-error">{error}</div>}

      <div className="about-banner">
        {builtinLike ? (
          <>
            Встроенный тип обновляется вместе с приложением. Прямо здесь меняются <b>агент, модель, усилие и инструкции
            ролей</b> и <b>правила доски</b>{t.builtin ? ' — тип станет «изменённым встроенным»' : ''}. Состав ролей, воркфлоу
            и разрешения — «Дублировать» и правьте копию.
          </>
        ) : (
          <>
            Правка типа действует <b>во всех проектах</b>, где он доступен, со следующего запуска агента. Воркфлоу глобальная
            задача берёт при создании — уже созданные идут по своему графу.
          </>
        )}
      </div>

      <div className="tpl-tabs" role="tablist" aria-label="Разделы типа">
        {TASK_TYPE_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            onClick={() => onTab(id)}
          >
            {TAB_LABELS[id]}
            <span className={`tpl-tab-count${id === 'roles' && rolesOff ? ' warn' : ''}`}>{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="tpl-tabpanel" role="tabpanel">{renderTab()}</div>
    </>
  )
}

/** «По умолчанию в 2 проектах · доступен в 5». */
function usageText(u: TypeUsage | undefined): string {
  if (!u || u.available === 0) return 'Ни в одном проекте не доступен — включите его в «О проекте → Типы задач».'
  const parts = [`Доступен в ${u.available} ${plural(u.available, 'проекте', 'проектах', 'проектах')}`]
  if (u.asDefault) parts.push(`по умолчанию в ${u.asDefault}`)
  return `${parts.join(' · ')}.`
}

/** Название и описание типа: форма в шапке (window.prompt в Electron не работает). */
function RenameForm({ type, onCancel, onSave }: {
  type: TaskType
  onCancel(): void
  onSave(title: string, description: string): Promise<void>
}): React.JSX.Element {
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
        <span>Название</span>
        <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>Описание</span>
        <input value={description} placeholder="Одна строка в выборе типа глобальной задачи" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="tpl-rename-btns">
        <button type="submit" className="btn-sm primary" disabled={!title.trim()}>Сохранить</button>
        <button type="button" className="btn-sm" onClick={onCancel}>Отмена</button>
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
  const { draft, error, update } = useAutoSave(storageKey, text, onSave)
  return (
    <>
      <SectionHead
        title="Правила доски"
        hint="Markdown для агентов, запущенных доской: воркеры всех ролей и координатор глобальной задачи этого типа получают его блоком «Правила проекта» в системном промпте. Не CLAUDE.md и не обычные сессии."
      />
      <div className="agent-rules">
        <textarea
          value={draft}
          placeholder={AGENT_RULES_PLACEHOLDER}
          rows={12}
          spellCheck={false}
          aria-label="Правила для агентов доски"
          onChange={(e) => update(e.target.value, true)}
        />
        {error && <div className="editor-error">{error}</div>}
      </div>
    </>
  )
}
