import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ColumnKind, GlobalTask } from '@orca-board/core'
import { Icon } from './icons'
import { GlobalDuration, GlobalProgress, relativeTime } from './GlobalBoard'
import { formatStamp } from './boardSort'
import { PriorityBadge } from './Priority'
import { globalTaskActions } from './globalReview'

interface Props {
  global: GlobalTask
  /** Вид колонки глобального канбана, где сейчас задача (review — «Проверка»). */
  statusKind?: ColumnKind
  /** Живой координатор этой глобальной задачи (ptyId), если есть. */
  coordinatorPty?: string
  /** Название типа задачи (`globalTypeTitle`) — чип рядом с приоритетом; нет — чипа нет. */
  typeTitle?: string
  onBack(): void
  onEdit(): void
  onStartCoordinator(): void
  onShowCoordinator(ptyId: string): void
  /** «Подтвердить» на «Проверке». */
  onAccept(): void
  /** «Вернуть в работу…» на «Проверке» — модалка с уточнением. */
  onReturn(): void
}

/**
 * Шапка экрана глобальной задачи: хлебные крошки, заголовок с действиями, описание и строка меты. Живёт над лентой
 * «Ждут вас» и вкладками на любой вкладке. Итог, сводка и уточнения — не здесь, а на вкладке «Итог и цель»
 * (`GlobalOverview`), чтобы высота шапки не зависела от состояния.
 */
export function GlobalTaskHeader(props: Props): React.JSX.Element {
  const { global, statusKind, coordinatorPty, typeTitle, onBack, onEdit, onStartCoordinator, onShowCoordinator, onAccept, onReturn } = props
  const actions = globalTaskActions(global, statusKind, coordinatorPty !== undefined)
  const [expanded, setExpanded] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)

  // Открыли с клавиатуры/мышью — фокус на «назад», чтобы Enter/Escape сразу вели обратно.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true })
    setExpanded(false)
  }, [global.id])

  const description = global.description.trim()
  const long = description.length > 220 || description.split('\n').length > 3

  return (
    <div className="g-view-head">
      <nav className="g-crumbs" aria-label="Навигация">
        <button ref={backRef} type="button" className="g-back" onClick={onBack} title="К общей доске (Esc)">
          <span aria-hidden>←</span> Глобальные задачи
        </button>
        <span className="g-crumb-sep" aria-hidden>/</span>
        <span className="g-crumb-current" title={global.title}>{global.title}</span>
      </nav>
      <div className="g-view-title-row">
        <h2 className="g-view-title" title={global.title}>{global.title}</h2>
        <div className="g-view-actions">
          <button type="button" className="btn-sm" onClick={onEdit}><Icon.edit /> Изменить</button>
          {actions.accept && (
            <button type="button" className="btn-sm primary" onClick={onAccept} title="Результат принят — в «Сделано»">Подтвердить</button>
          )}
          {actions.returnToWork && (
            <button type="button" className="btn-sm" title="Написать, что доделать, и перезапустить координатора" onClick={onReturn}>
              Вернуть в работу…
            </button>
          )}
          {!global.inbox && coordinatorPty && (
            <button type="button" className="btn-sm" onClick={() => onShowCoordinator(coordinatorPty)}>
              <span className="g-live-dot" aria-hidden /> Координатор работает
            </button>
          )}
          {actions.startCoordinator && (
            <button type="button" className="btn-sm" onClick={onStartCoordinator}><Icon.play /> Запустить координатора</button>
          )}
        </div>
      </div>
      {description && description !== global.title && (
        <div className={`g-view-desc ${long && !expanded ? 'clamped' : ''}`}>{description}</div>
      )}
      {long && (
        <button type="button" className="btn-text g-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
      <div className="g-view-meta">
        <div className="g-view-progress"><GlobalProgress global={global} /></div>
        {/* Правка — в «Изменить» (GlobalTaskModal); здесь только бейдж, normal без него, как на карточке. */}
        <PriorityBadge item={global} className="g-chip" />
        {typeTitle && <span className="g-chip task-type-chip" title="Тип задачи: роли, воркфлоу и правила агентов">{typeTitle}</span>}
        <span className="muted">Обновлено {relativeTime(global.activityAt)}</span>
        {!global.inbox && (
          <span className="muted" title={`Создана ${formatStamp(global.createdAt)}${global.closedAt !== undefined ? `, закрыта ${formatStamp(global.closedAt)}` : ''}`}>
            · <GlobalDuration global={global} variant="line" />
          </span>
        )}
        {global.closedAt !== undefined && <span className="muted">· закрыта</span>}
        {global.inbox && <span className="muted">· сюда попадают задачи без глобальной</span>}
      </div>
      {statusKind === 'review' && <div className="g-review-note">Все подзадачи сделаны — проверьте результат: подтвердите или верните в работу с уточнением.</div>}
    </div>
  )
}
