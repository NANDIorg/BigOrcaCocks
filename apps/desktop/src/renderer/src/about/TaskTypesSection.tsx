import type React from 'react'
import { useEffect, useState } from 'react'
import type { AgentInfo, TaskType } from '@orca-board/core'
import type { Project, ProjectTaskTypesInput, TaskTypesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { SectionHead, Switch, storeSection } from './parts'
import {
  SETTINGS_SECTION_KEY, TASK_TYPES_STALE_MESSAGE, allTypesInput, defaultTypeInput, hasProjectTaskTypes, isTypeAvailable,
  projectDefaultTypeId, resolveTypeSettings, rolesWithAgentOff, taskTypeLibraryApi, taskTypesError,
  settingsTypeSection, toggledProjectTypes
} from '../taskTypeEdit'

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
  const supported = hasProjectTaskTypes(window.orca)
  const [state, setState] = useState<TaskTypesState | null>(null)
  const [error, setError] = useState<string | null>(supported ? null : TASK_TYPES_STALE_MESSAGE)
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
  function showInSettings(t: TaskType): void {
    storeSection(SETTINGS_SECTION_KEY, settingsTypeSection(t.id))
    setShown(t.id)
  }

  const head = (
    <SectionHead
      title="Типы задач"
      hint="Тип выбирается у глобальной задачи и задаёт её роли, воркфлоу, правила доски и разрешения. Здесь — какие типы можно выбрать в этом проекте и какой берётся по умолчанию: для глобальных задач без типа и «Входящих»."
    />
  )
  if (!state) {
    return (
      <>
        {head}
        {error ? <div className="editor-error">{error}</div> : <div className="muted">Загрузка…</div>}
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
            <b>Все типы библиотеки</b>
            <span className="hint">Включая типы, созданные позже. Выключите, чтобы оставить в проекте только отмеченные.</span>
          </div>
          <Switch on={allOn} disabled={busy} onChange={(on) => void save(allTypesInput(project, state, on))} />
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}

      <ul className="tt-list" aria-label="Типы задач проекта">
        {state.taskTypes.map((t) => {
          const on = isTypeAvailable(project, t.id)
          const isDef = t.id === def
          const s = resolveTypeSettings(t.settings)
          const off = rolesWithAgentOff(s.roles, agents)
          return (
            <li key={t.id} className={`tt-item${on ? '' : ' off'}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={busy || (on && isDef)}
                title={on && isDef ? 'Тип по умолчанию выключить нельзя' : on ? 'Выключить в проекте' : 'Включить в проекте'}
                aria-label={`Доступен в проекте: ${t.title}`}
                onChange={(e) => void save(toggledProjectTypes(project, state, t.id, e.target.checked))}
              />
              <div className="tt-text">
                <div className="tt-title">
                  <b>{t.title}</b>
                  {isDef && <span className="chip ok">по умолчанию</span>}
                </div>
                {t.description && <span className="hint">{t.description}</span>}
                <span className="tt-roles">
                  Роли: {s.roles.map((r) => r.title).join(', ')} · воркфлоу {s.workflow ? 'свой' : 'дефолтный'}
                </span>
                {on && off.length > 0 && (
                  <span className="tt-warn">
                    Агент выключен в проекте у ролей: {off.map((r) => r.title).join(', ')} — они здесь не запустятся.
                    Включите агента в разделе «Агенты» или смените исполнителя в типе.
                  </span>
                )}
                {shown === t.id && (
                  <span className="hint">Откройте «Настройки» (шестерёнка в левой панели) — там будет выбран этот тип.</span>
                )}
              </div>
              <div className="tt-actions">
                {!isDef && (
                  <button type="button" className="btn-sm" disabled={busy} onClick={() => void save(defaultTypeInput(project, t.id))}>
                    По умолчанию
                  </button>
                )}
                <button
                  type="button"
                  className="btn-sm"
                  title="Роли, воркфлоу, разрешения и правила доски"
                  onClick={() => showInSettings(t)}
                >
                  Изменить в Настройках
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="hint">
        Тип общий для всех проектов: правка в «Настройках» действует везде, где он доступен. Уже созданная глобальная задача
        идёт по графу, снятому при её создании.
      </p>
    </>
  )
}
