import type React from 'react'
import { ASSISTANT_START_PROMPT, ASSISTANT_TITLE, type AgentInfo, type AssistantSettings } from '@orca-board/core'
import type { AppSettings } from '../../../shared/ipc'
import { SectionHead } from '../about/parts'
import { useT } from '../i18n'
import { useAutoSave } from '../useAutoSave'
import { agentTitle } from '../defaultTitles'
import { ExecutorFields, InstructionTabs, commandPreview, effortsOf, useBuiltinPrompts } from '../RoleParts'
import { roleAgentState } from '../stageRoles'
import {
  assistantAgentPatch, assistantAgents, assistantModelPatch, assistantView, withAssistantPatch
} from '../assistantSettings'

/** Режим разрешений ассистента — фиксированный (`ASSISTANT_PERMISSION_MODE` в main): в превью команды — как есть. */
const PERMISSION_MODE = 'auto'

/**
 * Раздел «Настройки → Ассистент»: агент, модель, effort, флаги запуска и инструкции ассистента доски (`AppSettings.assistant`).
 * Поля — те же части, что у роли типа (`RoleParts`). Действуют на следующий диалог, идущий не перезапускается.
 */
export function AssistantSection({ settings, agents, error, onSave }: {
  settings: AppSettings | null
  /** Агенты реестра; доступны все установленные. */
  agents: AgentInfo[]
  /** Ошибка чтения настроек. */
  error: string | null
  /** Записать настройки ассистента; бросает при сбое — ошибку покажет автосохранение. */
  onSave(assistant: AssistantSettings): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const view = assistantView(settings)
  return (
    <>
      <SectionHead title={t('settings.assistant.title')} hint={t('settings.assistant.hint')} />
      {view.kind === 'loading' ? (
        error ? <div className="editor-error">{error}</div> : <div className="muted">{t('common.loading')}</div>
      ) : view.kind === 'stale' ? (
        <div className="editor-error" role="alert">{t('common.staleApp')}</div>
      ) : (
        <AssistantEditor initial={view.assistant} agents={agents} onSave={onSave} />
      )}
    </>
  )
}

function AssistantEditor({ initial, agents: all, onSave }: {
  initial: AssistantSettings
  agents: AgentInfo[]
  onSave(assistant: AssistantSettings): Promise<void>
}): React.JSX.Element {
  const t = useT()
  // Ключ постоянный: черновик берётся при открытии раздела, внешние правки (CLI) видны при следующем открытии —
  // как у редактора ролей типа.
  const { draft: s, error, update } = useAutoSave<AssistantSettings>('assistant', initial, onSave)
  const builtin = useBuiltinPrompts()
  const agents = assistantAgents(all)
  const enabled = agents.filter((a) => a.enabled)
  const current = agents.find((a) => a.id === s.agent)
  const state = roleAgentState(current)

  function patch(p: Partial<AssistantSettings>, debounce = false): void {
    update(withAssistantPatch(s, p), debounce)
  }

  return (
    <div className="editor roles-editor">
      <section className="roles-panel" aria-label={t('settings.assistant.title')}>
        <div className="roles-hint">{t('settings.assistant.nextDialog')}</div>
        {state !== 'on' && (
          <div className="roles-warn" role="alert">
            {state === 'off'
              ? t('settings.assistant.warnOff', { agent: agentTitle(s.agent) })
              : t('settings.assistant.warnUnknown', { agent: s.agent })}
          </div>
        )}
        <ExecutorFields
          exec={s}
          agents={agents}
          enabled={enabled}
          preview={commandPreview(t, s, 'assistant', ASSISTANT_START_PROMPT, PERMISSION_MODE)}
          onAgent={(agent) => patch(assistantAgentPatch(agent))}
          onModel={(model, debounce) => patch(assistantModelPatch(s, model, effortsOf(current, s.agent, model || undefined)), debounce)}
          onEffort={(effort) => patch({ effort })}
          onExtraArgs={(extraArgs, debounce) => patch({ extraArgs }, debounce)}
        />
        <div className="roles-hint">{t('settings.assistant.permission')}</div>
        <InstructionTabs
          idPrefix="assistant"
          kind="assistant"
          agent={s.agent}
          systemPrompt={s.systemPrompt}
          promptTab={{ empty: t('settings.assistant.tab.prompt'), set: t('settings.assistant.tab.promptSet') }}
          promptPlaceholder={t('settings.assistant.promptPlaceholder')}
          promptHint={t('settings.assistant.promptHint', { title: ASSISTANT_TITLE })}
          builtin={builtin}
          onPrompt={(systemPrompt) => patch({ systemPrompt }, true)}
          startNote={t('settings.assistant.startNote')}
          startText={ASSISTANT_START_PROMPT}
        />
      </section>
      {error && <div className="editor-error">{error}</div>}
    </div>
  )
}
