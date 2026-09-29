import type React from 'react'
import { useEffect, useState } from 'react'
import {
  effortOptions,
  effortOptionsFor,
  getAgent,
  modelLabel,
  modelOptions,
  promptChannel,
  type AgentInfo,
  type AgentKind,
  type BuiltinPromptKind,
  type BuiltinPrompts
} from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { useT, type TFunction, type TKey } from './i18n'
import { AGENT_STATE_TEXT, roleAgentState } from './stageRoles'
import { withCode } from './about/parts'
import { agentTitle, modelTitle } from './defaultTitles'
import { ipcErrorMessage } from './ipcError'

// Части панели исполнителя агента: общие для роли типа задачи (RolesEditor) и ассистента («Настройки → Ассистент»).

/** Кто запускается: агент, модель и effort — поля и роли, и настроек ассистента. */
export interface Executor {
  agent: AgentKind
  model?: string
  effort?: string
}

/** Уровни effort: по модели агента, если агент известен, иначе общий список из реестра. */
export function effortsOf(info: AgentInfo | undefined, agent: string, model: string | undefined): readonly string[] {
  return info ? effortOptionsFor(info, model) : effortOptions(agent)
}

/** Агент, модель и effort плюс превью команды запуска. */
export function ExecutorFields({ exec, agents, enabled, preview, onAgent, onModel, onEffort }: {
  exec: Executor
  /** Все агенты: выключенный текущий показывается с пометкой. */
  agents: readonly AgentInfo[]
  /** Агенты, которых можно выбрать. */
  enabled: readonly AgentInfo[]
  /** Строка запуска (`commandPreview`). */
  preview: string
  onAgent(agent: AgentKind): void
  onModel(model: string, debounce?: boolean): void
  onEffort(effort: string | undefined): void
}): React.JSX.Element {
  const t = useT()
  const current = agents.find((a) => a.id === exec.agent)
  const state = roleAgentState(current)
  const defaults = current?.defaults
  const models = current ? modelOptions(current) : []
  const customModel = exec.model && !models.some((m) => m.id === exec.model) ? exec.model : undefined
  const defaultModel = modelTitle(modelLabel(current, defaults?.model))
  const efforts = effortsOf(current, exec.agent, exec.model)
  return (
    <div className="roles-sec">
      <div className="roles-sec-head"><span>{t('config.roles.executor')}</span></div>
      <div className="roles-grid3">
        <div className="roles-field">
          <span className="roles-label">{t('config.roles.agent')}</span>
          <div className="roles-agent">
            <AgentLogo agent={exec.agent} size={18} />
            <select
              value={exec.agent}
              className={state !== 'on' ? 'off' : ''}
              aria-label={t('config.roles.agent')}
              onChange={(e) => onAgent(e.target.value as AgentKind)}
            >
              {enabled.map((a) => (
                <option key={a.id} value={a.id}>{agentTitle(a.id)}</option>
              ))}
              {state === 'off' && current && <option value={current.id} disabled>{t('config.roles.agentOffOption', { agent: current.title })}</option>}
              {state === 'unknown' && <option value={exec.agent} disabled>{t('config.roles.agentUnknownOption', { agent: exec.agent })}</option>}
            </select>
          </div>
        </div>
        <div className="roles-field">
          <span className="roles-label">{t('config.roles.model')}</span>
          {models.length > 0 ? (
            <select value={exec.model ?? ''} aria-label={t('config.roles.model')} onChange={(e) => onModel(e.target.value)}>
              <option value="">{defaultModel ? t('config.roles.modelDefaultOf', { model: defaultModel }) : t('config.roles.modelDefault')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{modelTitle(m.label)}</option>
              ))}
              {customModel && <option value={customModel}>{t('config.roles.modelCustom', { model: customModel })}</option>}
            </select>
          ) : (
            <input
              value={exec.model ?? ''}
              aria-label={t('config.roles.model')}
              placeholder={defaults?.model ? t('config.roles.modelDefaultOf', { model: defaults.model }) : t('config.roles.modelDefault')}
              onChange={(e) => onModel(e.target.value, true)}
            />
          )}
        </div>
        <div className="roles-field">
          <span className="roles-label">
            <span>{t('config.roles.effort')}</span>
            {defaults?.effort && <span>{t('config.roles.effortDefault', { effort: defaults.effort })}</span>}
          </span>
          {efforts.length > 0 ? (
            <div className="roles-effort" role="radiogroup" aria-label={t('config.roles.effort')}>
              <button
                type="button"
                role="radio"
                aria-checked={!exec.effort}
                className={!exec.effort ? 'on' : ''}
                title={t('config.roles.effortAutoTitle')}
                onClick={() => onEffort(undefined)}
              >
                {t('config.roles.effortAuto')}
              </button>
              {efforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={exec.effort === e}
                  className={`${exec.effort === e ? 'on' : ''}${defaults?.effort === e ? ' def' : ''}`}
                  title={defaults?.effort === e ? t('config.roles.effortIsDefault', { effort: e }) : e}
                  onClick={() => onEffort(e)}
                >
                  {e}
                </button>
              ))}
              {exec.effort && !efforts.includes(exec.effort) && (
                <button type="button" role="radio" aria-checked className="on bad" disabled title={t('config.roles.effortUnsupported')}>
                  {exec.effort}
                </button>
              )}
            </div>
          ) : (
            <div className="roles-hint roles-effort-none">{t('config.roles.effortNone')}</div>
          )}
        </div>
      </div>
      <pre className="roles-preview" aria-label={t('config.roles.commandAria')}>
        <span className="k">$</span> {preview}
      </pre>
    </div>
  )
}

type InstructionTab = 'prompt' | 'builtin' | 'start'

/** Вкладки инструкций: свои инструкции (редактируются), служебная инструкция Orca и стартовое сообщение (только чтение). */
export function InstructionTabs({
  idPrefix, kind, agent, systemPrompt, promptTab, promptPlaceholder, promptHint, builtin, readOnly = false, onPrompt, startNote, startText
}: {
  /** Уникальная часть id вкладок (aria-controls). */
  idPrefix: string
  /** Какая служебная инструкция показывается (`skills/<kind>.md`). */
  kind: BuiltinPromptKind
  agent: AgentKind
  systemPrompt: string | undefined
  /** Подпись первой вкладки: пустые и заданные инструкции подписаны по-разному. */
  promptTab: { empty: string; set: string }
  promptPlaceholder: string
  promptHint: React.ReactNode
  builtin: BuiltinState
  readOnly?: boolean
  onPrompt(text: string): void
  /** Что подставляется в стартовое сообщение. */
  startNote: string
  /** Стартовое сообщение с ‹плейсхолдерами›. */
  startText: string
}): React.JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<InstructionTab>('prompt')
  const builtinText = builtin && 'prompts' in builtin ? builtin.prompts[kind] : undefined
  const tabs: { id: InstructionTab; label: string }[] = [
    { id: 'prompt', label: systemPrompt ? promptTab.set : promptTab.empty },
    {
      id: 'builtin',
      label: builtinText ? t('config.roles.tab.builtinLines', { count: lineCount(builtinText) }) : t('config.roles.tab.builtin')
    },
    { id: 'start', label: t('config.roles.tab.start') }
  ]
  return (
    <div className="roles-sec">
      <div className="roles-tabs" role="tablist" aria-label={t('config.roles.tabsAria')}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`${idPrefix}-tabpanel`}
            className={tab === x.id ? 'on' : ''}
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div id={`${idPrefix}-tabpanel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${tab}`} className="roles-tabpanel">
        {tab === 'prompt' && (
          <>
            <textarea
              value={systemPrompt ?? ''}
              placeholder={promptPlaceholder}
              rows={5}
              readOnly={readOnly}
              aria-label={promptTab.empty}
              onChange={(e) => onPrompt(e.target.value)}
            />
            <div className="roles-hint">{promptHint}</div>
          </>
        )}
        {tab === 'builtin' && (
          <>
            <div className="roles-hint">{t('config.roles.builtinSource', { kind })}</div>
            {builtinText !== undefined ? (
              <pre className="role-text" tabIndex={0} aria-label={t('config.roles.tab.builtin')}>{builtinText.trimEnd()}</pre>
            ) : (
              <div className="roles-hint">
                {builtin && 'error' in builtin ? t('config.roles.loadFailed', { error: builtin.error }) : t('common.loading')}
              </div>
            )}
            {kind === 'coordinator' && (
              <div className="roles-hint">
                {withCode(t('config.roles.coordinatorHint'), 'coordinator', 'code')}
              </div>
            )}
          </>
        )}
        {tab === 'start' && (
          <>
            <div className="roles-hint">
              {t('config.roles.startLead', { agent: agentTitle(agent), channel: t(CHANNEL_TEXT[promptChannel(getAgent(agent))]) })}{' '}
              {startNote}
            </div>
            <pre className="role-text short">{startText}</pre>
          </>
        )}
      </div>
    </div>
  )
}

function lineCount(text: string): number {
  return text.trimEnd().split('\n').length
}

/** Как передаётся промпт агенту (`promptChannel`). */
const CHANNEL_TEXT: Record<ReturnType<typeof promptChannel>, TKey> = {
  system: 'config.roles.channel.system',
  combined: 'config.roles.channel.combined',
  none: 'config.roles.channel.none'
}

/** Аргумент для превью команды: плейсхолдеры ‹…› как есть, остальное со спецсимволами — в кавычках. */
function shellArg(arg: string): string {
  const flat = arg.replace(/\s*\n\s*/g, ' ')
  if (flat.includes('‹') || !/[\s'"*()$&|;<>]/.test(flat)) return flat
  return `'${flat.replace(/'/g, `'\\''`)}'`
}

/**
 * Строка запуска агента — из того же `invoke` реестра, что и реальный запуск; тексты — плейсхолдерами.
 * `prompt` — стартовое сообщение (или его плейсхолдер), `permissionMode` — известный режим, иначе плейсхолдер.
 */
export function commandPreview(
  t: TFunction, exec: Executor & { systemPrompt?: string }, kind: BuiltinPromptKind, prompt: string, permissionMode?: string
): string {
  const spec = getAgent(exec.agent)
  if (!spec) return t('config.roles.agentUnknownCmd', { agent: exec.agent })
  const system = t(exec.systemPrompt ? 'config.roles.ph.systemWithRole' : 'config.roles.ph.system', { kind })
  const { command, args } = spec.invoke(system, prompt, {
    permissionMode: permissionMode ?? t('config.roles.ph.permission'), shell: '$SHELL', model: exec.model, effort: exec.effort
  })
  return [command, ...args].map(shellArg).join(' ')
}

export type BuiltinState = { prompts: BuiltinPrompts } | { error: string } | undefined

/** Служебные инструкции Orca из main-процесса — тот же текст, что агенты получают при запуске. */
export function useBuiltinPrompts(): BuiltinState {
  const [state, setState] = useState<BuiltinState>()
  useEffect(() => {
    let alive = true
    window.orca.prompts.builtin().then(
      (prompts) => alive && setState({ prompts }),
      (e: unknown) => alive && setState({ error: ipcErrorMessage(e) })
    )
    return () => {
      alive = false
    }
  }, [])
  return state
}
