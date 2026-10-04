import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { runPositions } from '@orca-board/core'
import type { EffectProject } from './effect-scope.ts'
import type { EffectJournal, EffectRecord } from './effect-journal.ts'
import { effectPositionMatches } from './effect-journal.ts'
import { GitProcessError, type GitProcessService } from './git-process.ts'

import type { RecoveryWorktree, EffectRecoveryReport } from '@orca-board/contracts'
export type { RecoveryWorktree, EffectRecoveryReport } from '@orca-board/contracts'

/** Только факты: проверка не удаляет branch/worktree, не повторяет команды и не исправляет metadata. */
export async function inspectEffectRecovery(journal: EffectJournal, project: EffectProject, processes: GitProcessService): Promise<EffectRecoveryReport> {
  const { id, root, store } = project
  const records = journal.pending().filter(r => r.position.repoRoot === root && (r.position.projectId === undefined || r.position.projectId === id)).map(record => {
    const p = record.position; const task = p.taskId ? store.getTask(p.taskId) : undefined; const run = p.runId ? store.getRun(p.runId) : undefined
    const position = run ? runPositions(run).find(v => p.laneId === undefined ? !v.lane : v.lane === p.laneId) : undefined
    const current = (!p.taskId || !!task) && (!p.runId || !!run) && effectPositionMatches(p, { repoRoot: root, projectId: id,
      ...(task ? { taskId: task.id, taskCreatedAt: task.createdAt, runId: task.runId, dispatchId: task.dispatchId,
        nodeId: task.stage?.nodeId, visit: task.stage ? task.stage.visits[task.stage.nodeId] ?? 1 : undefined } : {}),
      ...(run ? { runId: run.id, runCreatedAt: run.createdAt } : {}),
      ...(!task && position ? { nodeId: position.nodeId, visit: position.visit, laneId: position.lane,
        forkVisit: run?.lanes?.find(l => l.id === position.lane)?.forkVisit } : {}) })
    return { record, current }
  })
  const referenced = new Set([root, ...store.listTasks().flatMap(t => t.worktree ? [t.worktree] : []), ...store.listRuns().flatMap(r => r.git?.worktree ? [r.git.worktree] : [])])
  for (const path of [...referenced]) {
    try { referenced.add(await realpath(path)) } catch { /* Отсутствующий ресурс остаётся в metadata для сверки. */ }
  }
  let output: string
  try { output = (await processes.run(root, ['worktree', 'list', '--porcelain', '-z'])).stdout }
  catch (error) { if (error instanceof GitProcessError && error.cancelled) throw error; return { records, worktrees: [], gitAvailable: false } }
  const worktrees: RecoveryWorktree[] = []; let worktree: RecoveryWorktree | undefined
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      const path = field.slice('worktree '.length); let canonical = path
      try { canonical = await realpath(path) } catch { /* Отсутствующий worktree сохраняет исходный путь Git. */ }
      worktree = { path, available: existsSync(path), referenced: referenced.has(path) || referenced.has(canonical) }; worktrees.push(worktree)
    } else if (worktree && field.startsWith('HEAD ')) worktree.head = field.slice(5)
    else if (worktree && field.startsWith('branch refs/heads/')) worktree.branch = field.slice('branch refs/heads/'.length)
  }
  for (const wt of worktrees) {
    if (!wt.available) continue
    try { wt.dirty = (await processes.run(wt.path, ['--no-optional-locks', 'status', '--porcelain'])).stdout.trim() !== '' }
    catch (error) { if (error instanceof GitProcessError && error.cancelled) throw error }
  }
  return { records, worktrees, gitAvailable: true }
}
