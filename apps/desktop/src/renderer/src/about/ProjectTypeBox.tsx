import type React from 'react'
import type { TemplateSection } from '@orca-board/core'
import type { ProjectBase, TemplateDiffRow } from '../projectType'

interface Props {
  /** null — шаблоны ещё грузятся или не загрузились (error). */
  base: ProjectBase | null
  rows: TemplateDiffRow[]
  error: string | null
  onChangeType(): void
  /** «Взять из шаблона» раздел целиком или одну роль. */
  onTake(section: TemplateSection, roleId?: string): void
  onSaveAsTemplate(): void
}

/**
 * «Тип проекта» в «Обзоре»: шаблон проекта, отличия от него по разделам и выборочное применение.
 * Живой связи с шаблоном нет — ничего не меняется без клика, последствия показывает диалог.
 */
export function ProjectTypeBox({ base, rows, error, onChangeType, onTake, onSaveAsTemplate }: Props): React.JSX.Element {
  const same = base !== null && rows.length === 0
  return (
    <div className="about-box">
      <h3>Тип проекта</h3>
      <div className="row-act">
        <div className="row-act-text">
          <b>
            {base
              ? base.own ? `Тип: ${base.template.title}` : 'Тип: не задан'
              : error ? 'Не удалось загрузить шаблоны' : 'Загрузка…'}
          </b>
          <span className="hint">
            {base?.note ?? base?.template.description ??
              'Проект получил копию шаблона при добавлении; правки шаблона сами до проекта не доходят.'}
          </span>
        </div>
        <button className="btn-sm" disabled={!base} onClick={onChangeType}>Сменить тип…</button>
        <button className="btn-sm" disabled={!base} onClick={onSaveAsTemplate}>Сохранить как шаблон…</button>
      </div>

      {base && (
        <div className="type-diff">
          {same ? (
            <p className="hint">Совпадает с шаблоном «{base.template.title}».</p>
          ) : (
            <>
              <p className="hint">Отличается от шаблона «{base.template.title}»:</p>
              <ul className="type-diff-list">
                {rows.map((row) => (
                  <li key={row.section}>
                    <div className="type-diff-row">
                      <span className="type-diff-line">{row.line}</span>
                      <button className="btn-sm" onClick={() => onTake(row.section)}>Взять из шаблона</button>
                    </div>
                    {row.roles && row.roles.length > 0 && (
                      <ul className="type-diff-roles">
                        {row.roles.map((r) => (
                          <li key={r.id} className="type-diff-row">
                            <span className="type-diff-line">
                              «{r.title}» <span className="muted">— {r.hint}</span>
                            </span>
                            <button className="btn-sm" onClick={() => onTake('roles', r.id)}>Взять роль</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {error && <div className="editor-error">{error}</div>}
    </div>
  )
}
