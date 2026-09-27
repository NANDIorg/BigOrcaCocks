import type React from 'react'
import { useState } from 'react'
import type { WfNodeTemplate, WfNodeType } from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import { wfAddableTypes } from './workflowEdit'
import { WF_TYPE_TITLES } from './workflowForm'
import { WF_NODE_HELP } from './workflowHelp'
import { filterTemplates, paletteGroups } from './workflowEditorView'
import type { WfScope } from './workflowNav'
import { templateHint, templateMisfit, templateSummary, type NodeTemplatesHook } from './nodeTemplates'
import { useT } from './i18n'

interface Props {
  scope: WfScope
  /** Только просмотр: кнопки добавления недоступны. */
  readOnly: boolean
  onAdd(type: WfNodeType): void
  /** Библиотека своих нод: группа «Свои ноды». Нет — группы нет. */
  library?: NodeTemplatesHook
  onAddTemplate(template: WfNodeTemplate): void
  /** «Сохранить выбранную ноду»: ведёт к карточке «Своя нода» в инспекторе. Нет — нода не выбрана, кнопка недоступна. */
  onSaveSelected?(): void
}

/** Цвета переходов в подвале палитры: палитра заодно служит легендой холста. */
const EDGE_LEGEND = ['next', 'accept', 'reject', 'opt'] as const

/**
 * Палитра редактора воркфлоу (левая колонка): поиск, типы нод по группам с одной строкой пояснения, «Свои ноды» из
 * библиотеки и легенда цветов переходов. Клик по типу ставит ноду в центр холста — как кнопки прежней панели.
 */
export function WorkflowPalette({ scope, readOnly, onAdd, library, onAddTemplate, onSaveSelected }: Props): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const groups = paletteGroups(wfAddableTypes(scope), query, (type) => [WF_TYPE_TITLES[type], WF_NODE_HELP[type].summary])
  const templates = library?.templates ? filterTemplates(library.templates, query, templateSummary) : null
  const nothing = groups.length === 0 && (!library || (templates !== null && templates.length === 0))

  return (
    <aside className="wf-pal" aria-label={t('config.wf.pal.aria')}>
      <input
        type="search"
        className="wf-pal-search"
        value={query}
        placeholder={t('config.wf.pal.search')}
        aria-label={t('config.wf.pal.search')}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.map((g) => (
        <section key={g.id} className="wf-pal-group" aria-label={t(`config.wf.pal.group.${g.id}`)}>
          <h4 className="wf-pal-head">{t(`config.wf.pal.group.${g.id}`)}</h4>
          {g.types.map((type) => {
            const NodeIcon = WfNodeIcon[type]
            const summary = WF_NODE_HELP[type].summary
            return (
              <button
                key={type}
                type="button"
                className="wf-pal-item"
                disabled={readOnly}
                title={`${t('config.wf.canvas.add', { type: WF_TYPE_TITLES[type] })}. ${summary}`}
                aria-label={t('config.wf.canvas.add', { type: WF_TYPE_TITLES[type] })}
                aria-description={summary}
                onClick={() => onAdd(type)}
              >
                <span className={`wf-pal-icon wf-insp-icon wf-node--${type}`}><NodeIcon /></span>
                <b>{WF_TYPE_TITLES[type]}</b>
                <small>{summary}</small>
              </button>
            )
          })}
        </section>
      ))}

      {library && (
        <section className="wf-pal-group" aria-label={t('config.nodeTpl.paletteAria')}>
          <h4 className="wf-pal-head">
            {t('config.nodeTpl.palette')}
            {library.templates && <span className="wf-pal-n">{library.templates.length}</span>}
          </h4>
          {library.templates === null ? (
            <p className="wf-pal-hint">{library.error ?? t('config.nodeTpl.paletteLoading')}</p>
          ) : library.templates.length === 0 ? (
            <p className="wf-pal-hint">{t('config.nodeTpl.paletteEmpty')}</p>
          ) : (
            templates?.map((tpl) => {
              const NodeIcon = WfNodeIcon[tpl.node.type]
              const misfit = templateMisfit(tpl, scope)
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className="wf-pal-item custom"
                  disabled={readOnly || misfit !== null}
                  title={misfit !== null ? t('config.nodeTpl.misfit', { reason: misfit }) : templateHint(tpl)}
                  aria-label={t('config.nodeTpl.insert', { title: tpl.title })}
                  onClick={() => onAddTemplate(tpl)}
                >
                  <span className={`wf-pal-icon wf-insp-icon wf-node--${tpl.node.type}`}><NodeIcon /></span>
                  <b>{tpl.title}</b>
                  <small>{templateSummary(tpl)}</small>
                </button>
              )
            })
          )}
          {!readOnly && (
            <button
              type="button"
              className="btn-text wf-pal-save"
              disabled={!onSaveSelected}
              title={onSaveSelected ? undefined : t('config.wf.pal.saveSelectedHint')}
              onClick={onSaveSelected}
            >
              <Icon.plus /> {t('config.wf.pal.saveSelected')}
            </button>
          )}
        </section>
      )}

      {nothing && <p className="wf-pal-hint">{t('config.wf.pal.empty')}</p>}

      <div className="wf-pal-foot">
        <p>{t('config.wf.pal.legend')}</p>
        <ul>
          {EDGE_LEGEND.map((kind) => (
            <li key={kind}><i className={`wf-pal-edge wf-edge--${kind}`} aria-hidden />{t(`config.wf.pal.edge.${kind}`)}</li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
