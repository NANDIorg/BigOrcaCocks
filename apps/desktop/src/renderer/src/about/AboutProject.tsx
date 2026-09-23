import type React from 'react'
import { useEffect, useState } from 'react'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES,
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
import { agentRulesCount } from '../agentRules'
import { defaultsDiff } from './defaultsDiff'
import { useProjectDefaults } from './useProjectDefaults'

type Section = 'overview' | 'agents' | 'roles' | 'columns' | 'perm' | 'agentRules' | 'rules' | 'runs'

const SECTIONS: readonly Section[] = ['overview', 'agents', 'roles', 'columns', 'perm', 'agentRules', 'rules', 'runs']
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
 * Дефолт для новых проектов редактируется в «Настройках» (шестерёнка в rail), здесь — только сравнение с ним.
 */
export function AboutProject(props: Props): React.JSX.Element {
  const { project, agents, tasks, runs, terminals, socketPath, onProjectChanged, onRefreshAgents, onRemoveProject } = props
  const [section, setSection] = useState<Section>(() => storedSection(SECTION_KEY, SECTIONS, 'overview'))

  const { defaults, error: defaultsError, setError: setDefaultsError, save: saveDefaults } = useProjectDefaults()
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [permError, setPermError] = useState<string | null>(null)
  /** Растёт после «Применить дефолт»: пересоздаёт редакторы ролей/колонок, чтобы черновик взял новые значения. */
  const [rev, setRev] = useState(0)

  // Ошибки разделов относятся к проекту: при его смене сбрасываем.
  useEffect(() => {
    setAgentsError(null)
    setPermError(null)
  }, [project.id])

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
    if (!confirm(`Сохранить настройки проекта «${project.name}» (агенты, роли, колонки, разрешения, правила доски) как дефолт для новых проектов?`)) return
    await saveDefaults(
      {
        permissionMode: project.permissionMode ?? 'auto',
        enabledAgents: project.enabledAgents,
        roles: project.roles ?? DEFAULT_ROLES,
        columns: project.columns ?? DEFAULT_COLUMNS,
        agentRules: project.agentRules ?? ''
      },
      setDefaultsError
    )
  }

  /** Переписать настройки проекта дефолтом; задачи из исчезнувших колонок уезжают в бэклог. */
  async function applyDefault(): Promise<void> {
    const ok = confirm(
      `Заменить агентов, роли, колонки, разрешения и правила доски проекта «${project.name}» настройками по умолчанию?\n\n` +
        'Задачи из колонок, которых нет в дефолте, переедут в бэклог.'
    )
    if (!ok) return
    await saveProject(() => window.orca.projects.applyDefaults(project.id), setDefaultsError)
    setRev((r) => r + 1)
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
  const roleTaskCounts: Record<string, number> = {}
  for (const t of tasks) roleTaskCounts[t.roleId] = (roleTaskCounts[t.roleId] ?? 0) + 1

  function toggleAgent(id: AgentKind, on: boolean): void {
    const next = agents.filter((a) => (a.id === id ? on : a.enabled)).map((a) => a.id)
    void saveProject(() => window.orca.projects.setEnabledAgents(project.id, next), setAgentsError)
  }

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
    </div>
  )
}
