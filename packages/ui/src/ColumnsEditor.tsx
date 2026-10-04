import type React from 'react'
import { COLUMN_COLORS, type BoardColumn } from '@orca-board/core'
import { useAutoSave } from './useAutoSave'
import { columnColorTitle } from './boardColumns'
import { useT } from './i18n'

interface Props {
  /** Ключ черновика (id проекта или 'defaults'): при смене черновик переинициализируется. */
  storageKey: string
  /** Начальные колонки (берутся при монтировании и при смене storageKey). */
  columns: BoardColumn[]
  /** Только просмотр: поля и кнопки недоступны. */
  readOnly?: boolean
  onSave(columns: BoardColumn[]): Promise<void>
}

/** Раздел «Колонки» («О проекте» и дефолт для новых проектов): порядок, название, цвет; сохраняется автоматически. */
export function ColumnsEditor({ storageKey, columns: initial, readOnly = false, onSave }: Props): React.JSX.Element {
  const t = useT()
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
      { id: `col_${Date.now().toString(36)}`, title: t('board.columns.newColumn'), color: COLUMN_COLORS[0].value, kind: 'custom' }
    ])
  }

  return (
    <fieldset className="editor" disabled={readOnly}>
      <div className="editor-table columns">
        <div className="editor-head" />
        <div className="editor-head">{t('board.columns.name')}</div>
        <div className="editor-head">{t('board.columns.color')}</div>
        <div className="editor-head">{t('board.columns.kind')}</div>
        <div className="editor-head" />
        {columns.map((c, i) => (
          <div key={c.id} className="editor-row">
            <span className="col-swatch" style={{ background: c.color }} />
            <div>
              <input
                value={c.title}
                placeholder={t('board.columns.namePlaceholder')}
                onChange={(e) => patch(i, { title: e.target.value }, true)}
              />
              <div className="editor-id">{c.id}</div>
            </div>
            <select value={c.color} onChange={(e) => patch(i, { color: e.target.value })}>
              {COLUMN_COLORS.map((col) => (
                <option key={col.value} value={col.value}>{columnColorTitle(col)}</option>
              ))}
              {!COLUMN_COLORS.some((col) => col.value === c.color) && (
                <option value={c.color}>{c.color}</option>
              )}
            </select>
            <span
              className="editor-kind"
              title={c.kind === 'ready' ? t('board.columns.readyTitle') : undefined}
            >
              {c.kind === 'custom' ? t('board.columns.custom') : t('board.columns.system', { kind: c.kind })}
              {c.kind === 'ready' && ` · ${t('board.columns.readyNote')}`}
            </span>
            <div className="editor-btns">
              <button className="btn-sm" title={t('board.columns.up')} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="btn-sm" title={t('board.columns.down')} disabled={i === columns.length - 1} onClick={() => move(i, 1)}>↓</button>
              {c.kind === 'custom' && (
                <button
                  className="btn-sm danger"
                  title={t('board.columns.removeTitle')}
                  onClick={() => update(columns.filter((_, j) => j !== i))}
                >
                  {t('board.remove')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {error && <div className="editor-error">{error}</div>}
      {!readOnly && (
        <div className="editor-actions">
          <button className="btn-sm" onClick={add}>{t('board.columns.add')}</button>
        </div>
      )}
      <p className="editor-hint">
        {t('board.columns.hint')} {t('board.columns.cli')} <code>orca-board task move --status &lt;{t('board.columns.cliId')}&gt;</code>.
      </p>
    </fieldset>
  )
}
