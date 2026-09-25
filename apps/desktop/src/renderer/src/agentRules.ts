// «Правила доски» типа задачи (settings/TaskTypePane.tsx): блок «Правила проекта» в системном промпте агентов доски.
import { t } from './i18n'

/** Пример в пустом редакторе: типичное правило, которое нужно агентам доски, но не обычным сессиям. */
export function agentRulesPlaceholder(): string {
  return t('config.about.rules.placeholder')
}
