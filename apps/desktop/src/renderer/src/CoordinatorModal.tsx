import type React from 'react'
import { useState } from 'react'

interface Props {
  onClose(): void
  onStart(objective: string): Promise<void>
}

export function CoordinatorModal({ onClose, onStart }: Props): React.JSX.Element {
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Запустить координатора</h3>
        <p className="muted" style={{ margin: 0 }}>
          Claude Code откроется в корне репозитория с инструкцией координатора. Он разобьёт цель на задачи,
          запустит воркеров и будет ждать событий.
        </p>
        <label>
          Цель
          <textarea
            autoFocus
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Например: добавить экспорт отчёта в PDF, покрыть тестами, обновить README"
          />
        </label>
        <div className="row">
          <button className="btn-text" onClick={onClose}>Отмена</button>
          <button
            className="btn-primary"
            disabled={!objective.trim() || busy}
            onClick={async () => {
              setBusy(true)
              await onStart(objective.trim())
              setBusy(false)
            }}
          >
            Запустить
          </button>
        </div>
      </div>
    </div>
  )
}
