import type React from 'react'
import type { GlobalTask } from '@orca-board/core'

export interface GlobalHistoryProps {
  global: GlobalTask
}

/**
 * Вкладка «История». Пока заглушка. Сюда придёт лента событий из `statusHistory`, `returns`, `summary`
 * и запусков координатора — всё необязательные поля снапшота (со старым main их может не быть).
 */
export function GlobalHistory({ global }: GlobalHistoryProps): React.JSX.Element {
  return (
    <section className="gt-box" aria-label="История">
      <h3>История</h3>
      <p className="muted gt-stub">
        Лента событий задачи появится здесь.
        {global.statusHistory?.length ? ` Смен статуса пока записано: ${global.statusHistory.length}.` : ''}
      </p>
    </section>
  )
}
