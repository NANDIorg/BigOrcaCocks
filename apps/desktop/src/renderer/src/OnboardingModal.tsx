import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppSettings, AppSettingsPatch, Project } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { LOCALES, LOCALE_NAMES, setLocale, settingsLocale, useLocale, useT } from './i18n'
import { formatInteger } from './i18n/format'
import { agentTitle } from './defaultTitles'
import { saveAppSettings } from './appSettingsSave'
import { completeOnboarding } from './onboarding'
import { createOnboardingScanner, onboardingAgentGroups, type OnboardingScanState } from './onboardingAgents'
import { ipcErrorMessage } from './ipcError'
import { Switch } from './about/parts'
import { useModalFocus } from './useModalFocus'
import { OnboardingScene } from './OnboardingScene'
import appLogo from '../../../build/icon.svg'

export type OnboardingMode = 'first' | 'rerun'
const STEPS = ['welcome', 'preferences', 'agents', 'project'] as const
type Step = 0 | 1 | 2 | 3

interface Props {
  mode: OnboardingMode
  projects: Project[]
  /** Канонический флоу App: папка → тип проекта → добавление. */
  onAddProject(): Promise<void>
  /** Поверх мастера открыт выбор типа проекта: фокус и Escape принадлежат ему. */
  suspended: boolean
  onClose(): void
}

/** Четыре шага; настройки и проверка CLI живут весь мастер и не сбрасываются при возврате. */
export function OnboardingModal({ mode, projects, onAddProject, suspended, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [step, setStep] = useState<Step>(0)
  const [visited, setVisited] = useState(0)
  const [closing, setClosing] = useState(false)
  const finishing = useRef(false)
  const surface = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const direction = useRef(1)
  const alive = useRef(true)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const failedPatch = useRef<AppSettingsPatch | null>(null)
  const settingsRequest = useRef(0)
  const savePending = useRef(false)
  const [scan, setScan] = useState<OnboardingScanState>({ agents: null, busy: true, error: null })
  const scanner = useRef<ReturnType<typeof createOnboardingScanner> | null>(null)
  const [adding, setAdding] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const addPending = useRef(false)
  const busy = saving || adding || closing
  useModalFocus(surface, suspended, '.rail button')

  async function loadSettings(): Promise<void> {
    const request = ++settingsRequest.current
    setLoadingSettings(true)
    setSettingsError(null)
    try {
      const next = await window.orca.app.getSettings()
      if (alive.current && request === settingsRequest.current) setSettings(next)
    } catch (error) {
      if (alive.current && request === settingsRequest.current) setSettingsError(ipcErrorMessage(error))
    } finally {
      if (alive.current && request === settingsRequest.current) setLoadingSettings(false)
    }
  }

  useEffect(() => {
    alive.current = true
    void loadSettings()
    const controller = createOnboardingScanner(() => window.orca.agents.list(true), setScan)
    scanner.current = controller
    void controller.scan()
    return () => {
      alive.current = false
      settingsRequest.current++
      controller.dispose()
      scanner.current = null
    }
  }, [])

  async function save(patch: AppSettingsPatch): Promise<void> {
    if (savePending.current || finishing.current || suspended) return
    savePending.current = true
    setSaving(true)
    setSettingsError(null)
    const result = await saveAppSettings(window.orca.app, patch)
    savePending.current = false
    if (!alive.current) return
    if (result.settings) setSettings(result.settings)
    if (result.error && patch.language) setLocale(settingsLocale(result.settings ?? settings))
    failedPatch.current = result.error ? patch : null
    setSettingsError(result.error)
    setSaving(false)
  }

  async function finish(skipped: boolean): Promise<void> {
    if (finishing.current || savePending.current || addPending.current || suspended) return
    finishing.current = true
    setClosing(true)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const exit = surface.current?.animate(
      [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: reduced ? 'none' : 'translateY(8px)' }],
      { duration: reduced ? 80 : 160, easing: 'ease-in', fill: 'forwards' }
    )
    await Promise.all([
      mode === 'first' ? completeOnboarding(window.orca, skipped) : Promise.resolve(),
      exit?.finished.catch(() => undefined)
    ])
    onClose()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || suspended) return
      event.preventDefault()
      event.stopPropagation()
      void finish(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    element.scrollTop = 0
    if (step > 0) element.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const enter = element.animate([
      { opacity: 0, transform: reduced ? 'none' : `translateX(${direction.current * 14}px)` },
      { opacity: 1, transform: 'translateX(0)' }
    ], { duration: reduced ? 80 : 260, easing: 'cubic-bezier(.16, 1, .3, 1)' })
    return () => enter.cancel()
  }, [step])

  function go(next: Step): void {
    if (savePending.current || addPending.current || finishing.current || suspended || next === step) return
    direction.current = next > step ? 1 : -1
    setVisited(previous => Math.max(previous, next))
    setStep(next)
  }

  async function addProject(): Promise<void> {
    if (addPending.current || savePending.current || finishing.current || suspended) return
    addPending.current = true
    setAdding(true)
    setProjectError(null)
    try { await onAddProject() }
    catch (error) { if (alive.current) setProjectError(ipcErrorMessage(error)) }
    finally {
      addPending.current = false
      if (alive.current) setAdding(false)
    }
  }

  return <div className={`modal-backdrop onboarding-backdrop${suspended ? ' suspended' : ''}`}>
    <div ref={surface} className="onboarding" role="dialog" aria-modal={!suspended} aria-labelledby="onboarding-title" aria-describedby="onboarding-description" tabIndex={-1} inert={suspended}>
      <OnboardingScene step={step} settings={settings} />
      <div className="onboarding-main">
        <header className="onboarding-head">
          <img className="onboarding-mobile-logo" src={appLogo} alt="Orca Board" width={32} height={32} />
          <nav aria-label={t('onboarding.progressAria')}><ol className="onboarding-steps">
            {STEPS.map((name, index) => <li key={name}>
              <button type="button" className={`onboarding-step${step === index ? ' current' : index < step ? ' passed' : ''}`} aria-current={step === index ? 'step' : undefined} disabled={index > visited || busy} onClick={() => go(index as Step)}>
                <span className="onboarding-step-number">{index < step ? <Icon.done /> : formatInteger(index + 1)}</span>
                <span>{t(`onboarding.steps.${name}`)}</span>
              </button>
            </li>)}
          </ol></nav>
          <button type="button" className="onboarding-close" aria-label={t('onboarding.close')} title={t('onboarding.close')} disabled={busy} onClick={() => void finish(true)}><Icon.close /></button>
        </header>
        <div ref={content} className="onboarding-content">
          <h1 id="onboarding-title" tabIndex={-1}>{t(`onboarding.${STEPS[step]}.title`)}</h1>
          <p id="onboarding-description" className="onboarding-intro">{t(`onboarding.${STEPS[step]}.hint`)}</p>
          {step === 0 && <WelcomeStep />}
          {step === 1 && <PreferencesStep settings={settings} loading={loadingSettings} saving={saving} disabled={closing} error={settingsError} onSave={save} onRetry={() => failedPatch.current ? void save(failedPatch.current) : void loadSettings()} />}
          {step === 2 && <AgentsStep state={scan} onScan={() => void scanner.current?.scan()} />}
          {step === 3 && <ProjectStep projects={projects} busy={adding} disabled={busy} error={projectError} onAdd={() => void addProject()} />}
        </div>
        <footer className="onboarding-foot">
          <button type="button" className="onboarding-secondary onboarding-skip" disabled={busy} onClick={() => void finish(true)}>{t(mode === 'first' ? 'onboarding.skip' : 'onboarding.close')}</button>
          <div className="onboarding-foot-actions">
            {step > 0 && <button type="button" className="onboarding-secondary" disabled={busy} onClick={() => go((step - 1) as Step)}><Icon.chevronLeft />{t('onboarding.back')}</button>}
            <button type="button" className="onboarding-primary" data-modal-autofocus disabled={busy} aria-busy={closing} onClick={() => step === 3 ? void finish(false) : go((step + 1) as Step)}>
              {t(step === 0 ? 'onboarding.start' : step === 3 ? 'onboarding.done' : 'onboarding.next')}
              {closing ? <span className="onboarding-spin"><Icon.spinner /></span> : <Icon.chevron />}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </div>
}

function WelcomeStep(): React.JSX.Element {
  const t = useT()
  const items = [{ id: 'board', icon: Icon.board }, { id: 'branches', icon: Icon.branch }, { id: 'review', icon: Icon.shield }] as const
  return <div className="onboarding-features">{items.map(({ id, icon: FeatureIcon }) =>
    <div className="onboarding-feature" key={id}><div className="onboarding-feature-icon"><FeatureIcon /></div><div><h3>{t(`onboarding.welcome.${id}.title`)}</h3><p>{t(`onboarding.welcome.${id}.hint`)}</p></div></div>
  )}</div>
}

function PreferencesStep({ settings, loading, saving, disabled, error, onSave, onRetry }: {
  settings: AppSettings | null; loading: boolean; saving: boolean; disabled: boolean; error: string | null
  onSave(patch: AppSettingsPatch): Promise<void>; onRetry(): void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const locked = !settings || loading || saving || disabled
  return <div className="onboarding-preferences">
    <fieldset className="onboarding-languages" disabled={locked}>
      <legend>{t('onboarding.language.label')}</legend>
      <div>{LOCALES.map(language => <label key={language} className={`onboarding-language${locale === language ? ' selected' : ''}`}>
        <input type="radio" name="onboarding-language" value={language} checked={locale === language} onChange={() => void onSave({ language })} />
        <span className="onboarding-language-code">{language.toUpperCase()}</span><b>{LOCALE_NAMES[language]}</b><span className="onboarding-language-check"><Icon.done /></span>
      </label>)}</div>
    </fieldset>
    <div className="onboarding-preference">
      <span className="onboarding-preference-icon"><Icon.terminal /></span>
      <div><b>{t('onboarding.background.label')}</b><p>{t('onboarding.background.hint')}</p></div>
      <Switch on={settings?.keepInBackground ?? true} disabled={locked} title={t('onboarding.background.label')} onChange={keepInBackground => void onSave({ keepInBackground })} />
    </div>
    <div className="onboarding-preference">
      <span className="onboarding-preference-icon"><Icon.bell /></span>
      <div><b>{t('onboarding.notifications.label')}</b><p>{t('onboarding.notifications.hint')}</p></div>
      <Switch on={settings?.notifications.enabled ?? true} disabled={locked} title={t('onboarding.notifications.label')} onChange={enabled => void onSave({ notifications: { enabled } })} />
    </div>
    <div className="onboarding-save-status" role="status">{loading || saving ? <><span className="onboarding-spin"><Icon.spinner /></span>{t(loading ? 'onboarding.settings.loading' : 'onboarding.settings.saving')}</> : !error && settings ? <><Icon.done />{t('onboarding.settings.saved')}</> : null}</div>
    {error && <InlineError message={t('onboarding.settings.error', { error })} onRetry={onRetry} disabled={saving || loading} />}
  </div>
}

function AgentsStep({ state, onScan }: { state: OnboardingScanState; onScan(): void }): React.JSX.Element {
  const t = useT()
  const groups = onboardingAgentGroups(state.agents)
  return <div className="onboarding-agents">
    <div className="onboarding-agents-toolbar">
      <span role="status">{state.busy ? t('onboarding.agents.checking') : state.agents ? t('onboarding.agents.count', { count: formatInteger(groups.installed.length) }) : t('onboarding.agents.unknown')}</span>
      <button type="button" className="onboarding-secondary" disabled={state.busy} onClick={onScan}><span className={state.busy ? 'onboarding-spin' : ''}><Icon.refresh /></span>{t('onboarding.agents.recheck')}</button>
    </div>
    {state.agents === null && state.busy && <div className="onboarding-agent-loading" role="status"><span className="onboarding-spin"><Icon.spinner /></span><b>{t('onboarding.agents.scanning')}</b><p>{t('onboarding.agents.scanHint')}</p></div>}
    {state.agents !== null && groups.installed.length === 0 && <div className="onboarding-agent-empty"><Icon.terminal /><b>{t('onboarding.agents.noneTitle')}</b><p>{t('onboarding.agents.none')}</p></div>}
    {groups.installed.length > 0 && <div className="onboarding-agent-grid" role="list" aria-label={t('onboarding.agents.installedList')}>
      {groups.installed.map((agent, index) => <div className="onboarding-agent" key={agent.id} role="listitem" style={{ '--agent-delay': `${Math.min(index, 4) * 35}ms` } as React.CSSProperties}>
        <div className="onboarding-agent-top"><AgentLogo agent={agent.id} size={30} /><span className="onboarding-agent-check"><Icon.done /></span></div>
        <b>{agentTitle(agent.id)}</b><span className="onboarding-agent-version" title={agent.version ?? undefined}>{agent.version ?? t('onboarding.agents.noVersion')}</span>
        <span className="onboarding-agent-status"><span />{t('onboarding.agents.installed')}</span>
      </div>)}
    </div>}
    {state.error && <InlineError message={t('onboarding.agents.error', { error: state.error })} />}
    {groups.missing.length > 0 && <details className="onboarding-missing"><summary>{t('onboarding.agents.missingList', { count: formatInteger(groups.missing.length) })}</summary>
      <div>{groups.missing.map(agent => <div key={agent.id}><AgentLogo agent={agent.id} size={20} /><b>{agentTitle(agent.id)}</b><span>{t('onboarding.agents.missing')}</span></div>)}</div>
    </details>}
    {groups.installed.length > 0 && <p className="onboarding-agent-auth"><Icon.info />{t('onboarding.agents.authHint')}</p>}
  </div>
}

function ProjectStep({ projects, busy, disabled, error, onAdd }: { projects: Project[]; busy: boolean; disabled: boolean; error: string | null; onAdd(): void }): React.JSX.Element {
  const t = useT()
  return <div className="onboarding-project-step">
    <button type="button" className="onboarding-add" disabled={disabled} aria-busy={busy} onClick={onAdd}>
      <span className="onboarding-add-icon"><Icon.folderPlus /></span><span><b>{t(busy ? 'onboarding.project.adding' : 'onboarding.project.add')}</b><span>{t('onboarding.project.addHint')}</span></span>
      {busy ? <span className="onboarding-spin"><Icon.spinner /></span> : <Icon.plus />}
    </button>
    {error && <InlineError message={t('onboarding.project.error', { error })} />}
    {projects.length > 0 && <div className="onboarding-projects"><h3>{t('onboarding.project.added')}</h3>{projects.map(project => <div key={project.id} className="onboarding-project"><Icon.folder /><div><b>{project.name}</b><span>{project.root}</span></div><Icon.done /></div>)}</div>}
    <div className="onboarding-project-note"><Icon.shield /><div><b>{t('onboarding.project.noteTitle')}</b><p>{t('onboarding.project.note')}</p></div></div>
    <p className="onboarding-project-ready">{projects.length > 0 && <Icon.done />}{t(projects.length > 0 ? 'onboarding.project.ready' : 'onboarding.project.later')}</p>
  </div>
}

function InlineError({ message, onRetry, disabled }: { message: string; onRetry?(): void; disabled?: boolean }): React.JSX.Element {
  const t = useT()
  return <div className="onboarding-error" role="alert"><span>{message}</span>{onRetry && <button type="button" className="onboarding-secondary" disabled={disabled} onClick={onRetry}>{t('onboarding.retry')}</button>}</div>
}
