// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  coordinatorsToClose,
  COORDINATOR_ABANDONED_MS,
  COORDINATOR_FINISH_GRACE_MS,
  type CoordinatorCloseInput
} from './coordinator-close.ts'
import { getAgent } from './agents.ts'
import type { OrcaEvent, Question, Run, Task } from './types.ts'

const T0 = 1_000_000
const GRACE = COORDINATOR_FINISH_GRACE_MS
const ABANDONED = COORDINATOR_ABANDONED_MS
/** Координатор прислал runs finish через 20 с после run_done. */
const FIN = T0 + 20_000

const run = (id: string, patch: Partial<Run> = {}): Run => ({
  id,
  objective: 'цель',
  createdAt: T0 - 100_000,
  closedAt: T0,
  coordinatorPtyId: `pty_${id}`,
  coordinatorAgent: 'codex',
  finishedAt: FIN,
  ...patch
})
const task = (id: string, runId: string, status = 'done'): Task =>
  ({ id, runId, status, title: id, spec: '', deps: [], roleId: 'developer', agent: 'claude', createdAt: T0, updatedAt: T0 }) as Task
const runDone = (runId: string, at = T0): OrcaEvent => ({ id: `evt_${runId}`, type: 'run_done', payload: { runId }, createdAt: at })

/**
 * Прогон run_a завершён (рабочая задача и её ревью в done), координатор на codex дописал сводку,
 * прислал runs finish и молчит с этого момента.
 */
function input(patch: Partial<CoordinatorCloseInput> = {}): CoordinatorCloseInput {
  return {
    runs: [run('run_a')],
    tasks: [task('work', 'run_a'), task('review', 'run_a')],
    questions: [],
    events: [runDone('run_a')],
    isDone: (s) => s === 'done',
    lingers: (agent) => agent === 'codex',
    lastActivityAt: () => FIN - 1_000,
    now: FIN + GRACE,
    ...patch
  }
}

describe('coordinatorsToClose', () => {
  it('успешный прогон: сигнал runs finish + тишина — терминал codex-координатора закрывается', () => {
    assert.deepEqual(coordinatorsToClose(input()), [{ runId: 'run_a', ptyId: 'pty_run_a' }])
  })

  it('сразу после сигнала не закрывает: агент дорисовывает финальный ответ', () => {
    assert.deepEqual(coordinatorsToClose(input({ now: FIN + GRACE - 1 })), [])
  })

  it('run_done есть, сигнала нет — тишина не повод закрывать (ждёт подтверждения команды, пишет сводку)', () => {
    const runs = [run('run_a', { finishedAt: undefined })]
    const lastActivityAt = (): number => T0
    // Много больше прежних 45 с и grace — всё равно не закрываем.
    assert.deepEqual(coordinatorsToClose(input({ runs, lastActivityAt, now: T0 + 10 * 60_000 })), [])
    assert.deepEqual(coordinatorsToClose(input({ runs, lastActivityAt, now: T0 + ABANDONED - 1 })), [])
  })

  it('страховка без сигнала: закрывает только после долгой неактивности с run_done', () => {
    const runs = [run('run_a', { finishedAt: undefined })]
    assert.equal(coordinatorsToClose(input({ runs, lastActivityAt: () => T0 - 1, now: T0 + ABANDONED })).length, 1)
    // Активность после run_done сдвигает страховку.
    const lastActivityAt = (): number => T0 + 60_000
    assert.deepEqual(coordinatorsToClose(input({ runs, lastActivityAt, now: T0 + ABANDONED })), [])
    assert.equal(coordinatorsToClose(input({ runs, lastActivityAt, now: T0 + 60_000 + ABANDONED })).length, 1)
  })

  it('сигнал раньше run_done (старый, не по этому завершению) не считается', () => {
    const runs = [run('run_a', { finishedAt: T0 - 1 })]
    assert.deepEqual(coordinatorsToClose(input({ runs, lastActivityAt: () => T0, now: T0 + 10 * GRACE })), [])
  })

  it('ввод человека после сигнала откладывает закрытие: он продолжил диалог', () => {
    const typed = FIN + 60_000
    const lastActivityAt = (): number => typed
    assert.deepEqual(coordinatorsToClose(input({ lastActivityAt, now: typed + GRACE - 1 })), [])
    assert.equal(coordinatorsToClose(input({ lastActivityAt, now: typed + GRACE })).length, 1)
  })

  it('идущий прогон: ревью не закрыто — run_done не было, терминал не трогаем', () => {
    const r = run('run_a', { closedAt: undefined, finishedAt: undefined })
    const tasks = [task('work', 'run_a'), task('review', 'run_a', 'in_progress')]
    assert.deepEqual(coordinatorsToClose(input({ runs: [r], tasks, events: [], now: T0 + 2 * ABANDONED })), [])
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

  it('прогон закрыт вручную (без run_done) — не закрывает, даже спустя долгое время', () => {
    assert.deepEqual(coordinatorsToClose(input({ events: [], now: T0 + 2 * ABANDONED })), [])
  })

  it('несколько прогонов: закрывается только завершённый, чужой идущий координатор жив', () => {
    const runs = [run('run_a'), run('run_b', { closedAt: undefined, finishedAt: undefined })]
    const tasks = [task('work', 'run_a'), task('other', 'run_b', 'in_progress')]
    assert.deepEqual(coordinatorsToClose(input({ runs, tasks })), [{ runId: 'run_a', ptyId: 'pty_run_a' }])
  })

  it('run_done чужого прогона не закрывает этот', () => {
    const runs = [run('run_b', { closedAt: T0 })]
    const tasks = [task('other', 'run_b')]
    assert.deepEqual(coordinatorsToClose(input({ runs, tasks, events: [runDone('run_a')] })), [])
  })

  it('сигнал runs finish закрывает терминал любого агента (claude, старый прогон без агента)', () => {
    assert.equal(coordinatorsToClose(input({ runs: [run('run_a', { coordinatorAgent: 'claude' })] })).length, 1)
    assert.equal(coordinatorsToClose(input({ runs: [run('run_a', { coordinatorAgent: undefined })] })).length, 1)
  })

  it('без сигнала страховка только для «незакрывающегося» агента: claude не трогает', () => {
    const runs = [run('run_a', { coordinatorAgent: 'claude', finishedAt: undefined })]
    assert.deepEqual(coordinatorsToClose(input({ runs, lastActivityAt: () => T0, now: T0 + 2 * ABANDONED })), [])
  })

  it('PTY уже не жив (вышел сам или закрыт вручную) — нечего закрывать', () => {
    assert.deepEqual(coordinatorsToClose(input({ lastActivityAt: () => undefined })), [])
  })

  it('повторные вызовы и дубли run_done дают тот же результат без побочных эффектов', () => {
    const i = input({ events: [runDone('run_a'), runDone('run_a', T0 + 5)] })
    assert.deepEqual(coordinatorsToClose(i), coordinatorsToClose(i))
    assert.equal(coordinatorsToClose(i).length, 1)
  })

  it('переоткрытый прогон (повторный координатор): считается последний run_done, а не первый', () => {
    const R2 = FIN + ABANDONED
    // Второй координатор: новый run_done R2, сигнала runs finish ещё нет — рано закрывать по старому run_done.
    const events = [runDone('run_a', T0 - ABANDONED), { ...runDone('run_a', R2), id: 'evt_2' }]
    const runs = [run('run_a', { finishedAt: undefined, closedAt: R2 })]
    const lastActivityAt = (): number => T0
    assert.deepEqual(coordinatorsToClose(input({ runs, events, lastActivityAt, now: R2 + GRACE })), [])
    assert.deepEqual(coordinatorsToClose(input({ runs, events, lastActivityAt, now: R2 + ABANDONED })), [{ runId: 'run_a', ptyId: 'pty_run_a' }])
  })
})

describe('lingersAfterAnswer', () => {
  it('codex после финального ответа не выходит; claude — без флага', () => {
    assert.equal(getAgent('codex')?.lingersAfterAnswer, true)
    assert.equal(getAgent('claude')?.lingersAfterAnswer, undefined)
  })
})

describe('coordinatorsToClose: глобальная задача перенесена в «Сделано» вручную', () => {
  const manualDone = (runId: string, at = T0): OrcaEvent => ({ ...runDone(runId, at), payload: { runId, manual: true } })
  /** Подзадачи не закрыты, координатор (claude) сигнала не прислал и молчит с run_done. */
  const manual = (patch: Partial<CoordinatorCloseInput> = {}): CoordinatorCloseInput =>
    input({
      runs: [run('run_a', { coordinatorAgent: 'claude', finishedAt: undefined })],
      tasks: [task('work', 'run_a', 'in_progress')],
      questions: [{ id: 'q1', taskId: 'work', question: '?', options: [], createdAt: T0 }],
      events: [manualDone('run_a')],
      lastActivityAt: () => T0 - 1,
      now: T0 + GRACE,
      ...patch
    })

  it('закрывает терминал любого агента после короткой тишины, даже без runs finish и с открытыми подзадачами', () => {
    assert.deepEqual(coordinatorsToClose(manual()), [{ runId: 'run_a', ptyId: 'pty_run_a' }])
    assert.deepEqual(coordinatorsToClose(manual({ now: T0 + GRACE - 1 })), [])
  })

  it('координатор реагирует на run_done (пишет сводку) — закрытие ждёт тишины после активности', () => {
    const lastActivityAt = (): number => T0 + 30_000
    assert.deepEqual(coordinatorsToClose(manual({ lastActivityAt, now: T0 + 30_000 + GRACE - 1 })), [])
    assert.equal(coordinatorsToClose(manual({ lastActivityAt, now: T0 + 30_000 + GRACE })).length, 1)
  })

  it('глобальную задачу вернули из done (прогон открыт) — не закрывает', () => {
    assert.deepEqual(coordinatorsToClose(manual({ runs: [run('run_a', { closedAt: undefined, finishedAt: undefined })] })), [])
  })

  it('PTY координатора уже не жив — нечего закрывать', () => {
    assert.deepEqual(coordinatorsToClose(manual({ lastActivityAt: () => undefined })), [])
  })
})
