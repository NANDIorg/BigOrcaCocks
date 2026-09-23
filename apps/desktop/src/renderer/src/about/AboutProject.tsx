import type React from 'react'
import { useEffect, useState } from 'react'
import { DEFAULT_COLUMNS, type AgentInfo, type AgentKind, type BoardColumn, type Run, type Task } from '@orca-board/core'
import type { Project } from '../../../shared/ipc'
import { ColumnsEditor } from '../ColumnsEditor'
import { RunsSection } from '../runs'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { NavItem, SectionHead, storeSection, storedSection, type NavEntry } from './parts'
import { OverviewSection } from './OverviewSection'
import { AgentsSection } from './AgentsSection'
import { RulesSection } from './RulesSection'
import { TaskTypesSection } from './TaskTypesSection'

/** Роли, воркфлоу, разрешения и правила доски ушли в тип задачи («Настройки → Типы задач»). */
type Section = 'overview' | 'agents' | 'columns' | 'types' | 'rules' | 'runs'

const SECTIONS: readonly Section[] = ['overview', 'agents', 'columns', 'types', 'rules', 'runs']
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
    if (!confirm(`Убрать проект «${project.name}» из списка?\n\nРепозиторий и worktree на диске не удаляются.`)) return
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
    { id: 'overview', label: 'Обзор', icon: Icon.info },
    { id: 'agents', label: 'Агенты', icon: Icon.cpu, count: `${agentsOn} из ${installed.length}` },
    { id: 'columns', label: 'Колонки', icon: Icon.columns, count: String(columns.length) },
    {
      id: 'types', label: 'Типы задач', icon: Icon.layers, count: project.taskTypeIds ? String(project.taskTypeIds.length) : 'все',
      title: 'Какие типы глобальных задач доступны в проекте и какой по умолчанию'
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
            <SectionHead title="Колонки" hint="Порядок, название и цвет. Системные нельзя удалить — по ним работает автоматика." />
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
