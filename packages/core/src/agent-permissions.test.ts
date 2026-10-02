import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAgent, type AgentInvocation } from './agents.ts'

const invoke = (agent: string, permissionMode: string): AgentInvocation =>
  getAgent(agent)!.invoke('system', 'task', { permissionMode, shell: '/bin/sh' })

describe('режим типа задачи управляет всеми CLI-агентами', () => {
  for (const [mode, approval] of [['auto', 'default'], ['acceptEdits', 'auto_edit'], ['bypassPermissions', 'yolo']]) {
    it(`Gemini: ${mode} передаётся штатным approval-mode`, () => {
      const inv = invoke('gemini', mode)
      assert.deepEqual(inv.args.slice(0, 2), ['--approval-mode', approval])
      assert.equal(inv.env?.GEMINI_SANDBOX, mode === 'bypassPermissions' ? 'false' : undefined)
    })
  }

  for (const [mode, goose] of [['auto', 'approve'], ['acceptEdits', 'smart_approve'], ['bypassPermissions', 'auto']]) {
    it(`Goose: ${mode} задаётся окружением без изменения пользовательского конфига`, () => {
      const inv = invoke('goose', mode)
      assert.equal(inv.env?.GOOSE_MODE, goose)
      assert.equal(inv.args[0], 'run')
      assert.ok(inv.args.includes('--interactive'))
    })
  }

  for (const mode of ['auto', 'acceptEdits', 'bypassPermissions']) {
    it(`OpenCode: ${mode} передаёт правила редактирования и команд`, () => {
      const value = invoke('opencode', mode).env?.OPENCODE_PERMISSION
      assert.ok(value, 'нет правил разрешений OpenCode')
      const policy = JSON.parse(value)
      const full = mode === 'bypassPermissions'
      assert.equal(policy['*'], full ? 'allow' : undefined)
      assert.deepEqual(policy.bash, full ? 'allow' : { '*': 'ask' })
      assert.deepEqual(policy.edit, full ? 'allow' : { '*': mode === 'auto' ? 'ask' : 'allow' })
      assert.equal(policy.read, full ? 'allow' : undefined, 'штатные правила чтения .env не переопределяются')
      assert.deepEqual(policy.external_directory, full ? 'allow' : { '*': 'ask' })
    })

    it(`Copilot: ${mode} управляет инструментами, унаследованный allow-all отключён`, () => {
      const inv = invoke('copilot', mode)
      assert.equal(inv.env?.COPILOT_ALLOW_ALL, 'false')
      assert.equal(inv.args.includes('--allow-all'), mode === 'bypassPermissions')
      assert.equal(inv.args.includes('--allow-tool=write'), mode === 'acceptEdits')
      assert.equal(inv.args.at(-2), '-i')
    })

    it(`Cursor: ${mode} переключает sandbox и force, сохраняя интерактивный запуск`, () => {
      const inv = invoke('cursor', mode)
      assert.equal(inv.args.includes('--force'), mode === 'bypassPermissions')
      assert.deepEqual(inv.args.slice(-3, -1), ['--sandbox', mode === 'bypassPermissions' ? 'disabled' : 'enabled'])
      assert.equal(inv.args.includes('--approve-mcps'), mode === 'bypassPermissions')
      assert.equal(inv.args.includes('--print'), false)
    })

    it(`Amp: ${mode} задаёт настройки отдельного запуска, а не меняет глобальные`, () => {
      const settings = invoke('amp', mode).settingsFile?.overrides
      assert.ok(settings, 'нет настроек разрешений Amp')
      assert.equal(settings['amp.dangerouslyAllowAll'], mode === 'bypassPermissions')
      const rules = settings['amp.permissions'] as { tool: string; action: string }[]
      assert.equal(rules.at(-1)?.tool, '*')
      assert.equal(rules.at(-1)?.action, mode === 'bypassPermissions' ? 'allow' : 'ask')
      if (mode !== 'bypassPermissions') {
        assert.equal(rules.find((r) => r.tool === 'Read')?.action, 'allow')
        for (const tool of ['edit_file', 'create_file', 'apply_patch']) {
          assert.equal(rules.find((r) => r.tool === tool)?.action, mode === 'acceptEdits' ? 'allow' : 'ask')
        }
      }
    })
  }

  it('Shell не получает выдуманные флаги разрешений', () => {
    for (const mode of ['auto', 'acceptEdits', 'bypassPermissions']) {
      assert.deepEqual(invoke('shell', mode), { command: '/bin/sh', args: [] })
    }
  })

  it('Gemini: явный режим человека сохраняется без несовместимого --approval-mode приложения', () => {
    for (const flags of [['--yolo'], ['-y'], ['-dy'], ['-yd'], ['-dsy'], ['--approval-mode', 'plan'], ['--approval-mode=default']]) {
      const inv = getAgent('gemini')!.invoke('system', 'task', { permissionMode: 'auto', shell: 'sh', extraArgs: flags })
      assert.deepEqual(inv.args, [...flags, '-i', 'system\n\n---\n\ntask'])
    }
  })

  it('OpenCode: неизвестный режим превью не разрешает правки автоматически', () => {
    const value = invoke('opencode', '‹permission mode›').env?.OPENCODE_PERMISSION
    assert.ok(value)
    assert.deepEqual(JSON.parse(value).edit, { '*': 'ask' })
  })
})
