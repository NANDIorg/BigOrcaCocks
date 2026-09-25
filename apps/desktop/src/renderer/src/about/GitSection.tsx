import type React from 'react'
import { useEffect, useState } from 'react'
import { normalizeRunBranchSettings, runBranchName, runBranchSettingsProblems, type RunBranchSettings } from '@orca-board/core'
import type { Project } from '../../../shared/ipc'
import { staleAppMessage } from '../docLinks'
import { ipcErrorMessage } from '../useAutoSave'
import { useT } from '../i18n'
import { SectionHead, Switch, withCode } from './parts'

/** Форма: защищённые ветки редактируются строкой через запятую. */
interface Draft extends Omit<RunBranchSettings, 'protected'> {
  protected: string
}

function toDraft(s: RunBranchSettings): Draft {
  return { ...s, protected: s.protected.join(', ') }
}

function fromDraft(d: Draft): RunBranchSettings {
  return normalizeRunBranchSettings({ ...d, protected: d.protected.split(',') })
}

const EXAMPLE_BASE = 'origin/develop'

/**
 * Раздел «Git» проекта: ветка на каждую глобальную задачу (база, шаблон имени, push) и защищённые ветки.
 * Сохраняется кнопкой: полусобранный шаблон ветки не должен уходить в main на каждый символ.
 */
export function GitSection({ project, onProjectChanged }: {
  project: Project
  onProjectChanged(): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const saved = normalizeRunBranchSettings(project.git)
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved))
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Проект сменился или настройки пришли из main — форма заново.
  const savedKey = JSON.stringify(saved)
  useEffect(() => {
    setDraft(toDraft(normalizeRunBranchSettings(project.git)))
    setError(null)
  }, [project.id, savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = fromDraft(draft)
  const problems = runBranchSettingsProblems(next)
  const dirty = JSON.stringify(next) !== savedKey
  const example = runBranchName(next.template, { id: 'run_mh2k9x1', title: t('config.about.git.enabled') })

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
    setDone(false)
  }

  async function save(): Promise<void> {
    // Renderer обновился по HMR, а preload старый — метода ещё нет.
    const setGit = window.orca.projects.setGit
    if (!setGit) {
      setError(staleAppMessage())
      return
    }
    try {
      await setGit(project.id, next)
      setError(null)
      setDone(true)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
    await onProjectChanged()
  }

  return (
    <>
      <SectionHead title={t('config.about.nav.git')} hint={t('config.about.git.hint')} />
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('config.about.git.enabled')}</b>
            <span className="hint">{t('config.about.git.enabledHint')}</span>
          </div>
          <Switch on={draft.enabled} onChange={(on) => set('enabled', on)} />
        </div>
      </div>
      <div className="about-box git-form">
        <label>
          <span>{t('config.about.git.base')}</span>
          <input
            value={draft.base}
            placeholder={t('config.about.git.basePlaceholder')}
            disabled={!draft.enabled}
            onChange={(e) => set('base', e.target.value)}
          />
          <span className="hint">{withCode(t('config.about.git.baseHint'), EXAMPLE_BASE, 'example')}</span>
        </label>
        <label>
          <span>{t('config.about.git.template')}</span>
          <input value={draft.template} disabled={!draft.enabled} onChange={(e) => set('template', e.target.value)} />
          <span className="hint">{withCode(t('config.about.git.templateHint'), example, 'example')}</span>
        </label>
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('config.about.git.push')}</b>
            <span className="hint">{t('config.about.git.pushHint')}</span>
          </div>
          <Switch on={draft.push} disabled={!draft.enabled} onChange={(on) => set('push', on)} />
        </div>
        <label>
          <span>{t('config.about.git.remote')}</span>
          <input value={draft.remote} disabled={!draft.enabled} onChange={(e) => set('remote', e.target.value)} />
        </label>
      </div>
      <div className="about-box git-form">
        <label>
          <span>{t('config.about.git.protected')}</span>
          <input value={draft.protected} onChange={(e) => set('protected', e.target.value)} />
          <span className="hint">{t('config.about.git.protectedHint')}</span>
        </label>
      </div>
      <div className="git-actions">
        <button type="button" className="btn-sm primary" disabled={!dirty || problems.length > 0} onClick={() => void save()}>
          {t('config.about.git.save')}
        </button>
        {done && !dirty && <span className="muted">{t('config.about.git.saved')}</span>}
      </div>
      {problems.map((p) => <div key={p.code} className="editor-error">{t(`config.about.git.issue.${p.code}`)}</div>)}
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
