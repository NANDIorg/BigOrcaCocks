import type React from 'react'
import { useState } from 'react'
import { modelLabel, wfWorkRoleIds, type AgentInfo, type Role, type Workflow } from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { agentTitle, builtinText, modelTitle } from './defaultTitles'
import {
  AGENT_STATE_TEXT, chosenCount, pickPathRole, stageRoleBrief, stageRolesView, toggleStageRole,
  type AgentState, type StageRoleOption, type StageRoleOrphan
} from './stageRoles'
import type { WfScope } from './workflowNav'
import { useT } from './i18n'

// Карточка «Кто выполняет» инспектора воркфлоу: выбор ролей этапа у «Работы» (режим «координатор выбирает сам» или
// «только выбранные», строки ролей, роли проверок, «сироты») и краткая карточка роли под select у gate/decision/ask.
// Вся ветвистая логика — в stageRoles.ts, здесь только разметка.

/** «Агент · модель»; у выключенного агента вместо модели — «выключен». */
function agentLine(r: StageRoleOption, agents: readonly AgentInfo[] | undefined, off: string): string {
  const model = r.state === 'off' ? off : modelTitle(modelLabel(agents?.find((a) => a.id === r.agent), r.model))
  return [agentTitle(r.agent), model].filter(Boolean).join(' · ')
}

/**
 * Точка состояния агента. `unknown` не показываем: список агентов мог не прийти (старый main) — тревога по нему
 * была бы ложной.
 */
function StateDot({ state }: { state: AgentState }): React.JSX.Element | null {
  const t = useT()
  if (state === 'unknown') return null
  const text = t(AGENT_STATE_TEXT[state])
  return <span className={`roles-dot ${state}`} role="img" aria-label={text} title={text} />
}

/** Содержимое строки роли: название, «Агент · модель», метка проверки, описание в две строки. */
function RoleBody({ r, agents }: { r: StageRoleOption; agents?: readonly AgentInfo[] }): React.JSX.Element {
  const t = useT()
  const title = builtinText(r.title)
  const description = r.description ? builtinText(r.description) : undefined
  const line = agentLine(r, agents, t('config.roles.summaryOff'))
  return (
    <span className="wf-role-main">
      <span className="wf-role-top">
        <b className="wf-role-title" title={title}>{title}</b>
        {r.state === 'off' && <span className="wf-role-note">{t('config.roles.summaryOff')}</span>}
      </span>
      <span className="wf-role-sub">
        <StateDot state={r.state} />
        <span title={line}>{line}</span>
      </span>
      {r.checkedBy && (
        <span className="chip sys wf-role-by" title={t('config.wf.roles.checks.by', { nodes: r.checkedBy.join(', ') })}>
          {t('config.wf.roles.checks.by', { nodes: r.checkedBy.join(', ') })}
        </span>
      )}
      <span className={`wf-role-desc${description ? '' : ' none'}`} title={description}>
        {description ?? t('config.wf.roles.noDescription')}
      </span>
    </span>
  )
}

/** Строка роли с чекбоксом (этап) или radio (путь подзадачи). Вся строка — `<label>`: кликается целиком. */
function RoleRow({ r, agents, type, name, onToggle }: {
  r: StageRoleOption
  agents?: readonly AgentInfo[]
  type: 'checkbox' | 'radio'
  name?: string
  onToggle(on: boolean): void
}): React.JSX.Element {
  return (
    <label className={`wf-role${r.checked ? ' on' : ''}${r.state === 'off' ? ' off' : ''}`}>
      <input type={type} name={name} checked={r.checked} onChange={(e) => onToggle(e.target.checked)} />
      <AgentLogo agent={r.agent} size={20} />
      <RoleBody r={r} agents={agents} />
    </label>
  )
}

/** «Сироты» выбора: роль удалена из типа или служебная. Молча не выбрасываем — человек убирает их сам. */
function RoleOrphans({ orphans, roles, onRemove }: {
  orphans: readonly StageRoleOrphan[]
  roles: readonly Role[]
  onRemove(id: string): void
}): React.JSX.Element | null {
  const t = useT()
  if (orphans.length === 0) return null
  return (
    <ul className="wf-role-orphans">
      {orphans.map((o) => {
        const known = roles.find((r) => r.id === o.id)
        const role = known ? builtinText(known.title) : o.id
        return (
          <li key={o.id} className="wf-role-orphan">
            <Icon.warn />
            <span>{t(o.reason === 'service' ? 'config.wf.roles.orphan.service' : 'config.wf.roles.orphan.missing', { role })}</span>
            <button type="button" className="btn-sm" onClick={() => onRemove(o.id)}>{t('config.wf.roles.orphan.remove')}</button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Роли ноды «Работа». Этап графа: «Координатор выбирает сам» (роли не заданы) или «Только выбранные» (чекбоксы).
 * Путь подзадачи: «Роль не меняется» или «Сменить роль на…» (radio — роль воркера одна).
 *
 * «Только выбранные» при пустом выборе живёт в состоянии компонента: в данных пустой список и есть «координатор».
 * Поэтому компонент монтируется с `key` по ноде и уровню, а не пересоздаётся на каждую правку.
 */
export function WorkRolesField({ node, workflow, scope, roles, agents, onChange }: {
  node: { id: string; roleIds?: readonly string[]; roleId?: string }
  workflow: Workflow
  scope: WfScope
  /** Все роли типа, со служебными: по ним отличаем служебную «сироту» от удалённой роли. */
  roles: readonly Role[]
  agents?: readonly AgentInfo[]
  onChange(roleIds: string[]): void
}): React.JSX.Element {
  const t = useT()
  const [localChosen, setLocalChosen] = useState(false)
  const chosen = wfWorkRoleIds(node)
  const view = stageRolesView({ roles, workflow, scope, chosen, agents, localChosen })
  const path = scope === 'subtask'
  const chosenMode = view.mode === 'chosen'
  const setMode = (next: 'coordinator' | 'chosen'): void => {
    setLocalChosen(next === 'chosen')
    if (next === 'coordinator' && chosen.length > 0) onChange([])
  }
  const toggle = (id: string, on: boolean): void => {
    const next = path ? pickPathRole(on ? id : null) : toggleStageRole(chosen, id, on)
    // Сняли последнюю роль — остаёмся в «Только выбранные», пока человек сам не переключит режим.
    if (next.length === 0) setLocalChosen(true)
    onChange(next)
  }
  const remove = (id: string): void => toggle(id, false)
  // При двух ролях из файла radio с одним name показали бы только одну: даём каждой своё имя.
  const radioName = (id: string): string => `wf-path-role-${node.id}${view.pathConflict ? `-${id}` : ''}`
  const row = (r: StageRoleOption): React.JSX.Element => (
    <RoleRow
      key={r.id}
      r={r}
      agents={agents}
      type={path ? 'radio' : 'checkbox'}
      name={path ? radioName(r.id) : undefined}
      onToggle={(on) => toggle(r.id, on)}
    />
  )
  const count = chosenCount(view)
  const checksChosen = view.checks.filter((r) => r.checked).length

  return (
    <fieldset className="wf-role-field">
      <legend className="sr-only">{path ? t('config.wf.roles.path.aria') : t('config.wf.roles.mode.aria')}</legend>
      <div className="wf-seg wf-seg--full" role="group" aria-label={path ? t('config.wf.roles.path.aria') : t('config.wf.roles.mode.aria')}>
        <button type="button" aria-pressed={!chosenMode} onClick={() => setMode('coordinator')}>
          {path ? t('config.wf.roles.path.keep') : t('config.wf.roles.mode.coordinator')}
        </button>
        <button type="button" aria-pressed={chosenMode} onClick={() => setMode('chosen')}>
          {path ? t('config.wf.roles.path.switch') : t('config.wf.roles.mode.chosen')}
        </button>
      </div>

      {!chosenMode && path && <p className="hint">{t('config.wf.roles.path.keepHint')}</p>}
      {!chosenMode && !path && (
        view.work.length === 0 ? <p className="hint">{t('config.wf.roles.coordinatorNone')}</p> : (
          <>
            <p className="hint">{t('config.wf.roles.coordinatorHint')}</p>
            <ul className="wf-role-pool">
              {view.work.map((r) => {
                const title = builtinText(r.title)
                const noDesc = view.noDescription.includes(r.id)
                const tip = [agentLine(r, agents, t('config.roles.summaryOff')), noDesc && t('config.wf.roles.noDescription')].filter(Boolean).join(' — ')
                return (
                  <li key={r.id} className={`wf-role-pool-item${r.state === 'off' ? ' off' : ''}`} title={tip}>
                    <AgentLogo agent={r.agent} size={16} />
                    <span className="wf-role-pool-name">{title}</span>
                    {r.state === 'off' && <StateDot state="off" />}
                    {noDesc && <span className="wf-role-pool-warn" role="img" aria-label={t('config.wf.roles.noDescription')}><Icon.warn /></span>}
                  </li>
                )
              })}
            </ul>
            <PoolWarnings view={view} />
          </>
        )
      )}

      {chosenMode && (
        <>
          <p className="hint">
            {path
              ? t('config.wf.roles.path.switchHint')
              : `${t('config.wf.roles.chosenCount', count)} · ${t('config.wf.roles.chosenHint')}`}
          </p>
          <div className="wf-role-list" role={path ? 'radiogroup' : undefined} aria-label={path ? t('config.wf.roles.path.aria') : undefined}>
            {view.work.map(row)}
          </div>
          {view.checks.length > 0 && (
            <details className="wf-role-group" open={checksChosen > 0 || undefined}>
              <summary>{t('config.wf.roles.checks.title', { n: view.checks.length })}</summary>
              <p className="hint">{t('config.wf.roles.checks.hint')}</p>
              <div className="wf-role-list">{view.checks.map(row)}</div>
            </details>
          )}
          <RoleOrphans orphans={view.orphans} roles={roles} onRemove={remove} />
          {view.pathConflict && (
            <ul className="wf-field-errs wf-field-errs--warning"><li>{t('config.wf.roles.path.many')}</li></ul>
          )}
          {chosen.length === 0 && (
            <p className="hint">{path ? t('config.wf.roles.path.empty') : t('config.wf.roles.chosenEmpty')}</p>
          )}
        </>
      )}
    </fieldset>
  )
}

/** Предупреждения режима «Координатор выбирает сам»: роль без описания, роль с выключенным агентом. */
function PoolWarnings({ view }: { view: ReturnType<typeof stageRolesView> }): React.JSX.Element | null {
  const t = useT()
  const items = [
    ...view.work.filter((r) => view.noDescription.includes(r.id))
      .map((r) => ({ id: `d-${r.id}`, text: t('config.wf.roles.poolNoDescription', { role: builtinText(r.title) }) })),
    ...view.work.filter((r) => r.state === 'off')
      .map((r) => ({ id: `o-${r.id}`, text: t('config.wf.roles.poolOff', { role: builtinText(r.title) }) }))
  ]
  if (items.length === 0) return null
  return (
    <ul className="wf-field-errs wf-field-errs--warning">
      {items.map((i) => <li key={i.id}>{i.text}</li>)}
    </ul>
  )
}

/**
 * Краткая карточка роли под select у gate/decision/ask. Пустой выбор и роль «нет в типе» уже видны в самом select
 * и в ошибке карточки — здесь для них текста нет, кроме подсказки `empty`.
 */
export function RoleBrief({ roles, roleId, agents, empty }: {
  roles: readonly Role[]
  roleId: string | undefined
  agents?: readonly AgentInfo[]
  /** Текст при пустом выборе; нет — ничего не показываем. */
  empty?: string
}): React.JSX.Element | null {
  const t = useT()
  const brief = stageRoleBrief(roles, roleId, agents)
  if ('role' in brief) {
    return (
      <div className={`wf-role wf-role--static${brief.role.state === 'off' ? ' off' : ''}`}>
        <AgentLogo agent={brief.role.agent} size={20} />
        <RoleBody r={brief.role} agents={agents} />
      </div>
    )
  }
  if (brief.problem === 'empty') return empty ? <p className="hint">{empty}</p> : null
  if (brief.problem === 'service') {
    return <ul className="wf-field-errs wf-field-errs--warning"><li>{t('config.wf.roles.orphan.service', { role: roleId ?? '' })}</li></ul>
  }
  return null
}
