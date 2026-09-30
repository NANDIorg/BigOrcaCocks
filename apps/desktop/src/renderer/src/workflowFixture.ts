import { WORKFLOW_VERSION, legacyDefaultWorkflow, type Role, type Workflow } from '@orca-board/core'

/**
 * Граф для тестов редактора: полный набор нод и портов — работа, ревью, `merge` (слияние ветки глобальной задачи в
 * базовую), «Конфликт мержа» у человека, конец. Дефолтный граф глобальной задачи (`defaultWorkflow`) мержа не содержит,
 * а редактору нужны ноды со всеми видами портов. Только для тестов.
 */
export function graphWithMerge(roles: readonly Pick<Role, 'id'>[]): Workflow {
  const wf = structuredClone(legacyDefaultWorkflow(roles))
  wf.version = WORKFLOW_VERSION
  for (const n of wf.nodes) if (n.type === 'work') n.roleIds = ['developer']
  return wf
}

/**
 * Граф с разветвлением для тестов редактора: старт → «Разветвление» (пути `backend`, `frontend`) → по «Работе» на путь →
 * «Слияние» → конец. Валиден без ошибок; координаты — как у ручной раскладки, `autoLayout` их переставит.
 */
export function graphWithFork(): Workflow {
  return {
    version: WORKFLOW_VERSION,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'split', type: 'fork', x: 200, y: 0, branches: [{ id: 'backend', label: 'Backend' }, { id: 'frontend', label: 'Frontend' }] },
      { id: 'work_be', type: 'work', x: 400, y: 0, roleIds: ['developer'] },
      { id: 'work_fe', type: 'work', x: 400, y: 120, roleIds: ['developer'] },
      { id: 'merge_paths', type: 'join', x: 600, y: 0, forkId: 'split' },
      { id: 'end', type: 'end', x: 800, y: 0 }
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'split' },
      { id: 'e2', from: 'split', outcome: 'backend', to: 'work_be' },
      { id: 'e3', from: 'split', outcome: 'frontend', to: 'work_fe' },
      { id: 'e4', from: 'work_be', outcome: 'next', to: 'merge_paths' },
      { id: 'e5', from: 'work_fe', outcome: 'next', to: 'merge_paths' },
      { id: 'e6', from: 'merge_paths', outcome: 'next', to: 'end' }
    ]
  }
}
