import type React from 'react'
import { plural } from './plural'
import type { ApplyPreview } from './projectType'

interface Props {
  preview: ApplyPreview
  /** Название шаблона для строки «Тип проекта станет …»; не задано — строки нет («Взять из шаблона»). */
  typeTitle?: string
  /** false — задачи проекта неизвестны (старый main без `projects:taskRefs`): без счётчиков и обещаний про задачи. */
  tasksKnown?: boolean
}

/**
 * Последствия применения шаблона к проекту (`applyPreview`): исчезающие колонки и роли, backlog, ошибка графа.
 * Общий для «О проекте» (`about/ApplyTemplateModal.tsx`) и «Настройки → Применить к проектам…» (`settings/BulkApplyModal.tsx`).
 */
export function ApplyConsequences({ preview, typeTitle, tasksKnown = true }: Props): React.JSX.Element {
  const { columnsGone, backlogTasks, rolesGone, notes, error, setsType } = preview
  const tasksLabel = (n: number): string => `${n} ${plural(n, 'задача', 'задачи', 'задач')}`
  const count = (n: number, text: (s: string) => string): string => (tasksKnown && n ? text(tasksLabel(n)) : '')
  const lossless = !columnsGone.length && !backlogTasks && !rolesGone.length
  return (
    <div className="tpl-conseq">
      {error && (
        <div className="tpl-conseq-error">
          <b>Граф не пройдёт проверку — применить нельзя.</b>
          <span>{error}</span>
        </div>
      )}
      {columnsGone.length > 0 && (
        <div className="tpl-conseq-item">
          <b>Исчезнут колонки:</b>{' '}
          {columnsGone.map((c) => `«${c.title}»${count(c.tasks, (s) => ` (${s})`)}`).join(', ')}.
          {!tasksKnown && ' Задачи из них переедут в бэклог.'}
        </div>
      )}
      {tasksKnown && backlogTasks > 0 && (
        <div className="tpl-conseq-item"><b>В бэклог переедет {tasksLabel(backlogTasks)}.</b></div>
      )}
      {rolesGone.map((r) => (
        <div key={r.id} className="tpl-conseq-item">
          <b>Пропадёт роль «{r.title}»{count(r.tasks, (s) => ` — на ней ${s}`)}.</b>
          {r.consequences.length > 0 && (
            <ul>{r.consequences.map((c) => <li key={c}>{c}</li>)}</ul>
          )}
        </div>
      ))}
      {lossless && !error && <div className="tpl-conseq-item muted">Колонки и роли не пропадут, задачи останутся на местах.</div>}
      {notes.map((n) => <div key={n} className="tpl-conseq-item muted">{n}</div>)}
      {typeTitle !== undefined && (
        <div className="tpl-conseq-item muted">
          {setsType
            ? `Тип проекта станет «${typeTitle}».`
            : 'Взяты не все разделы — тип проекта не изменится, изменятся только выбранные разделы.'}
        </div>
      )}
    </div>
  )
}
