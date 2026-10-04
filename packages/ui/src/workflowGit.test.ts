import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, WF_GIT_OPERATIONS, validateWorkflow, type WfNode } from '@orca-board/core'
import {
  GIT_OPERATIONS, gitFieldsFor, gitNodeSubtitle, gitOperationTitle, gitPlaceholdersHint, gitPreview, isUnavailableGitOperation, patchGit, type WfGitNode
} from './workflowGit'
import { WF_ADDABLE_TYPES, addNode, wfOutcomeLabel } from './workflowEdit'
import { WF_TYPE_ORDER, WF_TYPE_TITLES, changeNodeType, hasColumn, patchNode, portTarget, setPortTarget } from './workflowForm'
import { WF_NODE_HELP } from './workflowHelp'
import { setLocale } from './i18n'
import { graphWithMerge } from './workflowFixture'

const base = graphWithMerge(DEFAULT_ROLES)
const gitNode = (over: Partial<WfGitNode> = {}): WfGitNode => ({ id: 'g', type: 'git', x: 0, y: 0, operation: 'create_branch', branch: '', ...over })
const ctx = { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS }

test('поля формы — только у выбранной операции, обязательные раньше необязательных', () => {
  assert.deepEqual(gitFieldsFor('create_branch'), [{ field: 'branch', required: true }, { field: 'base', required: false }])
  assert.deepEqual(gitFieldsFor('checkout'), [{ field: 'branch', required: true }])
  assert.deepEqual(gitFieldsFor('commit'), [{ field: 'message', required: true }])
  assert.deepEqual(gitFieldsFor('push'), [{ field: 'remote', required: false }])
})

test('select операций: в воркфлоу глобальной задачи только commit и push, create_branch и checkout — недоступны', () => {
  assert.deepEqual([...GIT_OPERATIONS], ['commit', 'push'])
  assert.ok(GIT_OPERATIONS.every((op) => WF_GIT_OPERATIONS.includes(op)))
  assert.ok(isUnavailableGitOperation('create_branch') && isUnavailableGitOperation('checkout'))
  assert.ok(!isUnavailableGitOperation('commit') && !isUnavailableGitOperation('push'))
  assert.ok(!isUnavailableGitOperation('rebase') && !isUnavailableGitOperation(undefined), 'неизвестная — не «недоступная», а сломанная')
})

test('подсказка по подстановкам: у ветки без {title}, у сообщения с ним, у base и remote — нет', () => {
  assert.equal(gitPlaceholdersHint('branch'), 'Подстановки: {taskId}, {slug}')
  assert.equal(gitPlaceholdersHint('message'), 'Подстановки: {taskId}, {slug}, {title}')
  assert.equal(gitPlaceholdersHint('base'), '')
  assert.equal(gitPlaceholdersHint('remote'), '')
})

test('превью имени ветки: подстановки на образцовой задаче, недопустимое имя помечено', () => {
  assert.deepEqual(gitPreview('branch', 'feature/{taskId}-{slug}'), { text: 'feature/task_a1b2c3d4-novaya-forma-vhoda', valid: true })
  assert.equal(gitPreview('branch', 'feat/{slug}.')?.valid, false, 'точка на конце')
  assert.equal(gitPreview('branch', 'my branch')?.valid, false, 'пробел')
  assert.equal(gitPreview('branch', 'feat/{title}')?.valid, false, '{title} в ветке не подставляется — остаётся в имени')
  assert.equal(gitPreview('branch', '  '), null)
  assert.equal(gitPreview('branch', undefined), null)
  assert.deepEqual(gitPreview('message', 'feat: {title}'), { text: 'feat: Новая форма входа', valid: true })
})

test('превью и подписи переводятся на en', () => {
  setLocale('en')
  try {
    assert.equal(gitPreview('message', '{title}')?.text, 'New login form')
    assert.equal(gitPlaceholdersHint('branch'), 'Placeholders: {taskId}, {slug}')
    assert.equal(gitOperationTitle('create_branch'), 'Create branch')
    assert.equal(wfOutcomeLabel('git', 'ok'), 'done')
    for (const op of WF_GIT_OPERATIONS) assert.ok(!/[А-Яа-я]/.test(gitOperationTitle(op)), op)
  } finally {
    setLocale('ru')
  }
  assert.equal(gitOperationTitle('push'), 'Запушить')
})

test('подпись ноды на холсте: операция и главное значение', () => {
  assert.equal(gitNodeSubtitle(gitNode()), 'Создать ветку')
  assert.equal(gitNodeSubtitle(gitNode({ branch: ' feat/{slug} ' })), 'Создать ветку: feat/{slug}')
  assert.equal(gitNodeSubtitle(gitNode({ operation: 'commit', message: 'feat: {title}' })), 'Закоммитить: feat: {title}')
  assert.equal(gitNodeSubtitle(gitNode({ operation: 'push' })), 'Запушить: origin', 'remote по умолчанию')
  assert.equal(gitNodeSubtitle(gitNode({ operation: 'push', remote: 'upstream' })), 'Запушить: upstream')
})

test('patchGit: смена операции убирает поля, которых у новой операции нет', () => {
  let n = patchGit(gitNode(), { branch: 'feat/{slug}', base: 'develop' })
  assert.deepEqual([n.branch, n.base], ['feat/{slug}', 'develop'])
  n = patchGit(n, { operation: 'commit' })
  assert.equal(n.operation, 'commit')
  assert.ok(!('branch' in n) && !('base' in n), 'ветка и база commit не нужны')
  assert.equal(n.message, '', 'обязательное поле новой операции — пустая строка: подсветит валидация')
  n = patchGit(n, { operation: 'push', remote: 'origin' })
  assert.ok(!('message' in n))
  assert.equal(n.remote, 'origin')
  n = patchGit(n, { remote: '  ' })
  assert.ok(!('remote' in n), 'пустое необязательное поле удаляется')
})

test('patchGit: пустая обязательная ветка остаётся строкой, пустая база — удаляется, неизвестная операция игнорируется', () => {
  let n = patchGit(gitNode({ branch: 'a' }), { branch: '', base: '' })
  assert.equal(n.branch, '')
  assert.ok(!('base' in n))
  n = patchGit(n, { operation: 'rebase' as never })
  assert.equal(n.operation, 'create_branch')
})

test('нода с неизвестной или отсутствующей операцией: ничего не бросает, форму можно починить сменой операции', () => {
  const broken: WfGitNode[] = [
    gitNode({ operation: 'rebase' as never, branch: 'x' }),
    { id: 'g', type: 'git', x: 0, y: 0 } as unknown as WfGitNode
  ]
  for (const n of broken) {
    assert.deepEqual(gitFieldsFor(n.operation), [])
    assert.equal(gitNodeSubtitle(n), gitOperationTitle(n.operation))
    assert.doesNotThrow(() => patchGit(n, { branch: 'y' }))
    assert.doesNotThrow(() => patchGit(n, {}))
    const fixed = patchGit(n, { operation: 'commit' })
    assert.equal(fixed.operation, 'commit')
    assert.ok(!('branch' in fixed))
    assert.equal(fixed.message, '')
  }
  assert.equal(gitOperationTitle('rebase'), 'rebase')
  assert.equal(gitOperationTitle(undefined), '?')
  assert.equal(gitNodeSubtitle(broken[0]), 'rebase')
  assert.equal(gitNodeSubtitle(broken[1]), '?')
  assert.ok(!gitNodeSubtitle(broken[0]).includes('config.wf'))
})

test('patchNode: git-поля правятся только у ноды git; исходный граф не меняется', () => {
  const { workflow, nodeId } = addNode(base, 'git', 0, 0)
  const next = patchNode(workflow, nodeId, { git: { message: 'feat: {title}' } })
  const n = next.nodes.find((x) => x.id === nodeId)
  assert.equal(n?.type === 'git' ? n.message : undefined, 'feat: {title}')
  const before = workflow.nodes.find((x) => x.id === nodeId)
  assert.equal(before?.type === 'git' ? before.message : undefined, '')
  const other = patchNode(base, 'work', { git: { branch: 'x' } })
  assert.deepEqual(other.nodes.find((x) => x.id === 'work'), base.nodes.find((x) => x.id === 'work'))
})

test('палитра и select «Тип»: git есть, колонки у него нет, справка описывает поля', () => {
  assert.ok(WF_ADDABLE_TYPES.includes('git') && WF_TYPE_ORDER.includes('git'))
  assert.equal(WF_TYPE_TITLES.git, 'Git')
  assert.equal(hasColumn('git'), false)
  const help = WF_NODE_HELP.git
  assert.deepEqual(Object.keys(help.outcomes).sort(), ['error', 'ok'])
  for (const label of ['Операция', 'Сообщение коммита', 'Remote']) {
    assert.ok(help.fields.some((f) => f.startsWith(`${label} — `)), `нет описания поля «${label}»`)
  }
})

test('нода git: новая — с операцией по умолчанию, выходы ok/error, «выполнено» вместо «слито»', () => {
  const { workflow, nodeId } = addNode(base, 'git', 10, 20)
  const n = workflow.nodes.find((x) => x.id === nodeId) as WfNode
  assert.deepEqual(n, { id: 'git', type: 'git', x: 10, y: 20, operation: 'commit', message: '' })
  assert.equal(wfOutcomeLabel('git', 'ok'), 'выполнено')
  assert.equal(wfOutcomeLabel('merge', 'ok'), 'слито')
  assert.equal(wfOutcomeLabel('git', 'error'), 'ошибка')
})

test('смена типа: из git в другой тип поля git пропадают, рёбра ok/error переезжают только на общие порты', () => {
  const { workflow, nodeId } = addNode(base, 'git', 0, 0)
  let wf = setPortTarget(workflow, nodeId, 'ok', 'end')
  wf = setPortTarget(wf, nodeId, 'error', 'work')
  assert.equal(portTarget(wf, nodeId, 'error'), 'work')
  const asMerge = changeNodeType(wf, nodeId, 'merge')
  assert.equal(portTarget(asMerge, nodeId, 'ok'), 'end', 'ok общий с мержем')
  assert.equal(portTarget(asMerge, nodeId, 'error'), undefined, 'error у мержа нет')
  const back = changeNodeType(asMerge, nodeId, 'git')
  const g = back.nodes.find((x) => x.id === nodeId)
  assert.equal(g?.type === 'git' && g.operation, 'commit')
})

test('валидация ловит пустое сообщение коммита, правка через форму его убирает; создать ветку и переключиться нельзя', () => {
  const { workflow, nodeId } = addNode(base, 'git', 0, 0)
  const wired = setPortTarget(setPortTarget(workflow, nodeId, 'ok', 'end'), nodeId, 'error', 'work')
  const errors = (w: typeof wired): (string | undefined)[] => validateWorkflow(w, ctx).errors.filter((e) => e.nodeId === nodeId).map((e) => e.code)
  assert.deepEqual(errors(wired), ['gitNoMessage'], 'новая нода — commit: ошибка только про пустое сообщение')
  assert.deepEqual(errors(patchNode(wired, nodeId, { git: { message: 'feat: {title}' } })), [])
  assert.ok(errors(patchNode(wired, nodeId, { git: { message: '{nope}' } })).includes('gitUnknownPlaceholder'))
  assert.deepEqual(errors(patchNode(wired, nodeId, { git: { operation: 'push' } })), [], 'push: remote по умолчанию')
  // create_branch и checkout в воркфлоу глобальной задачи запрещены (`gitRunOperation`): граф из файла их сохраняет, форма — нет.
  for (const operation of ['create_branch', 'checkout'] as const) {
    assert.ok(errors(patchNode(wired, nodeId, { git: { operation, branch: 'feature/{taskId}' } })).includes('gitRunOperation'), operation)
  }
})
