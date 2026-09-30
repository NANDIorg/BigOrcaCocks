// Запуск: pnpm --filter @orca-board/desktop test. Директива языка у каждого агента, которого запускает доска.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// worker.ts тянет electron и PTY — проверяем исходник: каждый запуск агента (воркер любого этапа — работа,
// ответ, проверка, «Вопрос человеку», перезапуски; координатор и его повторный запуск; ассистент) строит
// системный промпт через agentSystemPrompt с языком интерфейса на момент запуска.
// CRLF → LF: на Windows git выгружает исходник с `\r\n`, и регулярки по `\n` ниже не находили вызовы.
const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('язык агентов в worker.ts', () => {
  it('все spec.invoke получают agentSystemPrompt с language: mainLocale()', () => {
    const calls = [...source.matchAll(/spec\.invoke\(([^\n]*)/g)].map((m) => m[1])
    assert.equal(calls.length, 3, 'воркер, координатор, ассистент')
    // Ассистент собирает промпт в assistantLaunch (assistant.ts, проверен assistant.test.ts) — язык передаётся туда.
    const own = calls.filter((c) => !c.startsWith('l.system,'))
    assert.equal(own.length, 2, 'воркер, координатор')
    for (const call of own) {
      assert.match(call, /^agentSystemPrompt\(BUILTIN_PROMPTS\.\w+, \{[^}]*language: mainLocale\(\) \}\)/)
    }
    assert.match(source, /assistantLaunch\(ctx\.settings, BUILTIN_PROMPTS\.assistant, mainLocale\(\)\)/)
  })

  it('все spec.invoke получают флаги пользователя (extraArgs)', () => {
    // Вызов целиком: от `spec.invoke(` до первой строки, которая кончается на `})`.
    const calls = [...source.matchAll(/spec\.invoke\((?:[^\n]*\n)*?[^\n]*\}\)\n/g)].map((m) => m[0])
    assert.equal(calls.length, 3, 'воркер, координатор, ассистент')
    for (const call of calls) assert.match(call, /\bextraArgs\b/, call)
    // Воркер и координатор берут флаги роли, ассистент — из настроек приложения (`assistantLaunch`).
    assert.equal([...source.matchAll(/roleLaunchExtraArgs\(role, '(\w+)\.cannotStart'\)/g)].map((m) => m[1]).join(), 'worker,coordinator')
    assert.match(source, /extraArgs: l\.extraArgs/)
  })

  it('флаги роли разбираются до побочных эффектов запуска', () => {
    const at = (text: string): number => {
      const pos = source.indexOf(text)
      assert.ok(pos >= 0, text)
      return pos
    }
    // Негодные флаги координатора — отказ до `createRun`: иначе осталась бы пустая карточка глобальной задачи.
    assert.ok(at("roleLaunchExtraArgs(role, 'coordinator.cannotStart')") < at('store.createRun('))
    // Негодные флаги воркера — до worktree, правки задачи и dispatch.
    const worker = at("roleLaunchExtraArgs(role, 'worker.cannotStart')")
    for (const effect of ['addTaskWorktree(', 'store.updateTask(', 'store.startDispatch(']) assert.ok(worker < at(effect), effect)
  })

  it('системный промпт не собирается в обход директивы', () => {
    assert.doesNotMatch(source, /withAgentRules|withRoleInstructions/)
  })
})
