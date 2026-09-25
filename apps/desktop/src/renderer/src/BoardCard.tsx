import type React from 'react'
import { type Role, type Run, type Task } from '@orca-board/core'
import { Icon } from './icons'
import { AgentLogo } from './AgentLogo'
import { RunBadge } from './runs'
import { priorityMark } from './taskPriority'
import { formatStamp } from './boardSort'
import { formatDuration, taskDuration, taskTicking } from './duration'
import { cardStateLabel, type CardEssence, type CardState, type DepsLabel, type StageLabel } from './cardState'
import { useNow } from './useNow'
import { useT } from './i18n'
import { agentTitle } from './defaultTitles'

/** «роль · модель» в мета-строке; модели нет — «роль · агент». Полная строка «роль · агент · модель» — в подсказке. */
function who(task: Task, role: Role | undefined): { short: string; full: string } {
  const title = role?.title ?? task.roleId
  const agent = agentTitle(task.agent)
  return {
    short: `${title} · ${role?.model || agent}`,
    full: [title, agent, role?.model].filter(Boolean).join(' · ')
  }
}

/** Живой счётчик задачи в работе: таймер только у таких карточек, доска целиком не перерисовывается. */
function LiveTime({ task }: { task: Task }): React.JSX.Element {
  const now = useNow()
  const t = useT()
  return <span className="time live" title={t('board.card.timeLive')}>● {formatDuration(taskDuration(task, now) ?? 0)}</span>
}

/**
 * Время работы в правом краю мета-строки: в работе — живой счётчик (оранжевый), иначе застывшее накопленное (⏸).
 * Не бывала в работе — ничего.
 */
function CardTime({ task }: { task: Task }): React.JSX.Element | null {
  const t = useT()
  if (taskTicking(task)) return <LiveTime task={task} />
  const ms = taskDuration(task, 0)
  if (ms === undefined) return null
  return <span className="time" title={t('board.card.timePaused')}>⏸ {formatDuration(ms)}</span>
}

export interface BoardCardProps {
  task: Task
  state: CardState
  /** Вид колонки — done показывает время завершения. */
  isDone: boolean
  role: Role | undefined
  stage: StageLabel | null
  deps: DepsLabel | null
  /** Пунктирная строка сути; действие на карточке не дублирует ленту «Ждут вас». */
  essence: CardEssence | null
  /** Текст для `aria-label`: состояние и суть. */
  ariaLabel: string
  run?: Run
  runs: Run[]
  showUpdated: boolean
  selected: boolean
  /** Roving tabindex: только у одной карточки доски tabindex=0, остальные достижимы стрелками. */
  tabStop: boolean
  terminalOpen: boolean
  canStart: boolean
  /** Показывать «замечания» (feedback) — не в ревью, там их и так видно в форме ревью. */
  showFeedback: boolean
  /** Есть лента «Ждут вас» — на карточке ссылка «в ленте ↑». */
  revealable: boolean
  onOpen(): void
  onStart(): void
  onRemove(): void
  onReveal(): void
  /** Открыть меню «Переместить в…» — вызывается с карточкой, к которой оно привязано. */
  onMenu(card: HTMLElement): void
  onFocus(): void
  onDragStart(e: React.DragEvent): void
  onDragEnd(): void
}

/**
 * Карточка подзадачи. Слева — полоса состояния (цвет + текст в `aria-label` и в строке сути), в мета-строке —
 * агент, роль и время, ниже — пилюля этапа воркфлоу, ветка и свёрнутые зависимости.
 */
export function BoardCard(props: BoardCardProps): React.JSX.Element {
  const { task, state, isDone, role, stage, deps, essence, run, runs } = props
  const t = useT()
  const prio = priorityMark(task)
  const w = who(task, role)
  return (
    <article
      className={`card s-${state} ${props.selected ? 'selected' : ''}`}
      data-card-id={task.id}
      tabIndex={props.tabStop ? 0 : -1}
      aria-label={props.ariaLabel}
      draggable
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onClick={props.onOpen}
      onFocus={props.onFocus}
    >
      <div className="line1">
        {prio && <span className={`prio ${prio.priority}`} title={t('board.card.priority', { title: prio.title })} aria-label={t('board.card.priority', { title: prio.title })}>{prio.mark}</span>}
        <div className="name" title={task.title}>{task.title}</div>
      </div>
      <div className="tools" onClick={(e) => e.stopPropagation()}>
        {props.canStart && (
          <button type="button" className="lb-tool" title={t('board.card.startTitle')} aria-label={t('board.card.start')} onClick={props.onStart}>
            <Icon.play />
          </button>
        )}
        <button
          type="button"
          className="lb-tool"
          title={t('board.card.moveTitle')}
          aria-label={t('board.move.title')}
          aria-haspopup="menu"
          onClick={(e) => props.onMenu(e.currentTarget.closest<HTMLElement>('.card') ?? e.currentTarget)}
        >
          <Icon.more />
        </button>
        <button type="button" className="lb-tool danger" title={t('board.remove')} aria-label={t('board.remove')} onClick={props.onRemove}>
          <Icon.trash />
        </button>
      </div>
      <div className="meta">
        <AgentLogo agent={task.agent} size={16} />
        <span className="who" title={w.full}>{w.short}</span>
        <span className="grow" />
        {!isDone && task.doneAt === undefined && <CardTime task={task} />}
      </div>
      <div className="tags">
        {stage && <span className={`stage-pill ${stage.kind}`} title={stage.title}>{stage.text}</span>}
        {task.answerFor && (
          <span className="tag answer" title={task.answerFor === 'human' ? t('board.card.answerHumanTitle') : t('board.card.answerCoordTitle')}>
            {task.answerFor === 'human' ? t('board.card.answerHuman') : t('board.card.answerCoord')}
          </span>
        )}
        {run && <RunBadge run={run} runs={runs} />}
        {task.branch && !task.answerFor && <span className="tag mono" title={task.branch}>{task.branch}</span>}
        {deps && <span className="tag dep" title={deps.title}>{deps.text}</span>}
        {props.terminalOpen && <span className="tag live" title={t('board.card.terminalTitle')}>● {t('board.card.terminal')}</span>}
      </div>
      {isDone && task.doneAt !== undefined ? (
        <div className="stamp">
          {t('board.card.doneAt', { at: formatStamp(task.doneAt) })}
          {taskDuration(task, task.doneAt) !== undefined && <> · {t('board.card.took', { value: formatDuration(taskDuration(task, task.doneAt) ?? 0) })}</>}
        </div>
      ) : props.showUpdated ? (
        <div className="stamp">{t('board.card.updatedAt', { at: formatStamp(task.updatedAt) })}</div>
      ) : null}
      {props.showFeedback && task.feedback && <div className="card-feedback" title={task.feedback}>↩ {task.feedback}</div>}
      {essence && (
        <div className="act linked">
          <span className="txt" title={essence.title ?? essence.text}>{essence.text}</span>
          {props.revealable && (
            <button
              type="button"
              className="to-feed"
              aria-label={t('board.card.revealAria', { what: cardStateLabel(state) || task.title })}
              onClick={(e) => {
                e.stopPropagation()
                props.onReveal()
              }}
            >
              {t('board.card.reveal')}
            </button>
          )}
        </div>
      )}
    </article>
  )
}
