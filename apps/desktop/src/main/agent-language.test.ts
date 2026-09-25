// Запуск: pnpm --filter @orca-board/desktop test. Директива языка у каждого агента, которого запускает доска.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// worker.ts тянет electron и PTY — проверяем исходник: каждый запуск агента (воркер любого этапа — работа,
// ответ, проверка, «Вопрос человеку», перезапуски; координатор и его повторный запуск; ассистент) строит
// системный промпт через agentSystemPrompt с языком интерфейса на момент запуска.
const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8')

describe('язык агентов в worker.ts', () => {
  it('все spec.invoke получают agentSystemPrompt с language: mainLocale()', () => {
    const calls = [...source.matchAll(/spec\.invoke\(([^\n]*)/g)].map((m) => m[1])
    assert.equal(calls.length, 3, 'воркер, координатор, ассистент')
    for (const call of calls) {
      assert.match(call, /^agentSystemPrompt\(BUILTIN_PROMPTS\.\w+, \{[^}]*language: mainLocale\(\) \}\)/)
    }
  })

  it('системный промпт не собирается в обход директивы', () => {
    assert.doesNotMatch(source, /withAgentRules|withRoleInstructions/)
  })
})
