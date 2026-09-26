import type { WfNodeType, WfOutcome } from '@orca-board/core'
import { t, type TKey } from './i18n'

// Справка по типам нод воркфлоу для редактора: палитра холста, инспектор выбранной ноды и легенда «Типы нод».
// Тексты — пересказ поведения движка (`packages/core/src/workflow.ts`, эффекты — `apps/desktop/src/main/workflow.ts`)
// и таблицы «Этапы и что делает приложение» в docs/workflow.md: меняется поведение этапа — правь и здесь
// (тексты — в словаре `config.wf.help.*`, i18n/ru и i18n/en).

export interface WfNodeHelp {
  /** Одна фраза: зачем этап. Идёт в подсказку кнопки палитры. */
  summary: string
  /** Кто выполняет этап. */
  actor: string
  /** Что происходит, пока задача на этапе. */
  details: string
  /** Смысл каждого исхода (порта). Набор ключей совпадает с `WF_PORTS` типа — это проверяет тест. */
  outcomes: Partial<Record<WfOutcome, string>>
  /** Какие поля настраиваются в инспекторе и на что влияют. */
  fields: string[]
}

/** Справка типа на текущем языке: ключи словаря `config.wf.help.<тип>.*`. */
function help(type: WfNodeType, outcomes: WfOutcome[], fields: TKey[]): WfNodeHelp {
  const k = (name: string): TKey => `config.wf.help.${type}.${name}` as TKey
  return {
    summary: t(k('summary')),
    actor: t(k('actor')),
    details: t(k('details')),
    outcomes: Object.fromEntries(outcomes.map((o) => [o, t(k(o))])),
    fields: fields.map((f) => t(f))
  }
}

const TITLE: TKey = 'config.wf.help.fieldTitle'

/** Справка по типам нод. Геттеры — чтобы текст шёл на текущем языке интерфейса. */
export const WF_NODE_HELP: Readonly<Record<WfNodeType, WfNodeHelp>> = {
  get start() { return help('start', ['next'], [TITLE]) },
  get work() {
    return help('work', ['next'], [
      'config.wf.help.work.fieldRole', 'config.wf.help.work.fieldInstructions', 'config.wf.help.work.fieldShowcase',
      'config.wf.help.work.fieldRequired', 'config.wf.help.work.fieldColumn'
    ])
  },
  get ask() { return help('ask', ['next'], ['config.wf.help.ask.fieldRole', 'config.wf.help.ask.fieldInstructions']) },
  get gate() {
    return help('gate', ['accept', 'reject'], [
      'config.wf.help.gate.fieldRole', 'config.wf.help.gate.fieldInstructions', 'config.wf.help.gate.fieldColumn'
    ])
  },
  get human() {
    return help('human', ['accept', 'reject'], ['config.wf.help.human.fieldInstructions', 'config.wf.help.human.fieldColumn'])
  },
  get condition() {
    return help('condition', ['yes', 'no'], ['config.wf.help.condition.fieldAttempts'])
  },
  get merge() { return help('merge', ['ok', 'conflict'], [TITLE]) },
  get git() {
    return help('git', ['ok', 'error'], [
      'config.wf.help.git.fieldOperation', 'config.wf.help.git.fieldMessage', 'config.wf.help.git.fieldRemote'
    ])
  },
  get end() { return help('end', [], ['config.wf.help.end.fieldMerged', 'config.wf.help.end.fieldColumn']) }
}
