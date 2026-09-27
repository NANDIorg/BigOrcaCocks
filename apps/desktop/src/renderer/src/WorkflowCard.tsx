import type React from 'react'
import type { WfCardId, WfCardIssues } from './workflowEditorView'
import { useT } from './i18n'

/**
 * Карточка инспектора воркфлоу: заголовок и поля одной темы («Основное», «Кто выполняет»…). Все карточки раскрыты.
 * Карточка с проблемой — с точкой и рамкой цвета проблемы, тексты проблем — под полями. `data-card` — чтобы палитра
 * могла перевести фокус на «Свою ноду».
 */
export function WfCard({ id, title, issue, accent, children }: {
  id: WfCardId | 'head' | 'edge' | 'nodes'
  title?: string
  issue?: WfCardIssues
  /** Подсветка без проблемы: карточка «Путь подзадачи» — цветом ноды «Работа». */
  accent?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const cls = ['wf-card', issue && `wf-card--${issue.level}`, !issue && accent && 'wf-card--accent'].filter(Boolean).join(' ')
  return (
    <section className={cls} data-card={id} aria-label={title}>
      {title && (
        <h4 className="wf-card-head">
          {issue && <IssueDot level={issue.level} />}
          {title}
        </h4>
      )}
      <div className="wf-card-body">
        {children}
        {issue && <IssueNotes issue={issue} />}
      </div>
    </section>
  )
}

/** Точка уровня проблемы; для скринридера — словом. */
export function IssueDot({ level }: { level: 'error' | 'warning' }): React.JSX.Element {
  const t = useT()
  return <span className={`wf-dot wf-dot--${level}`} role="img" aria-label={level === 'error' ? t('config.wf.insp.error') : t('config.wf.insp.warning')} />
}

/** Тексты проблем карточки — под её полями, цветом уровня. */
export function IssueNotes({ issue }: { issue: WfCardIssues }): React.JSX.Element {
  return (
    <ul className={`wf-field-errs wf-field-errs--${issue.level}`}>
      {issue.messages.map((m, i) => <li key={i}>{m}</li>)}
    </ul>
  )
}
