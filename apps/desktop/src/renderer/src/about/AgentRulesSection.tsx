import type React from 'react'
import type { Project } from '../../../shared/ipc'
import { useAutoSave } from '../useAutoSave'
import { AGENT_RULES_PLACEHOLDER, AGENT_RULES_STALE_MESSAGE, agentRulesApi, isStaleAgentRulesError } from '../agentRules'
import { SectionHead } from './parts'

/**
 * «О проекте → Правила доски»: `Project.agentRules` — блок «# Правила проекта» в системном промпте
 * воркеров всех ролей и координатора. Живут в конфиге доски, а не в CLAUDE.md/AGENTS.md (раздел «Правила»),
 * поэтому обычные сессии агентов в репозитории их не видят. Сохраняется автоматически, как роли и колонки.
 */
export function AgentRulesSection({ project, onSaved }: {
  project: Project
  /** Перечитать проекты: счётчик в меню и дефолт-сравнение берут правила из Project. */
  onSaved(): Promise<void>
}): React.JSX.Element {
  // Старый preload метода не знает — поле только для чтения и сообщение «перезапустите».
  const stale = !window.orca.projects.setAgentRules

  const { draft, error, update } = useAutoSave(project.id, project.agentRules ?? '', async (text) => {
    try {
      await agentRulesApi(window.orca)(project.id, text)
    } catch (e) {
      if (e instanceof Error && isStaleAgentRulesError(e.message)) throw new Error(AGENT_RULES_STALE_MESSAGE)
      throw e
    }
    await onSaved()
  })

  return (
    <>
      <SectionHead
        title="Правила доски"
        hint={
          <>
            Markdown, который получают только агенты, запущенные доской: воркеры всех ролей и координатор — блоком
            «Правила проекта» в системном промпте. Сюда — то, что нужно при работе по задачам доски, но мешало бы
            в обычной сессии.
          </>
        }
      />
      <div className="agent-rules">
        <textarea
          value={draft}
          placeholder={AGENT_RULES_PLACEHOLDER}
          rows={12}
          spellCheck={false}
          disabled={stale}
          aria-label="Правила для агентов доски"
          onChange={(e) => update(e.target.value, true)}
        />
        {(stale || error) && <div className="editor-error">{stale ? AGENT_RULES_STALE_MESSAGE : error}</div>}
        <ul className="agent-rules-notes hint">
          <li>Сохраняется автоматически и действует со следующего запуска воркера или координатора — запущенные агенты правила не перечитывают.</li>
          <li>
            Это <b>не</b> CLAUDE.md и AGENTS.md: те лежат в репозитории, их читает любая сессия агента (раздел «Правила»).
            Эти хранятся в настройках доски и в репозиторий не попадают.
          </li>
          <li>Ассистент проекта и терминалы, открытые вручную, этих правил не получают.</li>
          <li>Правила отдельной роли — в «Роли → Инструкции роли»; они идут после правил доски.</li>
        </ul>
      </div>
    </>
  )
}
