import type React from 'react'
import { useEffect, useState } from 'react'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES,
  type AgentInfo, type AgentKind, type BoardColumn, type Role, type Run, type Task
} from '@orca-board/core'
import type { AppSettings, PermissionMode, Project, ProjectDefaults } from '../../../shared/ipc'
import { RolesEditor } from '../RolesEditor'
import { ColumnsEditor } from '../ColumnsEditor'
import { RunsSection } from '../runs'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { SectionHead } from './parts'
import { OverviewSection } from './OverviewSection'
import { AgentsSection } from './AgentsSection'
import { PermissionsSection, permissionParts } from './PermissionsSection'
import { AppSection } from './AppSection'
import { defaultsDiff } from './defaultsDiff'

/** Что редактирует вкладка: активный проект или дефолт для новых проектов (projects:getDefaults/setDefaults). */
export type AboutScope = 'project' | 'defaults'

type Section = 'overview' | 'agents' | 'roles' | 'columns' | 'perm' | 'runs' | 'app'

const SECTIONS: Section[] = ['overview', 'agents', 'roles', 'columns', 'perm', 'runs', 'app']
/** Разделы, которых у дефолта нет: при переключении на «Для новых проектов» уходим в «Агенты». */
const PROJECT_ONLY: ReadonlySet<Section> = new Set(['overview', 'runs'])
const SECTION_KEY = 'orca.aboutSection'
/** Ключ черновиков редакторов ролей/колонок дефолта (не пересекается с id проектов). */
const DEFAULTS_KEY = 'defaults'

function storedSection(): Section {
  try {
    const v = localStorage.getItem(SECTION_KEY) as Section | null
    return v && SECTIONS.includes(v) ? v : 'overview'
  } catch {
    return 'overview'
  }
}

function storeSection(s: Section): void {
  try {
    localStorage.setItem(SECTION_KEY, s)
  } catch {
    // localStorage недоступен — раздел просто не переживёт перезапуск
  }
}

interface Props {
  /** Активный проект; null — доступен только режим «Для новых проектов». */
  project: Project | null
  scope: AboutScope
  onScope(scope: AboutScope): void
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
 * Вкладка «О проекте»: меню разделов слева, один раздел справа. Переключатель над меню выбирает,
 * что редактируется — этот проект или дефолт для новых проектов; разделы одни и те же.
 */
export function AboutProject(props: Props): React.JSX.Element {
  const { project, agents, tasks, runs, terminals, socketPath, onProjectChanged, onRefreshAgents, onRemoveProject } = props
  const scope: AboutScope = project ? props.scope : 'defaults'
  const isDefaults = scope === 'defaults'
  const [pick, setPick] = useState<Section>(storedSection)
  const section: Section = isDefaults && PROJECT_ONLY.has(pick) ? 'agents' : pick

  const [defaults, setDefaults] = useState<ProjectDefaults | null>(null)
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [permError, setPermError] = useState<string | null>(null)
  /** Растёт после «Применить дефолт»: пересоздаёт редакторы ролей/колонок, чтобы черновик взял новые значения. */
  const [rev, setRev] = useState(0)

  function loadDefaults(): void {
    window.orca.projects.getDefaults().then(
      (d) => {
        setDefaults(d)
        setDefaultsError(null)
      },
      (e) => setDefaultsError(ipcErrorMessage(e))
    )
  }

  useEffect(() => {
    loadDefaults()
    window.orca.app.getSettings().then(setAppSettings, (e) => setAppError(ipcErrorMessage(e)))
  }, [])

  // Ошибки разделов относятся к тому, что редактировалось: при смене режима/проекта сбрасываем.
  useEffect(() => {
    setAgentsError(null)
    setPermError(null)
  }, [scope, project?.id])

  function go(s: Section): void {
    setPick(s)
    storeSection(s)
  }

  // ---------- сохранение ----------

  /** Патч дефолта; ошибка — в setError раздела, а без него — наружу (автосохранению редактора). */
  async function saveDefaults(patch: Partial<ProjectDefaults>, setError?: (e: string | null) => void): Promise<void> {
    try {
      setDefaults(await window.orca.projects.setDefaults(patch))
      setError?.(null)
    } catch (e) {
      if (!setError) throw e
      setError(ipcErrorMessage(e))
    }
  }

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

  async function saveApp(patch: Partial<AppSettings>): Promise<void> {
    try {
      setAppSettings(await window.orca.app.setSettings(patch))
      setAppError(null)
    } catch (e) {
      setAppError(ipcErrorMessage(e))
    }
  }

  /** Текущие настройки проекта → дефолт для новых проектов. */
  async function makeDefault(p: Project): Promise<void> {
    if (!confirm(`Сохранить настройки проекта «${p.name}» (агенты, роли, колонки, разрешения) как дефолт для новых проектов?`)) return
    await saveDefaults(
      {
        permissionMode: p.permissionMode ?? 'auto',
        enabledAgents: p.enabledAgents,
        roles: p.roles ?? DEFAULT_ROLES,
        columns: p.columns ?? DEFAULT_COLUMNS
      },
      setDefaultsError
    )
  }

  /** Переписать настройки проекта дефолтом; задачи из исчезнувших колонок уезжают в бэклог. */
  async function applyDefault(p: Project): Promise<void> {
    const ok = confirm(
      `Заменить агентов, роли, колонки и разрешения проекта «${p.name}» настройками по умолчанию?\n\n` +
        'Задачи из колонок, которых нет в дефолте, переедут в бэклог.'
    )
    if (!ok) return
    await saveProject(() => window.orca.projects.applyDefaults(p.id), setDefaultsError)
    setRev((r) => r + 1)
  }

  async function removeProject(p: Project): Promise<void> {
    if (!confirm(`Убрать проект «${p.name}» из списка?\n\nРепозиторий и worktree на диске не удаляются.`)) return
    await onRemoveProject(p)
  }

  // ---------- данные режима ----------

  const allDefaultAgents = defaults !== null && defaults.enabledAgents === undefined
  // Для дефолта «включённость» агента — по дефолту, а не по активному проекту.
  const scopeAgents: AgentInfo[] = isDefaults
    ? agents.map((a) => ({ ...a, enabled: a.installed && (allDefaultAgents || !!defaults?.enabledAgents?.includes(a.id)) }))
    : agents
  const roles: Role[] = (isDefaults ? defaults?.roles : project?.roles ?? DEFAULT_ROLES) ?? []
  const columns: BoardColumn[] = (isDefaults ? defaults?.columns : project?.columns ?? DEFAULT_COLUMNS) ?? []
  const permission: PermissionMode = (isDefaults ? defaults?.permissionMode : project?.permissionMode) ?? 'auto'
  const ready = !isDefaults || defaults !== null

  const installed = scopeAgents.filter((a) => a.installed)
  const agentsOn = installed.filter((a) => a.enabled).length
  const agentOk = new Set(scopeAgents.filter((a) => a.enabled).map((a) => a.id as string))
  const rolesOff = roles.filter((r) => !agentOk.has(r.agent)).length
  const liveRuns = runs.filter((r) => !r.inbox && r.closedAt === undefined).length
  const doneIds = new Set(columns.filter((c) => c.kind === 'done').map((c) => c.id))
  const roleTaskCounts: Record<string, number> = {}
  for (const t of tasks) roleTaskCounts[t.roleId] = (roleTaskCounts[t.roleId] ?? 0) + 1

  function toggleAgent(id: AgentKind, on: boolean): void {
    if (isDefaults) {
      const next = agents.filter((a) => (a.id === id ? on : scopeAgents.find((x) => x.id === a.id)?.enabled)).map((a) => a.id)
      void saveDefaults({ enabledAgents: next }, setAgentsError)
      return
    }
    if (!project) return
    const next = agents.filter((a) => (a.id === id ? on : a.enabled)).map((a) => a.id)
    void saveProject(() => window.orca.projects.setEnabledAgents(project.id, next), setAgentsError)
  }

  function setPermission(mode: PermissionMode): void {
    if (isDefaults) void saveDefaults({ permissionMode: mode }, setPermError)
    else if (project) void saveProject(() => window.orca.projects.setPermissionMode(project.id, mode), setPermError)
  }

  // ---------- меню ----------

  const nav: { id: Section; label: string; icon: () => React.JSX.Element; count?: string; tone?: 'warn' | 'live' }[] = [
    { id: 'overview', label: 'Обзор', icon: Icon.info },
    { id: 'agents', label: 'Агенты', icon: Icon.cpu, count: `${agentsOn} из ${installed.length}` },
    {
      id: 'roles', label: 'Роли', icon: Icon.users,
      count: rolesOff ? `${roles.length} · ${rolesOff} !` : String(roles.length),
      tone: rolesOff ? 'warn' : undefined
    },
    { id: 'columns', label: 'Колонки', icon: Icon.columns, count: String(columns.length) },
    { id: 'perm', label: 'Разрешения', icon: Icon.shield, count: permissionParts(permission).title },
    {
      id: 'runs', label: 'Прогоны', icon: Icon.runs,
      count: liveRuns ? `${liveRuns} идёт` : String(runs.filter((r) => !r.inbox).length),
      tone: liveRuns ? 'live' : undefined
    }
  ]

  const navItem = (item: { id: Section; label: string; icon: () => React.JSX.Element; count?: string; tone?: string }): React.JSX.Element => (
    <button
      key={item.id}
      type="button"
      className={`about-nav-item ${section === item.id ? 'on' : ''}`}
      aria-current={section === item.id ? 'page' : undefined}
      title={item.id === 'roles' && rolesOff ? `Ролей с выключенным агентом: ${rolesOff}` : undefined}
      onClick={() => go(item.id)}
    >
      <item.icon />
      <span className="about-nav-label">{item.label}</span>
      {ready && item.count && <span className={`about-nav-count ${item.tone ?? ''}`}>{item.count}</span>}
    </button>
  )

  // ---------- разделы ----------

  function renderSection(): React.ReactNode {
    if (section === 'app') return <AppSection settings={appSettings} error={appError} onChange={(p) => void saveApp(p)} />
    if (!ready) {
      return defaultsError ? <div className="editor-error">{defaultsError}</div> : <div className="muted">Загрузка…</div>
    }
    const editorKey = `${isDefaults ? DEFAULTS_KEY : project!.id}:${rev}`
    switch (section) {
      case 'overview':
        return project && (
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
            onMakeDefault={() => void makeDefault(project)}
            onApplyDefault={() => void applyDefault(project)}
            onRemove={() => void removeProject(project)}
          />
        )
      case 'agents':
        return (
          <AgentsSection
            agents={scopeAgents}
            all={isDefaults ? { on: allDefaultAgents, onChange: (on) => void saveDefaults({
              enabledAgents: on ? undefined : installed.map((a) => a.id)
            }, setAgentsError) } : undefined}
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
              storageKey={isDefaults ? DEFAULTS_KEY : project!.id}
              roles={roles}
              agents={scopeAgents}
              taskCounts={isDefaults ? undefined : roleTaskCounts}
              onSave={async (next) => {
                if (isDefaults) return saveDefaults({ roles: next })
                await window.orca.projects.setRoles(project!.id, next)
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
              storageKey={isDefaults ? DEFAULTS_KEY : project!.id}
              columns={columns}
              onSave={async (next) => {
                if (isDefaults) return saveDefaults({ columns: next })
                await window.orca.projects.setColumns(project!.id, next)
                await onProjectChanged()
              }}
            />
          </>
        )
      case 'perm':
        return <PermissionsSection value={permission} error={permError} onChange={setPermission} />
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
    <div className={`about ${isDefaults ? 'scope-defaults' : ''}`}>
      <nav className="about-nav" aria-label="Разделы">
        <div className="about-scope" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!isDefaults}
            className={isDefaults ? '' : 'on'}
            disabled={!project}
            title={project ? undefined : 'Нет активного проекта'}
            onClick={() => props.onScope('project')}
          >
            Этот проект
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isDefaults}
            className={isDefaults ? 'on' : ''}
            onClick={() => props.onScope('defaults')}
          >
            Для новых проектов
          </button>
        </div>
        {nav.filter((item) => !isDefaults || !PROJECT_ONLY.has(item.id)).map(navItem)}
        <div className="about-nav-group">Приложение</div>
        {navItem({ id: 'app', label: 'Общие', icon: Icon.gear })}
      </nav>
      <div className="about-pane">
        <section className="about-sec">
          {isDefaults && section !== 'app' && (
            <div className="about-banner">
              Вы редактируете <b>дефолт для новых проектов</b>. Существующие проекты не меняются — применить дефолт
              к проекту можно в его «Обзоре».
            </div>
          )}
          {renderSection()}
        </section>
      </div>
    </div>
    </div>
  )
}
