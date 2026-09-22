// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coordinatorsToClose, COORDINATOR_IDLE_MS, type CoordinatorCloseInput } from './coordinator-close.ts'
import { getAgent } from './agents.ts'
import type { OrcaEvent, Question, Run, Task } from './types.ts'

const T0 = 1_000_000
const IDLE = COORDINATOR_IDLE_MS

const run = (id: string, patch: Partial<Run> = {}): Run => ({
  id,
  objective: 'цель',
  createdAt: T0 - 100_000,
  closedAt: T0,
  coordinatorPtyId: `pty_${id}`,
  coordinatorAgent: 'codex',
  ...patch
})
const task = (id: string, runId: string, status = 'done'): Task =>
  ({ id, runId, status, title: id, spec: '', deps: [], roleId: 'developer', agent: 'claude', createdAt: T0, updatedAt: T0 }) as Task
const runDone = (runId: string, at = T0): OrcaEvent => ({ id: `evt_${runId}`, type: 'run_done', payload: { runId }, createdAt: at })

/** Прогон run_a завершён (рабочая задача и её ревью в done), координатор на codex молчит с момента run_done. */
function input(patch: Partial<CoordinatorCloseInput> = {}): CoordinatorCloseInput {
  return {
    runs: [run('run_a')],
    tasks: [task('work', 'run_a'), task('review', 'run_a')],
    questions: [],
    events: [runDone('run_a')],
    isDone: (s) => s === 'done',
    lingers: (agent) => agent === 'codex',
    lastOutputAt: () => T0 - 1_000,
    now: T0 + IDLE,
    ...patch
  }
}

describe('coordinatorsToClose', () => {
  it('успешный прогон: терминал codex-координатора закрывается после тишины с момента run_done', () => {
    assert.deepEqual(coordinatorsToClose(input()), [{ runId: 'run_a', ptyId: 'pty_run_a' }])
  })

  it('сразу после run_done не закрывает: координатор пишет сводку', () => {
    assert.deepEqual(coordinatorsToClose(input({ now: T0 + IDLE - 1 })), [])
  })

  it('вывод после run_done откладывает закрытие: завершающие действия не обрываются', () => {
    const lastOutputAt = (): number => T0 + 30_000
    assert.deepEqual(coordinatorsToClose(input({ lastOutputAt, now: T0 + 30_000 + IDLE - 1 })), [])
    assert.equal(coordinatorsToClose(input({ lastOutputAt, now: T0 + 30_000 + IDLE })).length, 1)
  })

  it('идущий прогон: ревью не закрыто — run_done не было, терминал не трогаем', () => {
    const r = run('run_a', { closedAt: undefined })
    const tasks = [task('work', 'run_a'), task('review', 'run_a', 'in_progress')]
    assert.deepEqual(coordinatorsToClose(input({ runs: [r], tasks, events: [], now: T0 + 10 * IDLE })), [])
  })

  it('открытый вопрос по задаче прогона — не закрывает', () => {
    const tasks = [task('work', 'run_a'), task('review', 'run_a', 'needs_answer')]
    const questions: Question[] = [{ id: 'q1', taskId: 'review', question: '?', options: [], createdAt: T0 }]
    assert.deepEqual(coordinatorsToClose(input({ tasks, questions })), [])
    // Даже если задача уже в done, неотвеченный вопрос по ней держит терминал.
    assert.deepEqual(coordinatorsToClose(input({ questions })), [])
  })

  it('прогон ожил после run_done (новая задача или возврат из done) — не закрывает', () => {
    assert.deepEqual(coordinatorsToClose(input({ tasks: [task('work', 'run_a'), task('extra', 'run_a', 'ready')] })), [])
  })

  it('прогон закрыт вручную (без run_done) — не закрывает', () => {
    assert.deepEqual(coordinatorsToClose(input({ events: [] })), [])
  })

  it('несколько прогонов: закрывается только завершённый, чужой идущий координатор жив', () => {
    const runs = [run('run_a'), run('run_b', { closedAt: undefined })]
    const tasks = [task('work', 'run_a'), task('other', 'run_b', 'in_progress')]
    assert.deepEqual(coordinatorsToClose(input({ runs, tasks })), [{ runId: 'run_a', ptyId: 'pty_run_a' }])
  })

  it('run_done чужого прогона не закрывает этот', () => {
    const runs = [run('run_b', { closedAt: T0 })]
    const tasks = [task('other', 'run_b')]
    assert.deepEqual(coordinatorsToClose(input({ runs, tasks, events: [runDone('run_a')] })), [])
  })

  it('координатор на агенте, который выходит сам (claude), и старый прогон без агента — не трогает', () => {
    assert.deepEqual(coordinatorsToClose(input({ runs: [run('run_a', { coordinatorAgent: 'claude' })] })), [])
    assert.deepEqual(coordinatorsToClose(input({ runs: [run('run_a', { coordinatorAgent: undefined })] })), [])
  })

  it('PTY уже не жив (вышел сам или закрыт вручную) — нечего закрывать', () => {
    assert.deepEqual(coordinatorsToClose(input({ lastOutputAt: () => undefined })), [])
  })

  it('повторные вызовы и дубли run_done дают тот же результат без побочных эффектов', () => {
    const i = input({ events: [runDone('run_a'), runDone('run_a', T0 + 5)] })
    assert.deepEqual(coordinatorsToClose(i), coordinatorsToClose(i))
    assert.equal(coordinatorsToClose(i).length, 1)
  })
})

describe('lingersAfterAnswer', () => {
  it('codex после финального ответа не выходит; claude — без флага', () => {
    assert.equal(getAgent('codex')?.lingersAfterAnswer, true)
    assert.equal(getAgent('claude')?.lingersAfterAnswer, undefined)
  })
})
