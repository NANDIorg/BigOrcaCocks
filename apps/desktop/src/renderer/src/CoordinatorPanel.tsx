import type React from 'react'
import type { ColumnKind, GlobalTask } from '@orca-board/core'
import { Icon } from './icons'
import { globalTaskActions } from './globalReview'

export interface CoordinatorPanelProps {
  global: GlobalTask
  /** Вид колонки задачи: на «Проверке» запуск заменён возвратом с уточнением (`globalTaskActions`). */
  statusKind?: ColumnKind
  /** Живой координатор (ptyId) — есть, если он сейчас работает. */
  coordinatorPty?: string
  onStartCoordinator(): void
  /** Открыть терминал живого координатора во вкладке «Терминалы». */
  onShowCoordinator(ptyId: string): void
}

/**
 * Вкладка «Координатор». Пока заглушка: состояние и действия, что уже есть в шапке. Сюда же лягут запуски
 * (`Run.coordinatorSessions` — необязательное поле снапшота: со старым main его нет), хвост вывода и «Остановить».
 * Новые данные — новыми необязательными пропсами, `GlobalTaskView` их пробросит.
 */
export function CoordinatorPanel({ global, statusKind, coordinatorPty, onStartCoordinator, onShowCoordinator }: CoordinatorPanelProps): React.JSX.Element {
  const actions = globalTaskActions(global, statusKind, coordinatorPty !== undefined)
  return (
    <section className="gt-box" aria-label="Координатор">
      <h3>Координатор</h3>
      {global.inbox ? (
        <p className="muted">У «Входящих» нет координатора.</p>
      ) : coordinatorPty ? (
        <div className="gt-actions">
          <span className="gt-coord-state"><span className="g-live-dot" aria-hidden /> Координатор работает</span>
          <button type="button" className="btn-sm" onClick={() => onShowCoordinator(coordinatorPty)}>Открыть терминал</button>
        </div>
      ) : (
        <div className="gt-actions">
          <span className="muted">Координатор не запущен.</span>
          {actions.startCoordinator && (
            <button type="button" className="btn-sm" onClick={onStartCoordinator}><Icon.play /> Запустить координатора</button>
          )}
        </div>
      )}
      <p className="muted gt-stub">Запуски и последний вывод координатора появятся здесь.</p>
    </section>
  )
}
