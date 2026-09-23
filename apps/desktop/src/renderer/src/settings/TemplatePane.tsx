import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, AgentKind, ProjectTemplate } from '@orca-board/core'
import type { Project, TemplatesState } from '../../../shared/ipc'
import { RolesEditor } from '../RolesEditor'
import { ColumnsEditor } from '../ColumnsEditor'
import { Icon } from '../icons'
import { ipcErrorMessage, useAutoSave } from '../useAutoSave'
import { AGENT_RULES_PLACEHOLDER } from '../agentRules'
import { SectionHead, plural } from '../about/parts'
import { AgentsSection } from '../about/AgentsSection'
import { PermissionsSection, permissionParts } from '../about/PermissionsSection'
import {
  TEMPLATE_TABS, deleteConfirmText, overridesBuiltin, templateEditorKey, resolveTemplateSettings, templateAgents, type TemplateTab
} from '../projectTemplates'
import { bulkCandidates, usageHint, usageSummary } from '../bulkApply'
import { templatesApi as applyApi } from '../projectType'
import { BulkApplyModal } from './BulkApplyModal'
import { TemplateWorkflow } from './TemplateWorkflow'
import type { TemplatesHook } from './useTemplates'

interface Props {
  template: ProjectTemplate
  state: TemplatesState
  /** Сколько проектов создано из этого шаблона (`Project.templateId`). */
  usage: number
  /** Агенты реестра; включённость пересчитывается по шаблону. */
  agents: AgentInfo[]
  onRefreshAgents(): Promise<void>
  tab: TemplateTab
  onTab(tab: TemplateTab): void
  api: TemplatesHook
  /** Показать другой шаблон (после «Дублировать» — копию, после удаления — шаблон по умолчанию). */
  onSelect(id: string | null): void
  /** Все проекты — для «Применить к проектам…». */
  projects: Project[]
  /** Перечитать проекты после массового применения. */
  onProjectsChanged(): Promise<void>
}

const TAB_LABELS: Record<TemplateTab, string> = {
  agents: 'Агенты',
  roles: 'Роли',
  columns: 'Колонки',
  workflow: 'Воркфлоу',
  perm: 'Разрешения',
  rules: 'Правила доски'
}

/**
 * Один шаблон в «Настройки → Шаблоны проектов»: шапка (название, отметки, действия) и те же редакторы разделов,
 * что в «О проекте», но пишут они в шаблон (templates:save). Встроенный шаблон — только просмотр и «Дублировать».
 */
export function TemplatePane({
  template: t, state, usage, agents, onRefreshAgents, tab, onTab, api, onSelect, projects, onProjectsChanged
}: Props): React.JSX.Element {
  const readOnly = !!t.builtin
  const editorKey = templateEditorKey(t)
  const isDefault = state.defaultTemplateId === t.id
  const s = resolveTemplateSettings(t.settings)
  const tplAgents = templateAgents(agents, s.enabledAgents)
  const installed = tplAgents.filter((a) => a.installed)
  const agentOk = new Set(tplAgents.filter((a) => a.enabled).map((a) => a.id as string))
  const rolesOff = s.roles.filter((r) => !agentOk.has(r.agent)).length

  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sectionError, setSectionError] = useState<string | null>(null)
  const [bulk, setBulk] = useState(false)
  // Старый preload без applyTemplate — массового применения нет, шапка как раньше.
  const canBulk = !!applyApi(window.orca) && projects.length > 0
  const candidates = bulkCandidates(projects, t, agents)
  const hint = usageHint(usageSummary(candidates))

  // Ошибки и форма переименования относятся к одному шаблону.
  useEffect(() => {
    setRenaming(false)
    setBulk(false)
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
  function patchSection(p: Parameters<TemplatesHook['patch']>[1]): void {
    api.patch(t.id, p).then(() => setSectionError(null), (e: unknown) => setSectionError(ipcErrorMessage(e)))
  }

  const duplicate = (): Promise<void> => act(async () => onSelect((await api.duplicate(t.id)).id))
  const makeDefault = (): Promise<void> => act(() => api.setDefault(t.id))
  const remove = (): Promise<void> => {
    if (!confirm(deleteConfirmText(t, state, usage))) return Promise.resolve()
    return act(async () => {
      await api.remove(t.id)
      // Копия встроенного после удаления снова встроенный шаблон с тем же id — остаёмся на нём.
      onSelect(overridesBuiltin(t) ? t.id : null)
    })
  }

  function toggleAgent(id: AgentKind, on: boolean): void {
    patchSection({ enabledAgents: tplAgents.filter((a) => (a.id === id ? on : a.enabled)).map((a) => a.id) })
  }

  const counts: Record<TemplateTab, string> = {
    agents: s.enabledAgents === undefined ? 'все' : `${installed.filter((a) => a.enabled).length} из ${installed.length}`,
    roles: rolesOff ? `${s.roles.length} · ${rolesOff} !` : String(s.roles.length),
    columns: String(s.columns.length),
    workflow: s.workflow ? 'свой' : 'дефолт',
    perm: permissionParts(s.permissionMode).title,
    rules: s.agentRules.trim() ? 'есть' : 'нет'
  }

  function renderTab(): React.ReactNode {
    switch (tab) {
      case 'agents':
        return (
          <fieldset className="tpl-fieldset" disabled={readOnly}>
            <AgentsSection
              agents={tplAgents}
              all={{
                on: s.enabledAgents === undefined,
                onChange: (on) => patchSection({ enabledAgents: on ? null : installed.map((a) => a.id) })
              }}
              error={sectionError}
              onToggle={toggleAgent}
              onRefresh={() => void onRefreshAgents()}
            />
          </fieldset>
        )
      case 'roles':
        return (
          <>
            <SectionHead title="Роли" hint="Кто выполняет задачи: агент, модель, усилие и инструкция. Порядок — как в «Новой задаче»." />
            <RolesEditor
              storageKey={editorKey}
              roles={s.roles}
              agents={tplAgents}
              workflow={s.workflow}
              readOnly={readOnly}
              onSave={(next) => api.patch(t.id, { roles: next })}
            />
          </>
        )
      case 'columns':
        return (
          <>
            <SectionHead title="Колонки" hint="Порядок, название и цвет. Системные нельзя удалить — по ним работает автоматика." />
            <ColumnsEditor
              storageKey={editorKey}
              columns={s.columns}
              readOnly={readOnly}
              onSave={(next) => api.patch(t.id, { columns: next })}
            />
          </>
        )
      case 'workflow':
        return (
          <TemplateWorkflow
            key={editorKey}
            title={t.title}
            workflow={s.workflow}
            roles={s.roles}
            columns={s.columns}
            agents={tplAgents}
            readOnly={readOnly}
            onSave={(wf) => api.patch(t.id, { workflow: wf })}
          />
        )
      case 'perm':
        return (
          <fieldset className="tpl-fieldset" disabled={readOnly}>
            <PermissionsSection value={s.permissionMode} error={sectionError} onChange={(mode) => patchSection({ permissionMode: mode })} />
          </fieldset>
        )
      case 'rules':
        return (
          <TemplateRules
            key={editorKey}
            storageKey={editorKey}
            text={s.agentRules}
            readOnly={readOnly}
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
            {readOnly && <span className="chip sys">встроенный</span>}
            {overridesBuiltin(t) && <span className="chip sys" title="Своя версия встроенного шаблона: удаление вернёт встроенный">изменённый встроенный</span>}
            {isDefault && <span className="chip ok">по умолчанию</span>}
          </h2>
          {t.description && <p>{t.description}</p>}
          {canBulk && hint ? (
            <p className="tpl-usage tpl-usage-lag">
              {hint}{' '}
              <button type="button" className="btn-link" onClick={() => setBulk(true)}>Применить к ним…</button>
            </p>
          ) : (
            <p className="tpl-usage">
              {usage > 0
                ? `Используют ${usage} ${plural(usage, 'проект', 'проекта', 'проектов')}: правка шаблона их не меняет${canBulk ? ', все совпадают с ним' : ''}.`
                : 'Проектов из этого шаблона нет.'}
            </p>
          )}
        </div>
        <div className="tpl-actions">
          {!isDefault && (
            <button type="button" className="btn-sm" disabled={busy} onClick={() => void makeDefault()} title="Предлагать при добавлении проекта">
              <Icon.star /> По умолчанию
            </button>
          )}
          <button type="button" className="btn-sm" disabled={busy} onClick={() => void duplicate()}>Дублировать</button>
          {canBulk && (
            <button type="button" className="btn-sm" disabled={busy} onClick={() => setBulk(true)} title="Взять разделы шаблона в выбранные проекты">
              Применить к проектам…
            </button>
          )}
          {!readOnly && (
            <>
              <button type="button" className="btn-sm" disabled={busy || renaming} onClick={() => setRenaming(true)}>
                <Icon.edit /> Переименовать
              </button>
              <button type="button" className="btn-sm danger" disabled={busy} onClick={() => void remove()}>
                <Icon.trash /> Удалить
              </button>
            </>
          )}
        </div>
      </div>

      {renaming && (
        <RenameForm
          template={t}
          onCancel={() => setRenaming(false)}
          onSave={(title, description) => act(async () => {
            await api.rename(t.id, title, description)
            setRenaming(false)
          })}
        />
      )}
      {error && <div className="editor-error">{error}</div>}

      <div className="about-banner">
        {readOnly ? (
          <>Встроенный шаблон <b>только для чтения</b> и обновляется вместе с приложением. Чтобы поменять настройки — «Дублировать» и правьте копию.</>
        ) : (
          <>Шаблон <b>копируется в проект при добавлении</b>; правка шаблона не меняет уже созданные проекты.</>
        )}
      </div>

      <div className="tpl-tabs" role="tablist" aria-label="Разделы шаблона">
        {TEMPLATE_TABS.map((id) => (
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

      {bulk && (
        <BulkApplyModal
          key={t.id}
          template={t}
          state={state}
          candidates={candidates}
          onClose={() => setBulk(false)}
          onApplied={onProjectsChanged}
        />
      )}
    </>
  )
}

/** Название и описание шаблона: форма в шапке (window.prompt в Electron не работает). */
function RenameForm({ template, onCancel, onSave }: {
  template: ProjectTemplate
  onCancel(): void
  onSave(title: string, description: string): Promise<void>
}): React.JSX.Element {
  const [title, setTitle] = useState(template.title)
  const [description, setDescription] = useState(template.description ?? '')
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
        <input value={description} placeholder="Одна строка в карточке выбора типа" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="tpl-rename-btns">
        <button type="submit" className="btn-sm primary" disabled={!title.trim()}>Сохранить</button>
        <button type="button" className="btn-sm" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  )
}

/** «Правила доски» шаблона: копируются в `Project.agentRules` нового проекта. Сохраняются автоматически. */
function TemplateRules({ storageKey, text, readOnly, onSave }: {
  storageKey: string
  text: string
  readOnly: boolean
  onSave(text: string): Promise<void>
}): React.JSX.Element {
  const { draft, error, update } = useAutoSave(storageKey, text, onSave)
  return (
    <>
      <SectionHead
        title="Правила доски"
        hint="Markdown для агентов, запущенных доской: воркеры всех ролей и координатор получают его блоком «Правила проекта» в системном промпте. Копируется в новый проект."
      />
      <div className="agent-rules">
        <textarea
          value={draft}
          placeholder={AGENT_RULES_PLACEHOLDER}
          rows={12}
          spellCheck={false}
          readOnly={readOnly}
          aria-label="Правила для агентов доски"
          onChange={(e) => update(e.target.value, true)}
        />
        {error && <div className="editor-error">{error}</div>}
      </div>
    </>
  )
}
