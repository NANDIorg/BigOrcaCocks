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
 * Граф глобальной задачи с разветвлением (docs/workflow.md, «Разветвление»): Analysis → fork «Back and front» — путь
 * «Backend» (API impl → API review, возврат на реализацию) и путь «Frontend» (UI impl → Mockup у человека, возврат на
 * реализацию) → join «Assemble» → Human check → конец. Названия нод — как их ввёл человек (не переводятся), латиницей:
 * кириллица вне словарей роняет `noCyrillic.test.ts`. Координаты расставлены, пути — один под другим. Только для тестов.
 */
export function graphWithFork(): Workflow {
  return {
    version: WORKFLOW_VERSION,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 120 },
      { id: 'analysis', type: 'work', title: 'Analysis', x: 200, y: 120 },
      { id: 'split', type: 'fork', title: 'Back and front', x: 400, y: 120, branches: [{ id: 'backend', label: 'Backend' }, { id: 'frontend', label: 'Frontend' }] },
      { id: 'be', type: 'work', title: 'API impl', x: 600, y: 0 },
      { id: 'be_review', type: 'gate', title: 'API review', roleId: 'reviewer', x: 800, y: 0 },
      { id: 'fe', type: 'work', title: 'UI impl', x: 600, y: 240 },
      { id: 'fe_mock', type: 'human', title: 'Mockup', x: 800, y: 240 },
      { id: 'join', type: 'join', title: 'Assemble', forkId: 'split', x: 1000, y: 120 },
      { id: 'human', type: 'human', title: 'Human check', x: 1200, y: 120 },
      { id: 'end', type: 'end', x: 1400, y: 120 }
    ],
    edges: [
      { id: 'e_start', from: 'start', outcome: 'next', to: 'analysis' },
      { id: 'e_an', from: 'analysis', outcome: 'next', to: 'split' },
      { id: 'e_be', from: 'split', outcome: 'backend', to: 'be' },
      { id: 'e_fe', from: 'split', outcome: 'frontend', to: 'fe' },
      { id: 'e_be_rev', from: 'be', outcome: 'next', to: 'be_review' },
      { id: 'e_be_ok', from: 'be_review', outcome: 'accept', to: 'join' },
      { id: 'e_be_back', from: 'be_review', outcome: 'reject', to: 'be' },
      { id: 'e_fe_mock', from: 'fe', outcome: 'next', to: 'fe_mock' },
      { id: 'e_fe_ok', from: 'fe_mock', outcome: 'accept', to: 'join' },
      { id: 'e_fe_back', from: 'fe_mock', outcome: 'reject', to: 'fe' },
      { id: 'e_join', from: 'join', outcome: 'next', to: 'human' },
      { id: 'e_hum_ok', from: 'human', outcome: 'accept', to: 'end' },
      { id: 'e_hum_back', from: 'human', outcome: 'reject', to: 'split' }
    ]
  }
}
