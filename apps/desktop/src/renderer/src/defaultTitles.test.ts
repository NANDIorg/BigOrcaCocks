// Встроенные названия из core показываются на языке интерфейса, пока их не переименовали; данные не меняются.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GLOBAL_REVIEW_TITLE, INBOX_TITLE, WF_ISSUE_TEXTS, defaultWorkflow, presetTaskTypes,
  resolveTaskType, validateWorkflow, wfNodeTitle, type WfIssueCode
} from '@orca-board/core'
import { RU } from './i18n/dict'
import { setLocale } from './i18n'
import { agentTitle, builtinText, displayColumns, displayRoles, modelTitle, nodeTitle, wfIssueText } from './defaultTitles'

afterEach(() => setLocale('ru'))

/** Все встроенные русские тексты, которые core кладёт в данные. */
function coreTexts(): Set<string> {
  const out = new Set<string>([INBOX_TITLE, GLOBAL_REVIEW_TITLE, 'Оболочка', 'Модель неизвестна', 'Opus (актуальный)', 'Sonnet (актуальный)', 'Haiku (актуальный)', 'Условие по роли'])
  const add = (s?: string): void => { if (s) out.add(s) }
  DEFAULT_COLUMNS.forEach((c) => add(c.title))
  DEFAULT_ROLES.forEach((r) => { add(r.title); add(r.description) })
  for (const type of presetTaskTypes()) {
    add(type.title)
    add(type.description)
    const resolved = resolveTaskType(type)
    resolved.roles.forEach((r) => { add(r.title); add(r.description) })
    resolved.workflow.nodes.forEach((n) => add(wfNodeTitle(n)))
  }
  for (const type of ['start', 'work', 'ask', 'gate', 'human', 'condition', 'merge', 'end'] as const) {
    add(wfNodeTitle({ id: 'x', type, x: 0, y: 0 } as Parameters<typeof wfNodeTitle>[0]))
  }
  return out
}

test('словарь builtin покрывает встроенные тексты core — и только их', () => {
  const core = coreTexts()
  const dict = new Set(Object.values(RU.builtin).filter((v): v is string => typeof v === 'string'))
  // Шаблон суффикса модели и описание перенесённого типа (старый формат настроек) — не из заготовок.
  const extra = ['{name} (по умолчанию)', 'Перенесён из «Настройки → Для новых проектов».']
  // Латиница («QA») не переводится; «<этап>?» — название условия из заготовки, узнаётся по этапу.
  const known = (text: string): boolean => dict.has(text) || (text.endsWith('?') && dict.has(text.slice(0, -1)))
  for (const text of core) if (!/^[\x20-\x7e]+$/.test(text)) assert.ok(known(text), `нет в builtin: ${text}`)
  for (const text of dict) if (!extra.includes(text)) assert.ok(core.has(text), `в core больше нет: ${text}`)
})

test('на английском встроенное переводится, своё — как есть; на русском всё как есть', () => {
  assert.equal(builtinText('Бэклог'), 'Бэклог')
  setLocale('en')
  assert.equal(builtinText('Бэклог'), 'Backlog')
  assert.equal(builtinText('Посмотреть глазами?'), 'Check visually?')
  assert.equal(builtinText('Мои идеи'), 'Мои идеи')
  assert.equal(agentTitle('shell'), 'Shell')
  assert.equal(agentTitle('claude'), 'Claude Code')
  assert.equal(modelTitle('Opus (актуальный)'), 'Opus (latest)')
  assert.equal(modelTitle('gpt-5 (по умолчанию)'), 'gpt-5 (default)')
})

test('колонки и роли для показа: id и вид те же, «Проверка» глобальной доски — Review, нода «Проверка» — Agent check', () => {
  setLocale('en')
  const cols = displayColumns([...DEFAULT_COLUMNS, { id: 'review', title: GLOBAL_REVIEW_TITLE, color: '#000', kind: 'review' as const }])
  assert.deepEqual(cols.map((c) => c.title), ['Backlog', 'Ready', 'In progress', 'Needs input', 'Review', 'Done', 'Review'])
  assert.deepEqual(cols.map((c) => c.id), [...DEFAULT_COLUMNS.map((c) => c.id), 'review'])
  assert.equal(nodeTitle({ id: 'g', type: 'gate', x: 0, y: 0, roleId: 'reviewer' }), 'Agent check')
  const roles = displayRoles(DEFAULT_ROLES)
  assert.equal(roles.find((r) => r.id === 'developer')?.title, 'Developer')
  assert.equal(DEFAULT_ROLES.find((r) => r.id === 'developer')?.title, 'Программист')
})

test('проблемы воркфлоу: ru-словарь совпадает с core, en — по коду с параметрами', () => {
  for (const [code, text] of Object.entries(WF_ISSUE_TEXTS)) {
    assert.equal(RU.config[`wf.issue.${code}` as keyof typeof RU.config], text, code)
  }
  const wf = defaultWorkflow(DEFAULT_ROLES)
  const lost = { id: 'lost', type: 'work' as const, x: 0, y: 0 }
  const issue = validateWorkflow({ ...wf, nodes: [...wf.nodes, lost] }, { roles: DEFAULT_ROLES, nodeTitle }).warnings.find((i) => i.code === 'unreachable')!
  assert.equal(wfIssueText(issue), issue.message)
  setLocale('en')
  const en = validateWorkflow({ ...wf, nodes: [...wf.nodes, lost] }, { roles: DEFAULT_ROLES, nodeTitle }).warnings.find((i) => i.code === 'unreachable')!
  assert.equal(wfIssueText(en), 'node “Work”: unreachable from the start')
  assert.equal(wfIssueText({ message: 'старый core' }), 'старый core')
  const codes: WfIssueCode[] = ['noStart']
  assert.equal(wfIssueText({ code: codes[0], message: 'нет ноды «Старт»' }), 'there is no “Start” node')
})
