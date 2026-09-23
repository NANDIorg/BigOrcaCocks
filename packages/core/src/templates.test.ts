// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, SYSTEM_COLUMN_KINDS } from './types.ts'
import { defaultWorkflow, startStage, nextStage, validateWorkflow } from './workflow.ts'
import { BUILTIN_TEMPLATES, GENERAL_TEMPLATE_ID, builtinTemplate, builtinTemplates } from './templates.ts'

const EXPECTED = ['general', 'frontend', 'backend', 'fullstack', 'mobile', 'autotests', 'docs']

describe('встроенные шаблоны проектов', () => {
  it('набор и уникальные id', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id)
    assert.deepEqual(ids, EXPECTED)
    assert.equal(new Set(ids).size, ids.length)
    for (const t of BUILTIN_TEMPLATES) {
      assert.ok(t.title.trim(), `${t.id}: пустое название`)
      assert.equal(t.builtin, true, `${t.id}: не помечен встроенным`)
    }
  })

  for (const t of BUILTIN_TEMPLATES) {
    describe(`«${t.title}»`, () => {
      const roles = t.settings.roles ?? []
      const columns = t.settings.columns ?? DEFAULT_COLUMNS

      it('роли: уникальные id, непустые названия, есть coordinator и assistant из DEFAULT_ROLES', () => {
        const ids = roles.map((r) => r.id)
        assert.equal(new Set(ids).size, ids.length, `повтор id ролей: ${ids.join(', ')}`)
        for (const r of roles) assert.ok(r.title.trim() && r.id.trim(), `пустой id или название у ${r.id}`)
        for (const service of ['coordinator', 'assistant']) {
          const own = roles.find((r) => r.id === service)
          const base = DEFAULT_ROLES.find((r) => r.id === service)!
          assert.ok(own, `нет роли ${service}`)
          assert.equal(own.agent, base.agent)
          assert.equal(own.description, base.description)
        }
        assert.ok(roles.some((r) => r.id !== 'coordinator' && r.id !== 'assistant'), 'нет рабочих ролей')
      })

      it('колонки: каждый системный kind ровно один раз, id уникальны', () => {
        for (const kind of SYSTEM_COLUMN_KINDS) {
          assert.equal(columns.filter((c) => c.kind === kind).length, 1, `kind ${kind}`)
        }
        assert.equal(new Set(columns.map((c) => c.id)).size, columns.length)
      })

      it('воркфлоу проходит validateWorkflow по своим ролям и колонкам', () => {
        const wf = t.settings.workflow ?? defaultWorkflow(roles)
        const v = validateWorkflow(wf, { roles, columns })
        assert.deepEqual(v.errors, [])
        // Возврат в работу без лимита повторов — как у дефолтного графа; других предупреждений быть не должно.
        assert.deepEqual(v.warnings.filter((w) => !w.message.includes('без лимита повторов')), [])
      })
    })
  }

  it('«Общий» — текущий дефолт: DEFAULT_ROLES, DEFAULT_COLUMNS, defaultWorkflow', () => {
    const general = builtinTemplate(GENERAL_TEMPLATE_ID)!
    assert.deepEqual(general.settings.roles, DEFAULT_ROLES)
    assert.deepEqual(general.settings.columns, DEFAULT_COLUMNS)
    assert.deepEqual(general.settings.workflow, defaultWorkflow(DEFAULT_ROLES))
  })

  it('builtinTemplates отдаёт свежие копии: правка не портит встроенные', () => {
    const copy = builtinTemplates()[0]
    copy.settings.roles![0].title = 'испорчено'
    copy.settings.columns![0].title = 'испорчено'
    assert.notEqual(BUILTIN_TEMPLATES[0].settings.roles![0].title, 'испорчено')
    assert.notEqual(DEFAULT_ROLES[0].title, 'испорчено')
    assert.notEqual(DEFAULT_COLUMNS[0].title, 'испорчено')
    assert.equal(builtinTemplate('нет такого'), undefined)
  })

  it('Fullstack: задача frontend после ревью идёт к человеку, backend — сразу в мерж', () => {
    const wf = builtinTemplate('fullstack')!.settings.workflow!
    const afterReview = (roleId: string): string => {
      const ctx = { roleId }
      const work = startStage(wf, ctx)
      const review = nextStage(wf, work.stage, 'next', ctx)
      assert.equal(review.stage.nodeId, 'review')
      return nextStage(wf, review.stage, 'accept', ctx).stage.nodeId
    }
    assert.equal(afterReview('frontend'), 'eyes')
    assert.equal(afterReview('backend'), 'merge')
  })

  it('Бэкенд: после ревью — прогон тестов ролью qa, затем мерж', () => {
    const wf = builtinTemplate('backend')!.settings.workflow!
    const ctx = { roleId: 'developer' }
    const work = startStage(wf, ctx)
    const review = nextStage(wf, work.stage, 'next', ctx)
    const tests = nextStage(wf, review.stage, 'accept', ctx)
    assert.deepEqual(tests.action, { type: 'create_gate', nodeId: 'tests', roleId: 'qa' })
    assert.equal(nextStage(wf, tests.stage, 'accept', ctx).stage.nodeId, 'merge')
    assert.equal(nextStage(wf, tests.stage, 'reject', ctx).stage.nodeId, 'work')
  })

  it('Документация: ревью делает человек, агентного гейта нет', () => {
    const wf = builtinTemplate('docs')!.settings.workflow!
    assert.equal(wf.nodes.some((n) => n.type === 'gate'), false)
    assert.ok(wf.nodes.some((n) => n.type === 'human' && n.id === 'review'))
  })
})
