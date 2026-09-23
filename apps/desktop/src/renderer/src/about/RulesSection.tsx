import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { RULE_FILE_NAMES, type RuleFile, type RuleFileName } from '../../../shared/ipc'
import { Markdown } from '../Markdown'
import { Icon } from '../icons'
import { ipcErrorMessage } from '../useAutoSave'
import { isDirty, isStaleRulesError, pickRule, ruleByName, rulesApi, RULES_STALE_MESSAGE, RULE_HINTS, RULE_TEMPLATES } from '../rules'
import { SectionHead } from './parts'

const FILE_KEY = 'orca.rulesFile'

function errorText(e: unknown): string {
  const msg = ipcErrorMessage(e)
  return isStaleRulesError(msg) ? RULES_STALE_MESSAGE : msg
}

function storedFile(): string | null {
  try {
    return localStorage.getItem(FILE_KEY)
  } catch {
    return null
  }
}

function storeFile(name: RuleFileName): void {
  try {
    localStorage.setItem(FILE_KEY, name)
  } catch {
    // localStorage недоступен — выбор просто не переживёт перезапуск
  }
}

/**
 * «О проекте → Правила»: CLAUDE.md и AGENTS.md из корня репозитория проекта. Просмотр — через
 * Markdown (санитайзер), правка — исходник в textarea; main пишет только эти два файла и не коммитит.
 * Монтируется с key = id проекта: черновик не переезжает в чужой проект.
 */
export function RulesSection({ root }: { root: string }): React.JSX.Element {
  const [files, setFiles] = useState<RuleFile[] | null>(null)
  const [current, setCurrent] = useState<RuleFileName | null>(null)
  /** null — режим просмотра; строка — черновик в редакторе. */
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await rulesApi(window.orca).list()
      setFiles(list)
      setCurrent((c) => c ?? pickRule(list, storedFile()))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const file = files && current ? ruleByName(files, current) : null
  const dirty = file ? isDirty(draft, file.text) : false

  /** Уйти из черновика; с несохранёнными изменениями — только после подтверждения. */
  function leaveDraft(): boolean {
    if (dirty && !confirm(`В ${current} есть несохранённые изменения. Отменить их?`)) return false
    setDraft(null)
    return true
  }

  function choose(name: RuleFileName): void {
    if (name === current || !leaveDraft()) return
    setCurrent(name)
    storeFile(name)
    setError(null)
  }

  async function save(): Promise<void> {
    if (!file || draft === null || saving) return
    setSaving(true)
    try {
      const saved = await rulesApi(window.orca).save(file.name, draft)
      setFiles((fs) => (fs ?? []).map((f) => (f.name === saved.name ? saved : f)))
      setDraft(null)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      leaveDraft()
    }
  }

  const editing = draft !== null

  return (
    <>
      <SectionHead
        title="Правила"
        hint={<>Инструкции для агентов в корне репозитория <code>{root}</code>. Сохранение только записывает файл — закоммитьте его сами.</>}
      >
        {file && !editing && file.exists && (
          <div className="rules-actions">
            <button type="button" className="btn-sm" onClick={() => void load()} title="Перечитать с диска">
              <Icon.refresh /> Обновить
            </button>
            <button type="button" className="btn-sm primary" onClick={() => setDraft(file.text)}>
              <Icon.edit /> Редактировать
            </button>
          </div>
        )}
      </SectionHead>

      <div className="rules-tabs" role="tablist" aria-label="Файл правил">
        {RULE_FILE_NAMES.map((name) => {
          const f = files ? ruleByName(files, name) : null
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === current}
              className={name === current ? 'on' : ''}
              onClick={() => choose(name)}
            >
              {name}
              {f && !f.exists && <span className="rules-tab-note">нет</span>}
              {name === current && dirty && <span className="rules-dirty" title="Есть несохранённые изменения">●</span>}
            </button>
          )
        })}
      </div>
      {current && <p className="hint rules-hint">{RULE_HINTS[current]}</p>}

      {error && <p className="error-text rules-error">{error}</p>}

      {!files && !error && <p className="rules-loading">Загрузка…</p>}

      {file && editing && (
        <div className="rules-editor">
          <textarea
            value={draft}
            spellCheck={false}
            autoFocus
            aria-label={`Исходный markdown ${file.name}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="rules-editor-foot">
            <span className={`rules-status ${dirty ? 'dirty' : ''}`}>
              {dirty ? 'Есть несохранённые изменения' : file.exists ? 'Без изменений' : 'Новый файл — ещё не сохранён'}
              {file.eol === 'crlf' && ' · переводы строк CRLF сохранятся'}
            </span>
            <button type="button" className="btn-sm" disabled={saving} onClick={() => leaveDraft()}>Отмена</button>
            <button
              type="button"
              className="btn-sm primary"
              disabled={saving || (file.exists && !dirty)}
              title="⌘S / Ctrl+S"
              onClick={() => void save()}
            >
              {saving ? 'Сохранение…' : file.exists ? 'Сохранить' : 'Создать файл'}
            </button>
          </div>
        </div>
      )}

      {file && !editing && !file.exists && (
        <div className="about-box rules-empty">
          <p><b>{file.name}</b> в корне проекта нет.</p>
          <p className="hint">«Создать» откроет редактор с заготовкой — файл появится на диске после сохранения.</p>
          <button type="button" className="btn-sm primary" onClick={() => setDraft(RULE_TEMPLATES[file.name])}>
            <Icon.plus /> Создать
          </button>
        </div>
      )}

      {file && !editing && file.exists && (
        file.text.trim()
          ? <div className="about-box rules-view"><Markdown text={file.text} variant="doc" /></div>
          : <div className="about-box rules-empty"><p className="hint">Файл пустой — нажмите «Редактировать».</p></div>
      )}
    </>
  )
}
