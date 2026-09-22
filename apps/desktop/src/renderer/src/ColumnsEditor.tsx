import type React from 'react'
import { COLUMN_COLORS, type BoardColumn } from '@orca-board/core'
import { useAutoSave } from './useAutoSave'

interface Props {
  /** Ключ черновика (id проекта или 'defaults'): при смене черновик переинициализируется. */
  storageKey: string
  /** Начальные колонки (берутся при монтировании и при смене storageKey). */
  columns: BoardColumn[]
  onSave(columns: BoardColumn[]): Promise<void>
}

/** Раздел «Колонки» («О проекте» и дефолт для новых проектов): порядок, название, цвет; сохраняется автоматически. */
export function ColumnsEditor({ storageKey, columns: initial, onSave }: Props): React.JSX.Element {
  const { draft: columns, error, update } = useAutoSave<BoardColumn[]>(storageKey, initial, onSave)

  function patch(i: number, p: Partial<BoardColumn>, debounce = false): void {
    update(columns.map((c, j) => (j === i ? { ...c, ...p } : c)), debounce)
  }

  /** Поменять местами колонки i и i+dir. */
  function move(i: number, dir: -1 | 1): void {
    const j = i + dir
    if (j < 0 || j >= columns.length) return
    const next = [...columns]
    ;[next[i], next[j]] = [next[j], next[i]]
    update(next)
  }

  function add(): void {
    update([
      ...columns,
      { id: `col_${Date.now().toString(36)}`, title: 'Новая колонка', color: COLUMN_COLORS[0].value, kind: 'custom' }
    ])
  }

  return (
    <div className="editor">
      <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>Колонки</h3>
      <div className="editor-table columns">
        <div className="editor-head" />
        <div className="editor-head">Название</div>
        <div className="editor-head">Цвет</div>
        <div className="editor-head">Вид</div>
        <div className="editor-head" />
        {columns.map((c, i) => (
          <div key={c.id} className="editor-row">
            <span className="col-swatch" style={{ background: c.color }} />
            <div>
              <input
                value={c.title}
                placeholder="Название колонки"
                onChange={(e) => patch(i, { title: e.target.value }, true)}
              />
              <div className="editor-id">{c.id}</div>
            </div>
            <select value={c.color} onChange={(e) => patch(i, { color: e.target.value })}>
              {COLUMN_COLORS.map((col) => (
                <option key={col.value} value={col.value}>{col.title}</option>
              ))}
              {!COLUMN_COLORS.some((col) => col.value === c.color) && (
                <option value={c.color}>{c.color}</option>
              )}
            </select>
            <span className="editor-kind">{c.kind === 'custom' ? 'своя' : `системная: ${c.kind}`}</span>
            <div className="editor-btns">
              <button className="btn-sm" title="Выше" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="btn-sm" title="Ниже" disabled={i === columns.length - 1} onClick={() => move(i, 1)}>↓</button>
              {c.kind === 'custom' && (
                <button
                  className="btn-sm danger"
                  title="Удалить колонку; её задачи переедут в бэклог"
                  onClick={() => update(columns.filter((_, j) => j !== i))}
                >
                  Удалить
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="editor-actions">
        <button className="btn-sm" onClick={add}>Добавить колонку</button>
      </div>
      <p className="editor-hint">
        Системные колонки нельзя удалить: по ним работает автоматика (ready, in_progress, review, done …).
        Для CLI: <code>orca-board task move --status &lt;id колонки&gt;</code>.
      </p>
    </div>
  )
}
