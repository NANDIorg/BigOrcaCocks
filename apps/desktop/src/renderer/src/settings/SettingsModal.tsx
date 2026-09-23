import type React from 'react'
import { useEffect, useState } from 'react'
import { DEFAULT_ROLES, type AgentInfo, type ProjectTemplate, type Role } from '@orca-board/core'
import type { AppSettings, AppSettingsPatch, Project } from '../../../shared/ipc'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { NavItem, storeSection, type NavEntry } from '../about/parts'
import {
  TEMPLATE_TABS, pickTemplateId, resolveTemplateSettings, splitTemplates, templateUsage, type TemplateTab
} from '../projectTemplates'
import { GeneralSection } from './GeneralSection'
import { NotificationsSection } from './NotificationsSection'
import { TemplatePane } from './TemplatePane'
import { useTemplates } from './useTemplates'

/** Раздел меню: общий, уведомления или шаблон проекта (`tpl:<id>`). */
type Section = 'general' | 'notifications' | `tpl:${string}`

const SECTION_KEY = 'orca.settingsSection'
const TAB_KEY = 'orca.settingsTemplateTab'
const TPL = 'tpl:'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Запомненный раздел. Разделы старого «Для новых проектов» (agents, roles…) ведут в шаблоны. */
function initialSection(): Section {
  const v = stored(SECTION_KEY)
  if (v === 'general' || v === 'notifications') return v
  if (v?.startsWith(TPL)) return v as Section
  return v ? `${TPL}` : 'general'
}

function initialTab(): TemplateTab {
  const v = stored(TAB_KEY)
  return TEMPLATE_TABS.find((t) => t === v) ?? 'roles'
}

interface Props {
  /** Агенты реестра (enabled — по активному проекту; для шаблона пересчитывается по нему). */
  agents: AgentInfo[]
  /** Заново просканировать PATH. */
  onRefreshAgents(): Promise<void>
  /** Проекты изменились («Применить к проектам…»): перечитать их в приложении. */
  onProjectsChanged(): Promise<void>
  onClose(): void
}

/**
 * «Настройки» (шестерёнка в rail): общие настройки приложения и шаблоны проектов (templates:*).
 * Вид — как у вкладки «О проекте»: меню разделов слева (каждый шаблон — пункт), раздел справа.
 */
export function SettingsModal({ agents, onRefreshAgents, onProjectsChanged, onClose }: Props): React.JSX.Element {
  const [section, setSection] = useState<Section>(initialSection)
  const [tab, setTab] = useState<TemplateTab>(initialTab)
  const templates = useTemplates()
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [projectList, setProjectList] = useState<Project[]>([])
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
    storeSection(SECTION_KEY, s)
  }

  function goTab(t: TemplateTab): void {
    setTab(t)
    storeSection(TAB_KEY, t)
  }

  /** Показать шаблон; null — шаблон по умолчанию. */
  function selectTemplate(id: string | null): void {
    go(`${TPL}${id ?? ''}`)
  }

  /** После массового применения: свой список (счётчики, отличия) и список приложения (доска, «О проекте»). */
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

  async function createTemplate(): Promise<void> {
    try {
      const t = await templates.create({ title: 'Новый шаблон', settings: {} })
      setCreateError(null)
      selectTemplate(t.id)
    } catch (e) {
      setCreateError(ipcErrorMessage(e))
    }
  }

  // ---------- шаблоны ----------

  const state = templates.state
  const usage = templateUsage(projectList)
  const currentId = state && section.startsWith(TPL) ? pickTemplateId(state, section.slice(TPL.length)) : null
  const current: ProjectTemplate | undefined = state?.templates.find((t) => t.id === currentId)
  const { builtin, own } = splitTemplates(state?.templates ?? [])

  // Роли для фильтра уведомлений: шаблон по умолчанию и все проекты, первый встреченный title на id.
  const defaultTemplate = state?.templates.find((t) => t.id === state.defaultTemplateId)
  const notifyRoles: Role[] = []
  const defaultRoles = defaultTemplate ? resolveTemplateSettings(defaultTemplate.settings).roles : []
  for (const r of [...defaultRoles, ...projectList.flatMap((p) => p.roles ?? DEFAULT_ROLES)]) {
    if (!notifyRoles.some((x) => x.id === r.id)) notifyRoles.push(r)
  }

  // ---------- меню ----------

  const general: NavEntry<Section> = { id: 'general', label: 'Общие', icon: Icon.gear }
  const notifyOn = appSettings?.notifications.enabled
  const notifications: NavEntry<Section> = {
    id: 'notifications', label: 'Уведомления', icon: Icon.bell,
    count: notifyOn === undefined ? undefined : notifyOn ? 'вкл' : 'выкл'
  }
  /** Текущий пункт меню: у шаблона — с фактическим id (пустой `tpl:` после удаления — шаблон по умолчанию). */
  const navCurrent: Section = currentId ? `${TPL}${currentId}` : section
  const templateItem = (t: ProjectTemplate): React.JSX.Element => {
    const n = usage[t.id] ?? 0
    const item: NavEntry<Section> = {
      id: `${TPL}${t.id}`, label: t.title, icon: Icon.layers,
      count: state?.defaultTemplateId === t.id ? 'по умолч.' : n ? String(n) : undefined,
      title: [t.description, n ? `Проектов из шаблона: ${n}` : ''].filter(Boolean).join('\n') || undefined
    }
    return <NavItem key={t.id} item={item} current={navCurrent} onGo={go} />
  }

  function renderTemplates(): React.ReactNode {
    if (!state || !current) {
      return templates.error ? <div className="editor-error">{templates.error}</div> : <div className="muted">Загрузка…</div>
    }
    return (
      <TemplatePane
        template={current}
        state={state}
        usage={usage[current.id] ?? 0}
        agents={agents}
        onRefreshAgents={onRefreshAgents}
        tab={tab}
        onTab={goTab}
        api={templates}
        onSelect={selectTemplate}
        projects={projectList}
        onProjectsChanged={reloadProjects}
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
              <div className="about-nav-group">Шаблоны проектов</div>
              {templates.stale || (!state && templates.error) ? (
                <NavItem item={{ id: `${TPL}`, label: 'Шаблоны', icon: Icon.layers }} current={navCurrent} onGo={go} />
              ) : (
                <div className="tpl-nav">
                  {builtin.map(templateItem)}
                  {own.length > 0 && <div className="about-nav-group tpl-nav-sub">Свои</div>}
                  {own.map(templateItem)}
                  <button type="button" className="about-nav-item tpl-nav-add" disabled={!state} onClick={() => void createTemplate()}>
                    <Icon.plus />
                    <span className="about-nav-label">Новый шаблон</span>
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
                  renderTemplates()
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
