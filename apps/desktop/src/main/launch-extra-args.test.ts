// Запуск: pnpm --filter @orca-board/desktop test. Флаги пользователя к команде запуска агента (`Role.extraArgs`) в main:
// разбор перед запуском и текст ошибки на языке интерфейса (`launch-extra-args.ts`), сохранение и загрузка роли с
// флагами в ProjectManager (`validateRoles`, `loadedRoles`). Сам разбор строки — packages/core/src/launch-args.test.ts;
// ассистент — assistant-settings.test.ts, сокет — socket-settings.test.ts.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AGENT_IDS, DEFAULT_COLUMNS, DEFAULT_ROLES, EXTRA_ARGS_MAX_LENGTH, GENERAL_TASK_TYPE_ID, getAgent, type Role, type TaskType } from '@orca-board/core'
import { OrcaError, ipcError, setMainLocale } from './i18n'
import { agentInfos } from './agents'
import { ProjectManager } from './projects'
import { PROJECTS_FILE_VERSION } from './task-types-migration'
import { extraArgsProblem, launchExtraArgs, roleLaunchExtraArgs, withoutExtraArgs } from './launch-extra-args'

afterEach(() => setMainLocale('ru'))

/** Ошибка, брошенная fn, — `OrcaError`; ничего не бросила — тест падает. */
function thrown(fn: () => unknown): OrcaError {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof OrcaError, String(e))
    return e
  }
  return assert.fail('ошибки нет')
}

describe('launchExtraArgs: разбор перед запуском', () => {
  const wrap = (reason: { key: string }): { key: 'assistant.extraArgsInvalid'; params: { reason: never } } =>
    ({ key: 'assistant.extraArgsInvalid', params: { reason: reason as never } })

  it('нет поля, пусто, одни пробелы — флагов нет', () => {
    assert.deepEqual(launchExtraArgs(undefined, wrap), [])
    assert.deepEqual(launchExtraArgs('', wrap), [])
    assert.deepEqual(launchExtraArgs('  \n\t ', wrap), [])
  })

  it('строка разбирается в argv без shell: кавычки, Windows-путь, метасимволы буквально', () => {
    assert.deepEqual(
      launchExtraArgs('--add-dir "C:\\Users\\me\\my repo" --mcp-config=\'a b.json\'\n-s workspace-write --name $HOME;ls', wrap),
      ['--add-dir', 'C:\\Users\\me\\my repo', '--mcp-config=a b.json', '-s', 'workspace-write', '--name', '$HOME;ls']
    )
  })

  it('флаги доходят до argv агента перед флагами приложения и промптом', () => {
    const extraArgs = launchExtraArgs('--verbose --add-dir "../other repo"', wrap)
    const inv = getAgent('claude')!.invoke('SYSTEM', 'PROMPT', { permissionMode: 'auto', shell: '/bin/sh', model: 'opus', extraArgs })
    assert.deepEqual(inv.args.slice(0, 4), ['--verbose', '--add-dir', '../other repo', '--permission-mode'])
    assert.equal(inv.args.at(-1), 'PROMPT')
  })

  it('каждая причина отказа — OrcaError с читаемым текстом', () => {
    const cases: Array<[string, RegExp]> = [
      ['--name "abc', /незакрытая кавычка "/],
      ['--verbose -- rest', /токен «--» недопустим/],
      ['exec --full-auto', /первым должен идти флаг.*«exec»/],
      ['--a \u0000', /управляющий символ U\+0000/],
      [`--a ${'x'.repeat(EXTRA_ARGS_MAX_LENGTH)}`, new RegExp(`слишком длинная: ${EXTRA_ARGS_MAX_LENGTH + 4} символов при максимуме ${EXTRA_ARGS_MAX_LENGTH}`)],
      [Array.from({ length: 65 }, () => '-a').join(' '), /слишком много аргументов: 65 при максимуме 64/]
    ]
    for (const [text, re] of cases) {
      const e = thrown(() => launchExtraArgs(text, wrap))
      assert.equal(e.key, 'assistant.extraArgsInvalid')
      assert.match(e.message, re)
      assert.match(e.message, /^ассистент: флаги запуска: /)
    }
  })

  it('длинный чужой токен в тексте ошибки обрезается', () => {
    const e = thrown(() => launchExtraArgs('x'.repeat(500), wrap))
    assert.ok(e.message.length < 200, e.message)
    assert.match(e.message, /«x{40}…»/)
  })

  it('не строка (правленный руками файл или снимок типа) — ошибка, а не падение', () => {
    assert.match(thrown(() => launchExtraArgs(['--a'] as unknown as string, wrap)).message, /первым должен идти флаг/)
  })

  it('extraArgsProblem: годная строка — undefined, негодная — причина', () => {
    assert.equal(extraArgsProblem('--verbose'), undefined)
    assert.equal(extraArgsProblem('  '), undefined)
    assert.equal(extraArgsProblem('claude --verbose')?.key, 'extraArgs.notFlag')
  })
})

describe('roleLaunchExtraArgs: воркер и координатор', () => {
  const role = { id: 'developer', extraArgs: '--name "abc' }

  it('негодные флаги — «не запустится» с ролью и причиной; message по-русски при любом языке', () => {
    setMainLocale('en')
    const worker = thrown(() => roleLaunchExtraArgs(role, 'worker.cannotStart'))
    assert.equal(worker.key, 'worker.cannotStart')
    assert.equal(worker.message, 'воркер не запустится: роль «developer»: флаги запуска: незакрытая кавычка "')
    const coordinator = thrown(() => roleLaunchExtraArgs({ ...role, id: 'coordinator' }, 'coordinator.cannotStart'))
    assert.equal(coordinator.message, 'координатор не запустится: роль «coordinator»: флаги запуска: незакрытая кавычка "')
  })

  it('в renderer ошибка уходит на языке интерфейса, с кодом', () => {
    setMainLocale('en')
    const e = ipcError(thrown(() => roleLaunchExtraArgs(role, 'coordinator.cannotStart'))) as Error
    assert.equal(e.name, 'OrcaError[coordinator.cannotStart]')
    assert.equal(e.message, 'the coordinator will not start: role “developer”: launch flags: unclosed quote "')
  })

  it('годные флаги и роль без флагов', () => {
    assert.deepEqual(roleLaunchExtraArgs({ id: 'developer', extraArgs: ' --search ' }, 'worker.cannotStart'), ['--search'])
    assert.deepEqual(roleLaunchExtraArgs({ id: 'developer' }, 'worker.cannotStart'), [])
  })
})

describe('agentInfos: признак для renderer', () => {
  it('каждый агент отдаётся с supportsExtraArgs — и установленный, и нет, и выключенный в проекте', () => {
    const infos = agentInfos([])
    assert.deepEqual(infos.map((a) => a.id), AGENT_IDS)
    assert.ok(infos.every((a) => a.supportsExtraArgs === true))
  })
})

describe('withoutExtraArgs: ответы сокета', () => {
  it('поле вырезается на любой глубине, остальное не задето', () => {
    const result = {
      roles: [{ id: 'developer', agent: 'claude', extraArgs: '--mcp-config secret.json' }],
      assistant: { agent: 'codex', extraArgs: '--search' },
      runs: [{ id: 'run_1', taskType: { roles: [{ id: 'qa', extraArgs: '-c x=1' }] } }],
      text: 'extraArgs в тексте остаётся'
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result, withoutExtraArgs)), {
      roles: [{ id: 'developer', agent: 'claude' }],
      assistant: { agent: 'codex' },
      runs: [{ id: 'run_1', taskType: { roles: [{ id: 'qa' }] } }],
      text: 'extraArgs в тексте остаётся'
    })
  })
})

describe('ProjectManager: роль с флагами запуска', () => {
  const PID = 'p1'
  const FLAGS = '  --add-dir "../other repo"\n--verbose '
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-extra-args-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const file = (): string => path.join(tmp, 'projects.json')
  function writeConfig(taskTypes?: unknown[]): void {
    writeFileSync(file(), JSON.stringify({
      version: PROJECTS_FILE_VERSION,
      projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', columns: DEFAULT_COLUMNS }],
      activeId: PID,
      ...(taskTypes ? { taskTypesSeeded: true, taskTypes } : {})
    }))
  }
  const savedRoles = (typeId: string): Role[] =>
    (JSON.parse(readFileSync(file(), 'utf8')) as { taskTypes: TaskType[] }).taskTypes.find((t) => t.id === typeId)!.settings.roles!
  const withFlags = (extraArgs: unknown): Role[] =>
    DEFAULT_ROLES.map((r) => (r.id === 'developer' ? ({ ...r, extraArgs } as Role) : r))
  const developer = (pm: ProjectManager, typeId = GENERAL_TASK_TYPE_ID): Role =>
    (pm.taskType(typeId)!.settings.roles ?? DEFAULT_ROLES).find((r) => r.id === 'developer')!

  it('сохраняются как введены (без trim), переживают перезапуск и доходят до ролей прогона', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags(FLAGS) })
    assert.equal(developer(pm).extraArgs, FLAGS)
    assert.equal(savedRoles(GENERAL_TASK_TYPE_ID).find((r) => r.id === 'developer')?.extraArgs, FLAGS)

    const again = new ProjectManager(tmp)
    assert.equal(developer(again).extraArgs, FLAGS, 'рестарт: флаги на месте')
    assert.equal(again.resolveRun(PID, undefined).roles.find((r) => r.id === 'developer')?.extraArgs, FLAGS)
    assert.equal(again.runType(PID, GENERAL_TASK_TYPE_ID).snapshot.roles.find((r) => r.id === 'developer')?.extraArgs, FLAGS, 'снимок типа несёт флаги')
    assert.deepEqual(roleLaunchExtraArgs(developer(again), 'worker.cannotStart'), ['--add-dir', '../other repo', '--verbose'])
  })

  it('пустая строка и одни пробелы — поля нет; у остальных ролей поле не появляется', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('--verbose') })
    pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags(' \n ') })
    assert.equal('extraArgs' in developer(pm), false)
    for (const r of savedRoles(GENERAL_TASK_TYPE_ID)) assert.equal('extraArgs' in r, false, r.id)
  })

  it('projects.json без поля грузится как раньше и не меняется', () => {
    const roles = DEFAULT_ROLES.map((r) => ({ id: r.id, title: r.title, agent: r.agent }))
    writeConfig([{ id: GENERAL_TASK_TYPE_ID, title: 'Общий', settings: { roles } }])
    const pm = new ProjectManager(tmp)
    for (const r of pm.taskType(GENERAL_TASK_TYPE_ID)!.settings.roles!) assert.equal('extraArgs' in r, false, r.id)
    assert.deepEqual(roleLaunchExtraArgs(developer(pm), 'worker.cannotStart'), [])
  })

  it('невалидная строка при сохранении отвергается, прежние флаги остаются', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('--verbose') })
    const before = readFileSync(file(), 'utf8')
    assert.throws(() => pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('--name "abc') }), /роль «developer»: флаги запуска: незакрытая кавычка "/)
    assert.throws(() => pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('codex exec') }), /роль «developer»: флаги запуска: первым должен идти флаг/)
    assert.throws(() => pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('-a -- b') }), /токен «--» недопустим/)
    assert.throws(() => pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags(['--a']) }), /роль «developer»: флаги запуска должны быть строкой/)
    assert.throws(() => pm.saveTaskType({ title: 'Новый', settings: { roles: withFlags('x') } }), /флаги запуска/)
    assert.equal(developer(pm).extraArgs, '--verbose')
    assert.equal(readFileSync(file(), 'utf8'), before, 'файл не изменился')
  })

  it('ошибка сохранения в renderer — на языке интерфейса', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    setMainLocale('en')
    const e = ipcError(thrown(() => pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('codex exec') }))) as Error
    assert.equal(e.name, 'OrcaError[role.extraArgsInvalid]')
    assert.equal(e.message, 'role “developer”: launch flags: the first item must be a flag (starting with “-”), not “codex”: only flags can be added, not a command')
  })

  it('испорченные флаги в файле: роль остаётся со всеми полями, пропадает только extraArgs', () => {
    const roles = [
      { id: 'coordinator', title: 'Координатор', agent: 'claude', extraArgs: 5 },
      { id: 'developer', title: 'Сеньор', agent: 'codex', model: 'gpt', systemPrompt: 'Пиши тесты', extraArgs: '--name "abc' },
      { id: 'qa', title: 'QA', agent: 'claude', extraArgs: '--verbose' }
    ]
    writeConfig([{ id: GENERAL_TASK_TYPE_ID, title: 'Общий', settings: { roles } }])
    const pm = new ProjectManager(tmp)
    const loaded = pm.taskType(GENERAL_TASK_TYPE_ID)!.settings.roles!
    assert.deepEqual(loaded.map((r) => r.id), ['coordinator', 'developer', 'qa'], 'ни одна роль не пропала')
    assert.deepEqual(loaded[1], { ...DEFAULT_ROLES.find((r) => r.id === 'developer'), title: 'Сеньор', agent: 'codex', model: 'gpt', systemPrompt: 'Пиши тесты' })
    assert.equal('extraArgs' in loaded[0], false)
    assert.equal(loaded[2].extraArgs, '--verbose', 'годные флаги соседней роли на месте')
  })

  it('испорченные флаги рядом с действительно битой ролью: битая выпадает, остальные — нет', () => {
    const roles = [
      { id: 'developer', title: 'Программист', agent: 'claude', extraArgs: 'not-a-flag' },
      { id: 'broken', title: '', agent: 'claude' },
      { id: 'qa', title: 'QA', agent: 'claude', extraArgs: '-p' }
    ]
    writeConfig([{ id: GENERAL_TASK_TYPE_ID, title: 'Общий', settings: { roles } }])
    const loaded = new ProjectManager(tmp).taskType(GENERAL_TASK_TYPE_ID)!.settings.roles!
    assert.deepEqual(loaded.map((r) => [r.id, r.extraArgs]), [['developer', undefined], ['qa', '-p']])
  })

  it('дублирование типа и правка промпта роли флаги не теряют', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags(FLAGS) })
    pm.saveTaskTypeRules(GENERAL_TASK_TYPE_ID, 'developer', 'промпт')
    assert.equal(developer(pm).extraArgs, FLAGS)
    const copy = pm.duplicateTaskType(GENERAL_TASK_TYPE_ID)
    assert.equal(copy.settings.roles?.find((r) => r.id === 'developer')?.extraArgs, FLAGS)
  })

  it('updateRole (путь CLI): правка прочих полей флаги не трогает, смена агента — сбрасывает; задать флаги нельзя', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.patchTaskType(GENERAL_TASK_TYPE_ID, { roles: withFlags('--verbose') })
    assert.equal(pm.updateRole(GENERAL_TASK_TYPE_ID, 'developer', { title: 'Сеньор', model: 'opus' }).extraArgs, '--verbose')
    assert.equal(pm.updateRole(GENERAL_TASK_TYPE_ID, 'developer', { agent: developer(pm).agent }).extraArgs, '--verbose', 'тот же агент — флаги остаются')
    const other = developer(pm).agent === 'codex' ? 'claude' : 'codex'
    const changed = pm.updateRole(GENERAL_TASK_TYPE_ID, 'developer', { agent: other })
    assert.equal(changed.agent, other)
    assert.equal('extraArgs' in changed, false)
    assert.equal('extraArgs' in developer(new ProjectManager(tmp)), false)
  })
})
