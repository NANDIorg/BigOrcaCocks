import type React from 'react'
import { useEffect, useState } from 'react'
import { DEFAULT_COLUMNS, normalizeRunBranchSettings, type AgentInfo, type AgentKind, type BoardColumn, type Run, type Task } from '@orca-board/core'
import type { Project } from '../../../shared/ipc'
import { ColumnsEditor } from '../ColumnsEditor'
import { RunsSection } from '../runs'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { useT } from '../i18n'
import { NavItem, SectionHead, storeSection, storedSection, type NavEntry } from './parts'
import { OverviewSection } from './OverviewSection'
import { AgentsSection } from './AgentsSection'
import { RulesSection } from './RulesSection'
import { TaskTypesSection } from './TaskTypesSection'
import { GitSection } from './GitSection'

/** Роли, воркфлоу, разрешения и правила доски ушли в тип задачи («Настройки → Типы задач»). */
type Section = 'overview' | 'agents' | 'columns' | 'types' | 'git' | 'rules' | 'runs'

const SECTIONS: readonly Section[] = ['overview', 'agents', 'columns', 'types', 'git', 'rules', 'runs']
const SECTION_KEY = 'orca.aboutSection'
/** Разделы до типов задач: их содержимое теперь у типа — ведём в «Типы задач». */
const TYPE_SECTIONS_OLD = ['roles', 'workflow', 'perm', 'agentRules']

/** Запомненный раздел; бывшие разделы настроек проекта ведут в «Типы задач». */
function initialSection(): Section {
  try {
    if (TYPE_SECTIONS_OLD.includes(localStorage.getItem(SECTION_KEY) ?? '')) return 'types'
  } catch {
    // localStorage недоступен — см. storedSection
  }
  return storedSection(SECTION_KEY, SECTIONS, 'overview')
}

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
 * Вкладка «О проекте»: меню разделов слева, один раздел справа; всё — про активный проект. Свои у проекта —
 * агенты, колонки и типы задач (какие доступны и какой по умолчанию); роли, воркфлоу, разрешения и правила доски
 * задаёт тип глобальной задачи, он правится в «Настройках» (шестерёнка в rail).
 */
export function AboutProject(props: Props): React.JSX.Element {
  const { project, agents, tasks, runs, terminals, socketPath, onProjectChanged, onRefreshAgents, onRemoveProject } = props
  const t = useT()
  const [section, setSection] = useState<Section>(initialSection)
  const [agentsError, setAgentsError] = useState<string | null>(null)

  // Ошибки разделов относятся к проекту: при его смене сбрасываем.
  useEffect(() => {
    setAgentsError(null)
  }, [project.id])

  function go(s: Section): void {
    setSection(s)
    storeSection(SECTION_KEY, s)
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

  async function removeProject(): Promise<void> {
    if (!confirm(t('config.about.removeConfirm', { name: project.name }))) return
    await onRemoveProject(project)
  }

  // ---------- данные ----------

  const columns: BoardColumn[] = project.columns ?? DEFAULT_COLUMNS
  const installed = agents.filter((a) => a.installed)
  const agentsOn = installed.filter((a) => a.enabled).length
  const liveRuns = runs.filter((r) => !r.inbox && r.closedAt === undefined).length
  const doneIds = new Set(columns.filter((c) => c.kind === 'done').map((c) => c.id))

  function toggleAgent(id: AgentKind, on: boolean): void {
    const next = agents.filter((a) => (a.id === id ? on : a.enabled)).map((a) => a.id)
    void saveProject(() => window.orca.projects.setEnabledAgents(project.id, next), setAgentsError)
  }

  // ---------- меню ----------

  const nav: NavEntry<Section>[] = [
    { id: 'overview', label: t('config.about.nav.overview'), icon: Icon.info },
    {
      id: 'agents', label: t('config.about.nav.agents'), icon: Icon.cpu,
      count: t('config.about.nav.agentsCount', { on: agentsOn, total: installed.length })
    },
    { id: 'columns', label: t('config.about.nav.columns'), icon: Icon.columns, count: String(columns.length) },
    {
      id: 'types', label: t('config.about.nav.types'), icon: Icon.layers,
      count: project.taskTypeIds ? String(project.taskTypeIds.length) : t('config.about.nav.typesAll'),
      title: t('config.about.nav.typesTitle')
    },
    {
      id: 'git', label: t('config.about.nav.git'), icon: Icon.branch, title: t('config.about.nav.gitTitle'),
      count: normalizeRunBranchSettings(project.git).enabled ? t('config.about.nav.gitOn') : t('config.about.nav.gitOff')
    },
    { id: 'rules', label: t('config.about.nav.rules'), icon: Icon.doc, title: t('config.about.nav.rulesTitle') },
    {
      id: 'runs', label: t('config.about.nav.runs'), icon: Icon.runs,
      count: liveRuns ? t('config.about.nav.runsLive', { count: liveRuns }) : String(runs.filter((r) => !r.inbox).length),
      tone: liveRuns ? 'live' : undefined
    }
  ]

  // ---------- разделы ----------

  function renderSection(): React.ReactNode {
    switch (section) {
      case 'overview':
        return (
          <OverviewSection
            project={project}
            socketPath={socketPath}
            stats={{
              tasks: tasks.length,
              openTasks: tasks.filter((task) => !doneIds.has(task.status)).length,
              terminals,
              liveRuns,
              agentsOn
            }}
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
      case 'columns':
        return (
          <>
            <SectionHead title={t('config.about.nav.columns')} hint={t('config.about.columns.hint')} />
            <ColumnsEditor
              key={project.id}
              storageKey={project.id}
              columns={columns}
              onSave={async (next) => {
                await window.orca.projects.setColumns(project.id, next)
                await onProjectChanged()
              }}
            />
          </>
        )
      case 'types':
        return <TaskTypesSection key={project.id} project={project} agents={agents} onProjectChanged={onProjectChanged} />
      case 'git':
        return <GitSection project={project} onProjectChanged={onProjectChanged} />
      case 'rules':
        return <RulesSection key={project.id} root={project.root} />
      case 'runs':
        return (
          <>
            <SectionHead title={t('config.about.nav.runs')} hint={t('config.about.runs.hint')} />
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
        <nav className="about-nav" aria-label={t('config.about.navAria')}>
          {nav.map((item) => <NavItem key={item.id} item={item} current={section} onGo={go} />)}
        </nav>
        <div className="about-pane">
          <section className="about-sec">{renderSection()}</section>
        </div>
      </div>
    </div>
  )
}
