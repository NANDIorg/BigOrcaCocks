import type React from 'react'
import { useEffect, useState } from 'react'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, TEMPLATE_SECTIONS, validateWorkflow,
  type AgentInfo, type AgentKind, type BoardColumn, type Role, type Run, type Task
} from '@orca-board/core'
import type { PermissionMode, Project } from '../../../shared/ipc'
import { RolesEditor } from '../RolesEditor'
import { ColumnsEditor } from '../ColumnsEditor'
import { RunsSection } from '../runs'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { NavItem, SectionHead, storeSection, storedSection, type NavEntry } from './parts'
import { OverviewSection } from './OverviewSection'
import { AgentsSection } from './AgentsSection'
import { PermissionsSection, permissionParts } from './PermissionsSection'
import { RulesSection } from './RulesSection'
import { AgentRulesSection } from './AgentRulesSection'
import { WorkflowSection } from './WorkflowSection'
import { agentRulesCount } from '../agentRules'
import { defaultsDiff } from './defaultsDiff'
import { useProjectDefaults } from './useProjectDefaults'
import { useProjectTemplates } from './useProjectTemplates'
import { ProjectTypeBox } from './ProjectTypeBox'
import { ApplyTemplateModal } from './ApplyTemplateModal'
import { SaveTemplateModal, type SaveTemplateRequest } from './SaveTemplateModal'
import { projectAsTemplateSettings, projectBase, templateDiffRows, type ApplyRequest } from '../projectType'

type Section = 'overview' | 'agents' | 'roles' | 'columns' | 'workflow' | 'perm' | 'agentRules' | 'rules' | 'runs'

const SECTIONS: readonly Section[] = ['overview', 'agents', 'roles', 'columns', 'workflow', 'perm', 'agentRules', 'rules', 'runs']
const SECTION_KEY = 'orca.aboutSection'

interface Props {
  project: Project
  /** Агенты реестра; enabled — по активному проекту. */
  agents: AgentInfo[]
  tasks: Task[]
  runs: Run[]
  /** Открытых терминалов проекта. */
  terminals: number
  socketPath: string
  /** Перечитать проекты (и агентов) после правки настроек проекта. */
  onProjectChanged(): Promise<void>
  /** Заново просканировать PATH. */
  onRefreshAgents(): Promise<void>
  onRemoveProject(p: Project): Promise<void>
}

/**
 * Вкладка «О проекте»: меню разделов слева, один раздел справа; всё — про активный проект.
 * Шаблоны проектов редактируются в «Настройках» (шестерёнка в rail), здесь — тип проекта, сравнение с его
 * шаблоном и выборочное применение разделов. Старый preload без шаблонов — прежнее сравнение с дефолтом.
 */
export function AboutProject(props: Props): React.JSX.Element {
  const { project, agents, tasks, runs, terminals, socketPath, onProjectChanged, onRefreshAgents, onRemoveProject } = props
  const [section, setSection] = useState<Section>(() => storedSection(SECTION_KEY, SECTIONS, 'overview'))

  const { defaults, error: defaultsError, setError: setDefaultsError, save: saveDefaults } = useProjectDefaults()
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [permError, setPermError] = useState<string | null>(null)
  /** Растёт после «Применить дефолт»: пересоздаёт редакторы ролей/колонок, чтобы черновик взял новые значения. */
  const [rev, setRev] = useState(0)
  const templates = useProjectTemplates()
  const { reload: reloadTemplates } = templates
  /** Открытый диалог применения шаблона: «Сменить тип…» или «Взять из шаблона» у строки отличий. */
  const [applying, setApplying] = useState<{ mode: 'type' | 'take'; req: ApplyRequest } | null>(null)
  const [savingTemplate, setSavingTemplate] = useState(false)

  // Ошибки разделов и диалоги относятся к проекту: при его смене сбрасываем.
  useEffect(() => {
    setAgentsError(null)
    setPermError(null)
    setApplying(null)
    setSavingTemplate(false)
  }, [project.id])

  // Шаблоны могли поменять в «Настройках» — перечитываем, когда открывают «Обзор».
  useEffect(() => {
    if (section === 'overview') void reloadTemplates()
  }, [section, reloadTemplates])

  function go(s: Section): void {
    setSection(s)
    storeSection(SECTION_KEY, s)
  }

  // ---------- сохранение ----------

  /** Действие над проектом, затем перечитать проекты; ошибка — в setError раздела. */
  async function saveProject(action: () => Promise<unknown>, setError: (e: string | null) => void): Promise<void> {
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
    await onProjectChanged()
  }

  /** Текущие настройки проекта → дефолт для новых проектов. */
  async function makeDefault(): Promise<void> {
    if (!confirm(`Сохранить настройки проекта «${project.name}» (агенты, роли, колонки, воркфлоу, разрешения, правила доски) как дефолт для новых проектов?`)) return
    await saveDefaults(
      {
        permissionMode: project.permissionMode ?? 'auto',
        enabledAgents: project.enabledAgents,
        roles: project.roles ?? DEFAULT_ROLES,
        columns: project.columns ?? DEFAULT_COLUMNS,
        agentRules: project.agentRules ?? '',
        // Нет своего графа — и в дефолте его не будет: новый проект получит граф по своим ролям.
        workflow: project.workflow
      },
      setDefaultsError
    )
  }

  /** Переписать настройки проекта дефолтом; задачи из исчезнувших колонок уезжают в бэклог. */
  async function applyDefault(): Promise<void> {
    const ok = confirm(
      `Заменить агентов, роли, колонки, воркфлоу, разрешения и правила доски проекта «${project.name}» настройками по умолчанию?\n\n` +
        'Задачи из колонок, которых нет в дефолте, переедут в бэклог.'
    )
    if (!ok) return
    await saveProject(() => window.orca.projects.applyDefaults(project.id), setDefaultsError)
    setRev((r) => r + 1)
  }

  /** Взять разделы шаблона в проект (`projects:applyTemplate`); ошибка main — наружу, в диалог. */
  async function applyTemplate(req: ApplyRequest): Promise<void> {
    const api = templates.api
    if (!api) return
    await api.applyTemplate(project.id, req.templateId, req.sections, req.roleIds)
    setApplying(null)
    setRev((r) => r + 1)
    await onProjectChanged()
  }

  /** Настройки проекта → новый или перезаписанный пользовательский шаблон; `adopt` — сделать его типом проекта. */
  async function saveAsTemplate(req: SaveTemplateRequest): Promise<void> {
    const api = templates.api
    if (!api) return
    const saved = await api.templates.save({
      ...(req.id ? { id: req.id } : {}),
      title: req.title,
      ...(req.description ? { description: req.description } : {}),
      settings: projectAsTemplateSettings(project)
    })
    await reloadTemplates()
    if (req.adopt) {
      // Настройки шаблона — копия проекта, так что применение всех разделов меняет только templateId.
      try {
        await api.applyTemplate(project.id, saved.id, [...TEMPLATE_SECTIONS])
      } catch (e) {
        throw new Error(`шаблон «${saved.title}» сохранён, но не стал типом проекта: ${ipcErrorMessage(e)}`)
      }
      setRev((r) => r + 1)
      await onProjectChanged()
    }
    setSavingTemplate(false)
  }

  async function removeProject(): Promise<void> {
    if (!confirm(`Убрать проект «${project.name}» из списка?\n\nРепозиторий и worktree на диске не удаляются.`)) return
    await onRemoveProject(project)
  }

  // ---------- данные ----------

  const roles: Role[] = project.roles ?? DEFAULT_ROLES
  const columns: BoardColumn[] = project.columns ?? DEFAULT_COLUMNS
  const permission: PermissionMode = project.permissionMode ?? 'auto'

  const installed = agents.filter((a) => a.installed)
  const agentsOn = installed.filter((a) => a.enabled).length
  const agentOk = new Set(agents.filter((a) => a.enabled).map((a) => a.id as string))
  const rolesOff = roles.filter((r) => !agentOk.has(r.agent)).length
  const liveRuns = runs.filter((r) => !r.inbox && r.closedAt === undefined).length
  const doneIds = new Set(columns.filter((c) => c.kind === 'done').map((c) => c.id))
  // Свой граф мог сломаться после сохранения (удалили роль или колонку) — подсветить раздел в меню.
  const workflowErrors = project.workflow
    ? validateWorkflow(project.workflow, { roles, columns }).errors.length
    : 0
  const roleTaskCounts: Record<string, number> = {}
  for (const t of tasks) roleTaskCounts[t.roleId] = (roleTaskCounts[t.roleId] ?? 0) + 1

  function toggleAgent(id: AgentKind, on: boolean): void {
    const next = agents.filter((a) => (a.id === id ? on : a.enabled)).map((a) => a.id)
    void saveProject(() => window.orca.projects.setEnabledAgents(project.id, next), setAgentsError)
  }

  const base = templates.state ? projectBase(project, templates.state) : null
  const typeRows = base ? templateDiffRows(project, base.template.settings, agents) : []

  // ---------- меню ----------

  const nav: NavEntry<Section>[] = [
    { id: 'overview', label: 'Обзор', icon: Icon.info },
    { id: 'agents', label: 'Агенты', icon: Icon.cpu, count: `${agentsOn} из ${installed.length}` },
    {
      id: 'roles', label: 'Роли', icon: Icon.users,
      count: rolesOff ? `${roles.length} · ${rolesOff} !` : String(roles.length),
      tone: rolesOff ? 'warn' : undefined,
      title: rolesOff ? `Ролей с выключенным агентом: ${rolesOff}` : undefined
    },
    { id: 'columns', label: 'Колонки', icon: Icon.columns, count: String(columns.length) },
    {
      id: 'workflow', label: 'Воркфлоу', icon: Icon.workflow,
      count: workflowErrors ? `свой · ${workflowErrors} !` : project.workflow ? 'свой' : 'дефолт',
      tone: workflowErrors ? 'warn' : undefined,
      title: workflowErrors ? `Ошибок в графе: ${workflowErrors} — задачи остановятся на сломанных этапах` : undefined
    },
    { id: 'perm', label: 'Разрешения', icon: Icon.shield, count: permissionParts(permission).title },
    {
      id: 'agentRules', label: 'Правила доски', icon: Icon.layers, count: agentRulesCount(project.agentRules),
      title: 'Только для воркеров и координатора доски; не CLAUDE.md'
    },
    { id: 'rules', label: 'Правила', icon: Icon.doc, title: 'CLAUDE.md и AGENTS.md в корне репозитория' },
    {
      id: 'runs', label: 'Прогоны', icon: Icon.runs,
      count: liveRuns ? `${liveRuns} идёт` : String(runs.filter((r) => !r.inbox).length),
      tone: liveRuns ? 'live' : undefined
    }
  ]

  // ---------- разделы ----------

  function renderSection(): React.ReactNode {
    const editorKey = `${project.id}:${rev}`
    switch (section) {
      case 'overview':
        return (
          <OverviewSection
            project={project}
            socketPath={socketPath}
            stats={{
              tasks: tasks.length,
              openTasks: tasks.filter((t) => !doneIds.has(t.status)).length,
              terminals,
              liveRuns,
              agentsOn
            }}
            diff={defaults ? defaultsDiff(project, defaults, agents) : null}
            defaultsError={defaultsError}
            onMakeDefault={() => void makeDefault()}
            onApplyDefault={() => void applyDefault()}
            onRemove={() => void removeProject()}
            typeBox={templates.api ? (
              <ProjectTypeBox
                base={base}
                rows={typeRows}
                error={templates.error}
                onChangeType={() => base && setApplying({
                  mode: 'type',
                  req: { templateId: base.template.id, sections: [...TEMPLATE_SECTIONS] }
                })}
                onTake={(s, roleId) => base && setApplying({
                  mode: 'take',
                  req: { templateId: base.template.id, sections: [s], ...(roleId ? { roleIds: [roleId] } : {}) }
                })}
                onSaveAsTemplate={() => setSavingTemplate(true)}
              />
            ) : undefined}
          />
        )
      case 'agents':
        return (
          <AgentsSection
            agents={agents}
            error={agentsError}
            onToggle={toggleAgent}
            onRefresh={() => void onRefreshAgents()}
          />
        )
      case 'roles':
        return (
          <>
            <SectionHead title="Роли" hint="Кто выполняет задачи: агент, модель, усилие и инструкция. Порядок — как в «Новой задаче»." />
            <RolesEditor
              key={editorKey}
              storageKey={project.id}
              roles={roles}
              agents={agents}
              taskCounts={roleTaskCounts}
              workflow={project.workflow}
              onSave={async (next) => {
                await window.orca.projects.setRoles(project.id, next)
                await onProjectChanged()
              }}
            />
          </>
        )
      case 'columns':
        return (
          <>
            <SectionHead title="Колонки" hint="Порядок, название и цвет. Системные нельзя удалить — по ним работает автоматика." />
            <ColumnsEditor
              key={editorKey}
              storageKey={project.id}
              columns={columns}
              onSave={async (next) => {
                await window.orca.projects.setColumns(project.id, next)
                await onProjectChanged()
              }}
            />
          </>
        )
      case 'workflow':
        return (
          <WorkflowSection
            key={editorKey}
            project={project}
            roles={roles}
            columns={columns}
            agents={agents}
            onProjectChanged={onProjectChanged}
            saveDefaults={saveDefaults}
          />
        )
      case 'perm':
        return (
          <PermissionsSection
            value={permission}
            error={permError}
            onChange={(mode) => void saveProject(() => window.orca.projects.setPermissionMode(project.id, mode), setPermError)}
          />
        )
      case 'agentRules':
        return <AgentRulesSection key={project.id} project={project} onSaved={onProjectChanged} />
      case 'rules':
        return <RulesSection key={project.id} root={project.root} />
      case 'runs':
        return (
          <>
            <SectionHead title="Прогоны" hint="Появляются при запуске координатора. Закрытый прогон остаётся в истории." />
            <RunsSection
              runs={runs}
              tasks={tasks}
              columns={columns}
              onClose={async (id) => {
                try {
                  await window.orca.runs.close(id)
                } catch (e) {
                  alert(ipcErrorMessage(e))
                }
              }}
            />
          </>
        )
    }
  }

  return (
    // Обёртка — контейнер для @container about: сетку .about меняет узкая ширина вкладки, а не окна.
    <div className="about-host">
      <div className="about">
        <nav className="about-nav" aria-label="Разделы">
          {nav.map((item) => <NavItem key={item.id} item={item} current={section} onGo={go} />)}
        </nav>
        <div className="about-pane">
          <section className="about-sec">{renderSection()}</section>
        </div>
      </div>
      {applying && templates.state && (
        <ApplyTemplateModal
          key={`${applying.mode}:${applying.req.sections.join()}:${applying.req.roleIds?.join() ?? ''}`}
          project={project}
          state={templates.state}
          tasks={tasks}
          mode={applying.mode}
          initial={applying.req}
          onClose={() => setApplying(null)}
          onApply={applyTemplate}
        />
      )}
      {savingTemplate && templates.state && (
        <SaveTemplateModal
          project={project}
          state={templates.state}
          onClose={() => setSavingTemplate(false)}
          onSave={saveAsTemplate}
        />
      )}
    </div>
  )
}
