import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentSession, BoardColumn, ColumnKind, GlobalTask, RunGit } from '@orca-board/core'
import { Icon } from './icons'
import { GlobalDuration } from './GlobalBoard'
import { PriorityBadge } from './Priority'
import { MoveMenu } from './MoveMenu'
import { focusFeed } from './feedLink'
import { useNow } from './useNow'
import { formatStamp } from './boardSort'
import { useT } from './i18n'
import { branchChip, prLink } from './runBranch'
import { coordinatorPill, currentStep, headerActions, statusSteps, type StatusStep } from './globalScreen'

interface Props {
  global: GlobalTask
  /** Вид колонки глобального канбана, где сейчас задача (review — «Проверка»). */
  statusKind?: ColumnKind
  /** Колонки глобального канбана (`globalBoardColumns`) — шаги степпера статуса. Нет — степпера нет. */
  columns?: BoardColumn[]
  /** Живой координатор этой глобальной задачи (ptyId), если есть. */
  coordinatorPty?: string
  /** Запуски координатора (`Run.coordinatorSessions`): модель, номер и время запуска. Со старым main их нет. */
  coordinatorSessions?: AgentSession[]
  /** Сколько пунктов в ленте «Ждут вас» — число в «Ответить · N». */
  attentionCount?: number
  /** Название типа задачи (`globalTypeTitle`) — чип рядом с приоритетом; нет — чипа нет. */
  typeTitle?: string
  onBack(): void
  onEdit(): void
  /** Клик по шагу степпера: перенести задачу в колонку (`globalTasks.move`). */
  onMove(status: string): void
  onStartCoordinator(): void
  onShowCoordinator(ptyId: string): void
  /** «■ Остановить» после подтверждения: закрыть терминал координатора. */
  onStopCoordinator(ptyId: string): void
  /** «⋯ → Удалить задачу…»; нет — меню «⋯» не показывается. */
  onRemove?(): void
  /** «Подтвердить» на «Проверке». */
  onAccept(): void
  /** «Вернуть в работу…» на «Проверке» — модалка с уточнением. */
  onReturn(): void
}

/**
 * Шапка экрана глобальной задачи: три строки, высота не зависит от состояния (макет `variant-a.html`).
 * 1) крошка «← Глобальные задачи» и степпер статуса (в узком окне — чип «Проверка ▾»);
 * 2) заголовок и действия: одно главное по состоянию (`headerActions`), «Изменить» и «⋯» — второстепенные;
 * 3) мета: приоритет, тип, пилюля координатора, время. Цель, сводка и уточнения — на вкладке «Итог и цель»
 * (`GlobalOverview`). Живёт над лентой «Ждут вас» и вкладками.
 */
export function GlobalTaskHeader(props: Props): React.JSX.Element {
  const { global, statusKind, columns, coordinatorPty, typeTitle, onBack, onEdit, onStartCoordinator, onAccept, onReturn } = props
  const t = useT()
  const actions = headerActions(global, statusKind, coordinatorPty !== undefined, props.attentionCount)
  const steps = columns ? statusSteps(columns, global.status) : []
  const backRef = useRef<HTMLButtonElement>(null)

  // Открыли с клавиатуры/мышью — фокус на «назад», чтобы Enter/Escape сразу вели обратно.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true })
  }, [global.id])

  const primary = actions.primary
  return (
    <header className="gt-head">
      <div className="gt-head-row1">
        <button ref={backRef} type="button" className="gt-back" onClick={onBack} title={t('global.header.backTitle')}>
          <span aria-hidden>←</span> {t('global.header.back')}
        </button>
        {!global.inbox && steps.length > 0 && <StatusSteps steps={steps} onMove={props.onMove} />}
      </div>
      <div className="gt-head-row2">
        <h2 className="gt-head-title" title={global.title}>{global.title}</h2>
        <div className="gt-head-actions">
          {primary?.kind === 'accept' && (
            <button type="button" className="btn-sm gt-cta ok" onClick={onAccept} title={t('global.action.acceptTitle')}>
              ✓ {primary.label}
            </button>
          )}
          {actions.returnToWork && (
            <button type="button" className="btn-sm" title={t('global.action.returnTitle')} onClick={onReturn}>
              {t('global.action.return')}
            </button>
          )}
          {primary?.kind === 'answer' && (
            <button type="button" className="btn-sm primary gt-cta" onClick={focusFeed} title={t('global.header.answerTitle')}>
              {primary.label} <kbd className="rq-kbd">G</kbd>
            </button>
          )}
          {primary?.kind === 'start' && (
            <button type="button" className="btn-sm primary gt-cta" onClick={onStartCoordinator}>
              <Icon.play /> {primary.label}
            </button>
          )}
          {actions.quietStart && (
            <button type="button" className="btn-sm" onClick={onStartCoordinator}><Icon.play /> {t('global.action.start')}</button>
          )}
          <button type="button" className="btn-sm gt-quiet" onClick={onEdit} title={t('global.header.editTitle')}>
            <Icon.edit /> {t('global.header.edit')}
          </button>
          {props.onRemove && !global.inbox && <MoreMenu onRemove={props.onRemove} />}
        </div>
      </div>
      <div className="gt-head-row3">
        {/* Правка — в «Изменить» (GlobalTaskModal); здесь только бейдж, normal без него, как на карточке. */}
        <PriorityBadge item={global} className="g-chip" />
        {typeTitle && <span className="g-chip task-type-chip" title={t('global.header.typeTitle')}>{typeTitle}</span>}
        {global.git && <BranchChip git={global.git} />}
        {global.git && <PrChip git={global.git} />}
        {!global.inbox && (
          <CoordinatorPill
            global={global}
            coordinatorPty={coordinatorPty}
            sessions={props.coordinatorSessions}
            onShow={props.onShowCoordinator}
            onStop={props.onStopCoordinator}
          />
        )}
        {!global.inbox && (
          <span className="gt-time muted" title={global.closedAt !== undefined
            ? t('global.header.createdClosed', { created: formatStamp(global.createdAt), closed: formatStamp(global.closedAt) })
            : t('global.header.created', { date: formatStamp(global.createdAt) })}>
            <GlobalDuration global={global} variant="line" />
          </span>
        )}
        {global.inbox && <span className="muted">{t('global.header.inbox')}</span>}
      </div>
    </header>
  )
}

/** Ветка глобальной задачи: имя, тон по итогу push; клик копирует имя (для PR и `git switch`). */
function BranchChip({ git }: { git: RunGit }): React.JSX.Element {
  const t = useT()
  const chip = branchChip(git)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={`g-chip gt-branch ${chip.tone}`}
      title={chip.title}
      onClick={() => void navigator.clipboard.writeText(git.branch).then(() => setCopied(true), () => undefined)}
    >
      <Icon.branch /> {copied ? t('global.branch.copied') : chip.label}
    </button>
  )
}

/** Ссылка на PR ветки; нет prUrl (старый main, PR не создан) — нет чипа. Внешние ссылки уходят в shell.openExternal. */
function PrChip({ git }: { git: RunGit }): React.JSX.Element | null {
  const t = useT()
  const url = prLink(git)
  if (!url) return null
  return (
    <a className="g-chip gt-branch gt-pr ok" href={url} target="_blank" rel="noreferrer" title={t('global.branch.prLinkTitle')}>
      {t('global.branch.prLink')}
    </a>
  )
}

/**
 * Степпер статуса: клик по шагу переносит задачу. «Нужен ответ» не кликается — она вычисляется. В узком окне
 * (CSS) вместо ленты шагов — чип текущего статуса с меню «Переместить в…» (`MoveMenu`, цифра = номер колонки).
 */
function StatusSteps({ steps, onMove }: { steps: StatusStep[]; onMove(status: string): void }): React.JSX.Element {
  const t = useT()
  const now = currentStep(steps)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <div className="gt-steps" role="group" aria-label={now ? t('global.steps.aria', { title: now.title }) : t('global.steps.status')}>
        {steps.map((s, i) => (
          <span key={s.id} className="gt-step-wrap" style={{ '--c': s.color } as React.CSSProperties}>
            {i > 0 && <span className="gt-step-sep" aria-hidden />}
            <button
              type="button"
              className={`gt-step ${s.state}`}
              aria-current={s.state === 'now' ? 'step' : undefined}
              disabled={!s.movable && s.state !== 'now'}
              title={s.state === 'now' ? t('global.steps.current') : t(s.movable ? 'global.steps.move' : 'global.steps.auto', { title: s.title })}
              onClick={() => s.movable && onMove(s.id)}
            >
              <i aria-hidden />{s.title}
            </button>
          </span>
        ))}
      </div>
      <button
        ref={chipRef}
        type="button"
        className="gt-status-chip"
        style={{ '--c': now?.color ?? 'var(--chip)' } as React.CSSProperties}
        aria-haspopup="menu"
        title={t('global.steps.moveTo')}
        onClick={() => setMenu(chipRef.current)}
      >
        {now?.title ?? t('global.steps.status')} <span aria-hidden>▾</span>
      </button>
      {menu && (
        <MoveMenu
          anchor={menu}
          // «Нужен ответ» ставится сама — переносить в неё нельзя, и подпись «здесь» у неё была бы неверной: в меню только текущая и доступные.
          targets={steps.filter((s) => s.movable || s.state === 'now').map((s) => ({ id: s.id, title: s.title, color: s.color, disabled: !s.movable }))}
          onPick={(id) => {
            setMenu(null)
            onMove(id)
          }}
          onClose={(restore) => {
            setMenu(null)
            if (restore) chipRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}

interface PillProps {
  global: GlobalTask
  coordinatorPty?: string
  sessions?: AgentSession[]
  onShow(ptyId: string): void
  onStop(ptyId: string): void
}

/** Пилюля координатора: состояние, модель, запуск, время; «Терминал →» и «■ Остановить» — у живого. */
function CoordinatorPill(props: PillProps): React.JSX.Element {
  // Время живого координатора тикает; у остальных оно фиксировано — таймер не нужен.
  return props.coordinatorPty ? <LivePill {...props} /> : <PillBody {...props} now={0} />
}

function LivePill(props: PillProps): React.JSX.Element {
  return <PillBody {...props} now={useNow(60_000)} />
}

function PillBody({ global, coordinatorPty, sessions, onShow, onStop, now }: PillProps & { now: number }): React.JSX.Element {
  const t = useT()
  const info = coordinatorPill(
    { live: coordinatorPty !== undefined, waiting: global.waiting > 0, sessions, agent: global.coordinatorAgent, ptyId: coordinatorPty },
    now
  )
  const [confirming, setConfirming] = useState(false)
  // Координатор закончился, пока спрашивали, — подтверждать уже нечего.
  useEffect(() => {
    if (!coordinatorPty) setConfirming(false)
  }, [coordinatorPty])

  return (
    <span className={`gt-coord ${info.state}`} role="group" aria-label={t('global.pill.aria')}>
      <span className={`gt-coord-dot ${info.state}`} aria-hidden />
      <span className="gt-coord-text">
        <b>{info.title}</b>
        {info.parts.length > 0 && <span className="muted"> · {info.parts.join(' · ')}</span>}
      </span>
      {coordinatorPty && !confirming && (
        <>
          <button type="button" className="gt-link" onClick={() => onShow(coordinatorPty)}>{t('global.pill.terminal')}</button>
          <button type="button" className="gt-link danger" onClick={() => setConfirming(true)} title={t('global.pill.stopTitle')}>{t('global.pill.stop')}</button>
        </>
      )}
      {coordinatorPty && confirming && (
        <span
          className="gt-stop-confirm"
          role="alertdialog"
          aria-label={t('global.pill.confirmAria')}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            // Esc закрывает подтверждение, а не уводит с экрана: экранный обработчик пропускает обработанные клавиши.
            e.preventDefault()
            setConfirming(false)
          }}
        >
          <span>{t('global.pill.confirm')}</span>
          <button
            type="button"
            className="btn-sm danger-fill"
            autoFocus
            onClick={() => {
              setConfirming(false)
              onStop(coordinatorPty)
            }}
          >
            {t('global.pill.confirmStop')}
          </button>
          <button type="button" className="btn-sm" onClick={() => setConfirming(false)}>{t('global.cancel')}</button>
        </span>
      )}
    </span>
  )
}

/** Меню «⋯»: редкие действия. Закрывается по клику мимо и Esc. */
function MoreMenu({ onRemove }: { onRemove(): void }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <span
      ref={ref}
      className="gt-more"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.preventDefault()
        setOpen(false)
        ref.current?.querySelector<HTMLElement>('.gt-more-btn')?.focus({ preventScroll: true })
      }}
    >
      <button type="button" className="btn-sm gt-quiet gt-more-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('global.header.more')} title={t('global.header.more')} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="gt-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="gt-more-item danger"
            autoFocus
            onClick={() => {
              setOpen(false)
              onRemove()
            }}
          >
            {t('global.header.remove')}
          </button>
        </div>
      )}
    </span>
  )
}
