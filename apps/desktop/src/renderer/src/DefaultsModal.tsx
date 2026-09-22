import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, AgentKind } from '@orca-board/core'
import { PERMISSION_MODES, type AppSettings, type PermissionMode, type ProjectDefaults } from '../../shared/ipc'
import { RolesEditor } from './RolesEditor'
import { ColumnsEditor } from './ColumnsEditor'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { ipcErrorMessage } from './useAutoSave'

interface Props {
  /** Агенты из реестра: установлен ли, версия. Флаг enabled (проектный) здесь не используется. */
  agents: AgentInfo[]
  onClose(): void
}

/** Ключ черновиков редакторов ролей/колонок дефолта (не пересекается с id проектов). */
const DEFAULTS_KEY = 'defaults'

/**
 * Редактор глобального дефолта (ProjectDefaults) для новых проектов: те же разделы, что «О проекте».
 * Каждое изменение сразу уходит в projects:setDefaults; ошибки main — рядом с разделом.
 */
export function DefaultsModal({ agents, onClose }: Props): React.JSX.Element {
  const [defaults, setDefaults] = useState<ProjectDefaults | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [permError, setPermError] = useState<string | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [appError, setAppError] = useState<string | null>(null)

  useEffect(() => {
    window.orca.projects.getDefaults().then(setDefaults, (e) => setLoadError(ipcErrorMessage(e)))
    window.orca.app.getSettings().then(setAppSettings, (e) => setAppError(ipcErrorMessage(e)))
  }, [])

  // Esc закрывает модалку.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Сохранить патч; ошибка — в setError раздела (и наружу, если нужна автосохранению редактора). */
  async function save(patch: Partial<ProjectDefaults>, setError?: (e: string | null) => void): Promise<void> {
    try {
      setDefaults(await window.orca.projects.setDefaults(patch))
      setError?.(null)
    } catch (e) {
      if (!setError) throw e
      setError(ipcErrorMessage(e))
    }
  }

  /** Глобальные настройки приложения — сразу в app:setSettings; ошибка — рядом с разделом. */
  async function saveApp(patch: Partial<AppSettings>): Promise<void> {
    try {
      setAppSettings(await window.orca.app.setSettings(patch))
      setAppError(null)
    } catch (e) {
      setAppError(ipcErrorMessage(e))
    }
  }

  const allAgents = defaults !== null && defaults.enabledAgents === undefined
  const isOn = (a: AgentInfo): boolean => a.installed && (allAgents || !!defaults?.enabledAgents?.includes(a.id))
  // Для выбора агента в ролях — «включённость» по дефолту, а не по активному проекту.
  const defaultAgents: AgentInfo[] = agents.map((a) => ({ ...a, enabled: isOn(a) }))

  function toggleAll(all: boolean): void {
    const next = all ? undefined : agents.filter((a) => a.installed).map((a) => a.id)
    void save({ enabledAgents: next }, setAgentsError)
  }

  function toggleAgent(id: AgentKind, on: boolean): void {
    const next = agents.filter((a) => (a.id === id ? on : isOn(a))).map((a) => a.id)
    void save({ enabledAgents: next }, setAgentsError)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Основные настройки">
        <div className="task-modal-head">
          <h3 className="task-modal-title">Основные настройки — для новых проектов</h3>
          <button className="icon-btn task-modal-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        <div className="task-modal-body defaults-body">
          <div>
            <h3>Приложение</h3>
            <label className="agent-row">
              <input
                type="checkbox"
                checked={appSettings?.keepInBackground ?? true}
                disabled={!appSettings}
                onChange={(e) => void saveApp({ keepInBackground: e.target.checked })}
              />
              <span>Работать в фоне при закрытии окна</span>
            </label>
            <div className="muted">Окно можно закрыть, агенты продолжат работу; приложение живёт в иконке строки меню / трея</div>
            {appError && <div className="editor-error">{appError}</div>}
          </div>
          {loadError && <div className="editor-error">{loadError}</div>}
          {!defaults && !loadError && <div className="muted">Загрузка…</div>}
          {defaults && (
            <>
              <div>
                <h3>Агенты</h3>
                <label className="agent-row">
                  <input type="checkbox" checked={allAgents} onChange={(e) => toggleAll(e.target.checked)} />
                  <span>Все установленные</span>
                </label>
                {agents.map((a) => (
                  <label key={a.id} className={`agent-row ${a.installed ? '' : 'off'}`}>
                    <input
                      type="checkbox"
                      checked={isOn(a)}
                      disabled={allAgents || !a.installed}
                      onChange={(e) => toggleAgent(a.id, e.target.checked)}
                    />
                    <AgentLogo agent={a.id} size={20} />
                    <span>{a.title}</span>
                    {a.version && <span className="ver">{a.version}</span>}
                    {!a.installed && <span className="ver">не установлен</span>}
                  </label>
                ))}
                {agentsError && <div className="editor-error">{agentsError}</div>}
              </div>
              <RolesEditor
                storageKey={DEFAULTS_KEY}
                roles={defaults.roles}
                agents={defaultAgents}
                onSave={(roles) => save({ roles })}
              />
              <ColumnsEditor
                storageKey={DEFAULTS_KEY}
                columns={defaults.columns}
                onSave={(columns) => save({ columns })}
              />
              <div>
                <h3>Разрешения агентов</h3>
                <label>
                  Как Claude Code (координатор и воркеры) обращается с подтверждениями
                  <select
                    value={defaults.permissionMode}
                    onChange={(e) => void save({ permissionMode: e.target.value as PermissionMode }, setPermError)}
                  >
                    {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((m) => (
                      <option key={m} value={m}>{PERMISSION_MODES[m]}</option>
                    ))}
                  </select>
                </label>
                {permError && <div className="editor-error">{permError}</div>}
              </div>
            </>
          )}
        </div>
        <div className="task-modal-foot">
          <span className="muted">
            Применяется к проектам, добавленным после сохранения. Существующие проекты не меняются.
          </span>
          <span className="grow" />
          <button className="btn-sm" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
