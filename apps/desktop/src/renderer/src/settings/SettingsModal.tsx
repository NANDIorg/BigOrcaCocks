import type React from 'react'
import { useEffect, useState } from 'react'
import { DEFAULT_ROLES, type AgentInfo, type Role, type TaskType } from '@orca-board/core'
import type { AppSettings, AppSettingsPatch, Project } from '../../../shared/ipc'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { NavItem, storeSection, type NavEntry } from '../about/parts'
import {
  SETTINGS_SECTION_KEY, TASK_TYPE_TABS, libraryRoles, settingsTypeSection, pickTaskTypeId, taskTypeUsage, type TaskTypeTab
} from '../taskTypeEdit'
import { GeneralSection } from './GeneralSection'
import { NotificationsSection } from './NotificationsSection'
import { TaskTypePane } from './TaskTypePane'
import { useTaskTypes } from './useTaskTypes'

/** Раздел меню: общий, уведомления или тип задачи (`type:<id>`). */
type Section = 'general' | 'notifications' | `type:${string}`

const TAB_KEY = 'orca.settingsTypeTab'
const TYPE = 'type:'
/** Префикс разделов шаблонов проектов до типов задач: id встроенных и перенесённых шаблонов совпадают с id типов. */
const OLD_TPL = 'tpl:'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Запомненный раздел. Старые разделы шаблонов (`tpl:<id>`) и «Для новых проектов» ведут в типы задач. */
function initialSection(): Section {
  const v = stored(SETTINGS_SECTION_KEY)
  if (v === 'general' || v === 'notifications') return v
  if (v?.startsWith(TYPE)) return v as Section
  if (v?.startsWith(OLD_TPL)) return `${TYPE}${v.slice(OLD_TPL.length)}`
  return v ? `${TYPE}` : 'general'
}

function initialTab(): TaskTypeTab {
  const v = stored(TAB_KEY)
  return TASK_TYPE_TABS.find((t) => t === v) ?? 'roles'
}

interface Props {
  /** Агенты реестра; у типа своих агентов нет — в выборе все установленные. */
  agents: AgentInfo[]
  /** Заново просканировать PATH. */
  onRefreshAgents(): Promise<void>
  /** Типы изменились: перечитать проекты в приложении (роли типа по умолчанию, выбор типов в «О проекте»). */
  onProjectsChanged(): Promise<void>
  onClose(): void
}

/**
 * «Настройки» (шестерёнка в rail): общие настройки приложения и библиотека типов задач (taskTypes:*).
 * Вид — как у вкладки «О проекте»: меню разделов слева (каждый тип — пункт), раздел справа.
 */
export function SettingsModal({ agents, onProjectsChanged, onClose }: Props): React.JSX.Element {
  const [section, setSection] = useState<Section>(initialSection)
  const [tab, setTab] = useState<TaskTypeTab>(initialTab)
  const [projectList, setProjectList] = useState<Project[]>([])
  const types = useTaskTypes(reloadProjects)
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    window.orca.app.getSettings().then(setAppSettings, (e) => setAppError(ipcErrorMessage(e)))
    window.orca.projects.list().then((r) => setProjectList(r.projects), () => undefined)
  }, [])

  // Esc закрывает окно.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function go(s: Section): void {
    setSection(s)
    storeSection(SETTINGS_SECTION_KEY, s)
  }

  function goTab(t: TaskTypeTab): void {
    setTab(t)
    storeSection(TAB_KEY, t)
  }

  /** Показать тип; null — тип по умолчанию. */
  function selectType(id: string | null): void {
    go(settingsTypeSection(id ?? ''))
  }

  /** После записи в библиотеку: свой список проектов (использование) и список приложения (доска, «О проекте»). */
  async function reloadProjects(): Promise<void> {
    setProjectList((await window.orca.projects.list()).projects)
    await onProjectsChanged()
  }

  async function saveApp(patch: AppSettingsPatch): Promise<void> {
    try {
      setAppSettings(await window.orca.app.setSettings(patch))
      setAppError(null)
    } catch (e) {
      setAppError(ipcErrorMessage(e))
    }
  }

  async function createType(): Promise<void> {
    try {
      const t = await types.create({ title: 'Новый тип', settings: {} })
      setCreateError(null)
      selectType(t.id)
    } catch (e) {
      setCreateError(ipcErrorMessage(e))
    }
  }

  // ---------- типы ----------

  const state = types.state
  const usage = state ? taskTypeUsage(projectList, state) : {}
  const currentId = state && section.startsWith(TYPE) ? pickTaskTypeId(state, section.slice(TYPE.length)) : null
  const current: TaskType | undefined = state?.taskTypes.find((t) => t.id === currentId)

  // Роли для фильтра уведомлений: роли всех типов библиотеки; старый main без типов — встроенные.
  const notifyRoles: Role[] = state ? libraryRoles(state.taskTypes) : DEFAULT_ROLES

  // ---------- меню ----------

  const general: NavEntry<Section> = { id: 'general', label: 'Общие', icon: Icon.gear }
  const notifyOn = appSettings?.notifications.enabled
  const notifications: NavEntry<Section> = {
    id: 'notifications', label: 'Уведомления', icon: Icon.bell,
    count: notifyOn === undefined ? undefined : notifyOn ? 'вкл' : 'выкл'
  }
  /** Текущий пункт меню: у типа — с фактическим id (пустой `type:` после удаления — тип по умолчанию). */
  const navCurrent: Section = currentId ? `${TYPE}${currentId}` : section
  const typeItem = (t: TaskType): React.JSX.Element => {
    const u = usage[t.id]
    const item: NavEntry<Section> = {
      id: `${TYPE}${t.id}`, label: t.title, icon: Icon.layers,
      count: state?.defaultTaskTypeId === t.id ? 'по умолч.' : u?.asDefault ? String(u.asDefault) : undefined,
      title: [t.description, u?.asDefault ? `Тип по умолчанию в проектах: ${u.asDefault}` : ''].filter(Boolean).join('\n') || undefined
    }
    return <NavItem key={t.id} item={item} current={navCurrent} onGo={go} />
  }

  function renderType(): React.ReactNode {
    if (!state || !current) {
      return types.error ? <div className="editor-error">{types.error}</div> : <div className="muted">Загрузка…</div>
    }
    return (
      <TaskTypePane
        type={current}
        state={state}
        usage={usage[current.id]}
        agents={agents}
        tab={tab}
        onTab={goTab}
        api={types}
        onSelect={selectType}
        projects={projectList}
      />
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Настройки">
        <div className="settings-head">
          <h3>Настройки</h3>
          <button className="icon-btn task-modal-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        {/* Контейнер @container about: на узком окне меню становится полосой над разделом, как во вкладке. */}
        <div className="about-host">
          <div className="about">
            <nav className="about-nav" aria-label="Разделы настроек">
              <NavItem item={general} current={section} onGo={go} />
              <NavItem item={notifications} current={section} showCount={!!appSettings} onGo={go} />
              <div className="about-nav-group">Типы задач</div>
              {types.stale || (!state && types.error) ? (
                <NavItem item={{ id: `${TYPE}`, label: 'Типы задач', icon: Icon.layers }} current={navCurrent} onGo={go} />
              ) : (
                <div className="tpl-nav">
                  {state?.taskTypes.map(typeItem)}
                  <button type="button" className="about-nav-item tpl-nav-add" disabled={!state} onClick={() => void createType()}>
                    <Icon.plus />
                    <span className="about-nav-label">Новый тип</span>
                  </button>
                  {createError && <div className="editor-error tpl-nav-error">{createError}</div>}
                </div>
              )}
            </nav>
            <div className="about-pane">
              <section className="about-sec">
                {section === 'general' ? (
                  <GeneralSection settings={appSettings} error={appError} onChange={(p) => void saveApp(p)} />
                ) : section === 'notifications' ? (
                  <NotificationsSection
                    settings={appSettings}
                    roles={notifyRoles}
                    error={appError}
                    onChange={(p) => void saveApp({ notifications: p })}
                  />
                ) : (
                  renderType()
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
