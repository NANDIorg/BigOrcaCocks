import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, AgentKind } from '@orca-board/core'
import type { AppSettings, PermissionMode } from '../../../shared/ipc'
import { RolesEditor } from '../RolesEditor'
import { ColumnsEditor } from '../ColumnsEditor'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { NavItem, SectionHead, storeSection, storedSection, type NavEntry } from '../about/parts'
import { AgentsSection } from '../about/AgentsSection'
import { PermissionsSection, permissionParts } from '../about/PermissionsSection'
import { useProjectDefaults } from '../about/useProjectDefaults'
import { GeneralSection } from './GeneralSection'

type Section = 'general' | 'agents' | 'roles' | 'columns' | 'perm'

const SECTIONS: readonly Section[] = ['general', 'agents', 'roles', 'columns', 'perm']
const SECTION_KEY = 'orca.settingsSection'
/** Ключ черновиков редакторов ролей/колонок дефолта (не пересекается с id проектов). */
const DEFAULTS_KEY = 'defaults'

interface Props {
  /** Агенты реестра (enabled — по активному проекту; для дефолта пересчитывается здесь). */
  agents: AgentInfo[]
  /** Заново просканировать PATH. */
  onRefreshAgents(): Promise<void>
  onClose(): void
}

/**
 * «Настройки» (шестерёнка в rail): общие настройки приложения и дефолт для новых проектов
 * (projects:getDefaults/setDefaults). Вид — как у вкладки «О проекте»: меню разделов слева, раздел справа.
 */
export function SettingsModal({ agents, onRefreshAgents, onClose }: Props): React.JSX.Element {
  const [section, setSection] = useState<Section>(() => storedSection(SECTION_KEY, SECTIONS, 'general'))
  const { defaults, error: defaultsError, save: saveDefaults } = useProjectDefaults()
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [permError, setPermError] = useState<string | null>(null)

  useEffect(() => {
    window.orca.app.getSettings().then(setAppSettings, (e) => setAppError(ipcErrorMessage(e)))
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

  async function saveApp(patch: Partial<AppSettings>): Promise<void> {
    try {
      setAppSettings(await window.orca.app.setSettings(patch))
      setAppError(null)
    } catch (e) {
      setAppError(ipcErrorMessage(e))
    }
  }

  // ---------- дефолт ----------

  const allAgents = defaults !== null && defaults.enabledAgents === undefined
  // «Включённость» агента — по дефолту, а не по активному проекту.
  const defaultAgents: AgentInfo[] = agents.map((a) => ({
    ...a,
    enabled: a.installed && (allAgents || !!defaults?.enabledAgents?.includes(a.id))
  }))
  const installed = defaultAgents.filter((a) => a.installed)
  const agentsOn = installed.filter((a) => a.enabled).length
  const agentOk = new Set(defaultAgents.filter((a) => a.enabled).map((a) => a.id as string))
  const roles = defaults?.roles ?? []
  const columns = defaults?.columns ?? []
  const rolesOff = roles.filter((r) => !agentOk.has(r.agent)).length
  const permission: PermissionMode = defaults?.permissionMode ?? 'auto'

  function toggleAgent(id: AgentKind, on: boolean): void {
    const next = defaultAgents.filter((a) => (a.id === id ? on : a.enabled)).map((a) => a.id)
    void saveDefaults({ enabledAgents: next }, setAgentsError)
  }

  // ---------- меню ----------

  const general: NavEntry<Section> = { id: 'general', label: 'Общие', icon: Icon.gear }
  const forNew: NavEntry<Section>[] = [
    { id: 'agents', label: 'Агенты', icon: Icon.cpu, count: `${agentsOn} из ${installed.length}` },
    {
      id: 'roles', label: 'Роли', icon: Icon.users,
      count: rolesOff ? `${roles.length} · ${rolesOff} !` : String(roles.length),
      tone: rolesOff ? 'warn' : undefined,
      title: rolesOff ? `Ролей с выключенным агентом: ${rolesOff}` : undefined
    },
    { id: 'columns', label: 'Колонки', icon: Icon.columns, count: String(columns.length) },
    { id: 'perm', label: 'Разрешения', icon: Icon.shield, count: permissionParts(permission).title }
  ]

  // ---------- разделы ----------

  function renderDefaults(): React.ReactNode {
    if (!defaults) {
      return defaultsError ? <div className="editor-error">{defaultsError}</div> : <div className="muted">Загрузка…</div>
    }
    switch (section) {
      case 'agents':
        return (
          <AgentsSection
            agents={defaultAgents}
            all={{
              on: allAgents,
              onChange: (on) => void saveDefaults({ enabledAgents: on ? undefined : installed.map((a) => a.id) }, setAgentsError)
            }}
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
              storageKey={DEFAULTS_KEY}
              roles={roles}
              agents={defaultAgents}
              onSave={(next) => saveDefaults({ roles: next })}
            />
          </>
        )
      case 'columns':
        return (
          <>
            <SectionHead title="Колонки" hint="Порядок, название и цвет. Системные нельзя удалить — по ним работает автоматика." />
            <ColumnsEditor storageKey={DEFAULTS_KEY} columns={columns} onSave={(next) => saveDefaults({ columns: next })} />
          </>
        )
      case 'perm':
        return <PermissionsSection value={permission} error={permError} onChange={(mode) => void saveDefaults({ permissionMode: mode }, setPermError)} />
    }
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
              <div className="about-nav-group">Для новых проектов</div>
              {forNew.map((item) => <NavItem key={item.id} item={item} current={section} showCount={!!defaults} onGo={go} />)}
            </nav>
            <div className="about-pane">
              <section className="about-sec">
                {section === 'general' ? (
                  <GeneralSection settings={appSettings} error={appError} onChange={(p) => void saveApp(p)} />
                ) : (
                  <>
                    <div className="about-banner">
                      Это <b>шаблон для новых проектов</b>: он копируется в проект при добавлении и не меняет
                      существующие. Применить его к проекту — «О проекте → Обзор → Применить дефолт…».
                    </div>
                    {renderDefaults()}
                  </>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
