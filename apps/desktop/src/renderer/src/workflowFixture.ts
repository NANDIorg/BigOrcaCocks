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
