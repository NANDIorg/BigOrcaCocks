// Запуск: pnpm --filter @orca-board/desktop test. Логика раздела «Правила» (about/RulesSection.tsx).
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaApi, RuleFile } from '../../shared/ipc'
import { setLocale } from './i18n'
import { isDirty, isStaleRulesError, pickRule, ruleByName, rulesApi, rulesStaleMessage, RULE_HINTS, RULE_TEMPLATES } from './rules'

const file = (name: RuleFile['name'], exists: boolean, text = ''): RuleFile => ({ name, exists, text, eol: 'lf' })

describe('rulesApi', () => {
  it('без rules в window.orca — ошибка «перезапустите приложение»', () => {
    assert.throws(() => rulesApi(undefined), { message: rulesStaleMessage() })
    assert.throws(() => rulesApi({}), /Перезапустите приложение/)
  })

  it('с rules — отдаёт его', () => {
    const rules: OrcaApi['rules'] = { list: async () => [], save: async (name) => file(name, true) }
    assert.equal(rulesApi({ rules }), rules)
  })

  it('узнаёт ошибку старого main', () => {
    assert.ok(isStaleRulesError("Error invoking remote method 'rules:list': Error: No handler registered for 'rules:list'"))
    assert.ok(!isStaleRulesError("No handler registered for 'docs:list'"))
  })
})

describe('pickRule', () => {
  it('сохранённое имя из белого списка — его', () => {
    assert.equal(pickRule([file('CLAUDE.md', true)], 'AGENTS.md'), 'AGENTS.md')
  })

  it('мусор в localStorage — первый существующий файл, иначе CLAUDE.md', () => {
    assert.equal(pickRule([file('CLAUDE.md', false), file('AGENTS.md', true)], '../x.md'), 'AGENTS.md')
    assert.equal(pickRule([file('CLAUDE.md', false), file('AGENTS.md', false)], null), 'CLAUDE.md')
    assert.equal(pickRule([], null), 'CLAUDE.md')
  })
})

describe('isDirty', () => {
  it('не редактируем — не грязно', () => {
    assert.equal(isDirty(null, 'a'), false)
  })

  it('сравнивает текст без учёта CRLF/LF', () => {
    assert.equal(isDirty('a\nb', 'a\r\nb'), false)
    assert.equal(isDirty('a\nb\n', 'a\nb'), true)
    assert.equal(isDirty('', ''), false)
  })
})

describe('шаблоны', () => {
  it('AGENTS.md отсылает к CLAUDE.md', () => {
    assert.match(RULE_TEMPLATES['AGENTS.md'], /Правила проекта — в CLAUDE\.md, прочитай его/)
  })

  it('CLAUDE.md — каркас с обязательными разделами по порядку', () => {
    const heads = RULE_TEMPLATES['CLAUDE.md'].split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3))
    assert.deepEqual(heads, ['Нельзя', 'Обязательно', 'Стиль кода', 'Проверки перед сдачей', 'Git и ветки'])
  })
})

describe('ruleByName', () => {
  it('файла нет в списке — как отсутствующий', () => {
    assert.deepEqual(ruleByName([], 'AGENTS.md'), file('AGENTS.md', false))
    assert.deepEqual(ruleByName([file('AGENTS.md', true, 'x')], 'AGENTS.md'), file('AGENTS.md', true, 'x'))
  })
})

describe('язык интерфейса', () => {
  afterEach(() => setLocale('ru'))

  it('шаблоны, подписи и ошибка — на текущем языке', () => {
    setLocale('en')
    const heads = RULE_TEMPLATES['CLAUDE.md'].split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3))
    assert.deepEqual(heads, ['Don’t', 'Always', 'Code style', 'Checks before handoff', 'Git and branches'])
    assert.match(RULE_TEMPLATES['AGENTS.md'], /^# Project rules\n/)
    assert.match(RULE_HINTS['CLAUDE.md'], /^Read by Claude Code/)
    assert.throws(() => rulesApi(undefined), /Restart the app/)
  })
})
