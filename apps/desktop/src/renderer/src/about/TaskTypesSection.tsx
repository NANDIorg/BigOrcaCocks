import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, TaskType } from '@orca-board/core'
import type { Project, ProjectTaskTypesInput, TaskTypesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { useT } from '../i18n'
import { SectionHead, Switch, storeSection } from './parts'
import {
  SETTINGS_SECTION_KEY, taskTypesStaleMessage, allTypesInput, defaultTypeInput, hasProjectTaskTypes, isTypeAvailable,
  projectDefaultTypeId, resolveTypeSettings, rolesWithAgentOff, taskTypeLibraryApi, taskTypesError,
  settingsTypeSection, toggledProjectTypes
} from '../taskTypeEdit'
import { builtinText } from '../defaultTitles'

interface Props {
  project: Project
  /** Агенты реестра; enabled — по этому (активному) проекту. */
  agents: AgentInfo[]
  /** Перечитать проекты после смены типов. */
  onProjectChanged(): Promise<void>
}

/**
 * «О проекте → Типы задач»: какие типы библиотеки доступны в проекте (`taskTypeIds`) и какой по умолчанию
 * (`defaultTaskTypeId`: глобальные задачи без выбранного типа и «Входящие»). Сами типы правятся в «Настройках».
 * Старый main/preload без типов — «перезапустите приложение».
 */
export function TaskTypesSection({ project, agents, onProjectChanged }: Props): React.JSX.Element {
  const t = useT()
  const supported = hasProjectTaskTypes(window.orca)
  const [state, setState] = useState<TaskTypesState | null>(null)
  const [error, setError] = useState<string | null>(supported ? null : taskTypesStaleMessage())
  const [busy, setBusy] = useState(false)
  /** Тип, выбранный для «Настроек» кнопкой «Изменить»: подсказка, где его искать. */
  const [shown, setShown] = useState<string | null>(null)

  // Типы могли поменять в «Настройках» — перечитываем при открытии раздела и смене проекта.
  useEffect(() => {
    if (!supported) return
    setShown(null)
    taskTypeLibraryApi(window.orca).list().then(
      (s) => {
        setState(s)
        setError(null)
      },
      (e: unknown) => setError(taskTypesError(ipcErrorMessage(e)))
    )
  }, [project.id, supported])

  async function save(input: ProjectTaskTypesInput | { error: string }): Promise<void> {
    if ('error' in input) {
      setError(input.error)
      return
    }
    setBusy(true)
    try {
      await window.orca.projects.setTaskTypes(project.id, input)
      setError(null)
    } catch (e) {
      setError(taskTypesError(ipcErrorMessage(e)))
    } finally {
      setBusy(false)
    }
    await onProjectChanged()
  }

  /** Открыть тип в «Настройках»: окно открывается шестерёнкой, запомненный раздел покажет этот тип. */
  function showInSettings(type: TaskType): void {
    storeSection(SETTINGS_SECTION_KEY, settingsTypeSection(type.id))
    setShown(type.id)
  }

  const head = (
    <SectionHead
      title={t('config.about.nav.types')}
      hint={t('config.about.types.hint')}
    />
  )
  if (!state) {
    return (
      <>
        {head}
        {error ? <div className="editor-error">{error}</div> : <div className="muted">{t('common.loading')}</div>}
      </>
    )
  }

  const def = projectDefaultTypeId(project, state)
  const allOn = !project.taskTypeIds

  return (
    <>
      {head}
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('config.about.types.all')}</b>
            <span className="hint">{t('config.about.types.allHint')}</span>
          </div>
          <Switch on={allOn} disabled={busy} onChange={(on) => void save(allTypesInput(project, state, on))} />
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}

      <ul className="tt-list" aria-label={t('config.about.types.listAria')}>
        {state.taskTypes.map((type) => {
          const on = isTypeAvailable(project, type.id)
          const isDef = type.id === def
          const s = resolveTypeSettings(type.settings)
          const off = rolesWithAgentOff(s.roles, agents)
          return (
            <li key={type.id} className={`tt-item${on ? '' : ' off'}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={busy || (on && isDef)}
                title={on && isDef ? t('config.about.types.defaultLocked') : on ? t('config.about.types.disable') : t('config.about.types.enable')}
                aria-label={t('config.about.types.availableAria', { title: builtinText(type.title) })}
                onChange={(e) => void save(toggledProjectTypes(project, state, type.id, e.target.checked))}
              />
              <div className="tt-text">
                <div className="tt-title">
                  <b>{builtinText(type.title)}</b>
                  {isDef && <span className="chip ok">{t('config.about.types.default')}</span>}
                </div>
                {type.description && <span className="hint">{builtinText(type.description)}</span>}
                <span className="tt-roles">
                  {t('config.about.types.roles', {
                    roles: s.roles.map((r) => builtinText(r.title)).join(', '),
                    workflow: s.workflow ? t('config.about.types.wfOwn') : t('config.about.types.wfDefault')
                  })}
                </span>
                {on && off.length > 0 && (
                  <span className="tt-warn">
                    {t('config.about.types.agentOff', { roles: off.map((r) => r.title).join(', ') })}
                  </span>
                )}
                {shown === type.id && (
                  <span className="hint">{t('config.about.types.shown')}</span>
                )}
              </div>
              <div className="tt-actions">
                {!isDef && (
                  <button type="button" className="btn-sm" disabled={busy} onClick={() => void save(defaultTypeInput(project, type.id))}>
                    {t('config.about.types.makeDefault')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-sm"
                  title={t('config.about.types.editTitle')}
                  onClick={() => showInSettings(type)}
                >
                  {t('config.about.types.edit')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="hint">
        {t('config.about.types.footer')}
      </p>
    </>
  )
}
