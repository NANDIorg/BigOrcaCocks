// Запуск: pnpm --filter @orca-board/desktop test. Ассистент в настройках приложения (`AppSettings.assistant`):
// миграция роли `assistant` из типов задач (`migrateAssistant`, при `ProjectManager.load()`), чтение и запись
// настроек (`settings()`/`setSettings()`), сборка запуска (`assistantLaunch`).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ASSISTANT_START_PROMPT, DEFAULT_ASSISTANT_SETTINGS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, agentLanguageDirective, presetTaskTypes,
  type Role, type TaskType
} from '@orca-board/core'
import { libraryDefaultTypeId, migrateAssistant, PROJECTS_FILE_VERSION } from './task-types-migration'
import { ProjectManager } from './projects'
import { ASSISTANT_PERMISSION_MODE, assistantLaunch, loadedAssistantSettings, mergedAssistantSettings } from './assistant'

const coordinator = (patch: Partial<Role> = {}): Role => ({ id: 'coordinator', title: 'Координатор', agent: 'claude', ...patch })
const assistant = (patch: Partial<Role> = {}): Role => ({ id: 'assistant', title: 'Ассистент', agent: 'claude', ...patch })
const developer: Role = { id: 'developer', title: 'Программист', agent: 'claude' }
const type = (id: string, roles: Role[] | undefined, extra: Partial<TaskType['settings']> = {}): TaskType =>
  ({ id, title: id, settings: { ...(roles ? { roles } : {}), ...extra } })

describe('libraryDefaultTypeId', () => {
  const types = [type('a', undefined), type(GENERAL_TASK_TYPE_ID, undefined)]
  it('заданный существующий → он, удалённый → general, нет general → первый', () => {
    assert.equal(libraryDefaultTypeId(types, 'a'), 'a')
    assert.equal(libraryDefaultTypeId(types, 'gone'), GENERAL_TASK_TYPE_ID)
    assert.equal(libraryDefaultTypeId([type('a', undefined)], undefined), 'a')
  })
})

describe('migrateAssistant: чистая функция', () => {
  it('ни одной роли assistant — ничего не меняется, те же объекты', () => {
    const data = { taskTypes: [type('general', [coordinator(), developer])], settings: { keepInBackground: false } }
    const r = migrateAssistant(data)
    assert.equal(r.changed, false)
    assert.equal(r.taskTypes, data.taskTypes)
    assert.equal(r.settings, data.settings)
  })

  it('роль типа по умолчанию → settings.assistant; роль удалена из всех типов; исходные данные не мутируются', () => {
    const data = {
      taskTypes: [
        type('general', [coordinator(), assistant({ agent: 'claude', model: 'opus', effort: 'high' }), developer]),
        type('mine', [coordinator(), assistant({ agent: 'codex', model: 'gpt-5', systemPrompt: 'Отвечай кратко' }), developer], { agentRules: 'r' })
      ],
      defaultTaskTypeId: 'mine',
      settings: { keepInBackground: false, language: 'en' as const }
    }
    const before = structuredClone(data)
    const r = migrateAssistant(data)
    assert.equal(r.changed, true)
    assert.deepEqual(data, before)
    assert.deepEqual(r.settings, { keepInBackground: false, language: 'en', assistant: { agent: 'codex', model: 'gpt-5', systemPrompt: 'Отвечай кратко' } })
    assert.deepEqual(r.taskTypes!.map((t) => t.settings.roles!.map((x) => x.id)), [['coordinator', 'developer'], ['coordinator', 'developer']])
    assert.equal(r.taskTypes![1].settings.agentRules, 'r', 'остальные настройки типа не задеты')
  })

  it('у типа по умолчанию нет assistant — агент, модель и effort его координатора (без инструкций)', () => {
    const data = {
      taskTypes: [
        type('general', [coordinator({ agent: 'gemini', model: 'g', effort: 'low', systemPrompt: 'координатору' }), developer]),
        type('other', [assistant({ agent: 'codex' }), developer])
      ]
    }
    const r = migrateAssistant(data)
    assert.deepEqual(r.settings?.assistant, { agent: 'gemini', model: 'g', effort: 'low' })
    assert.deepEqual(r.taskTypes![1].settings.roles!.map((x) => x.id), ['developer'])
  })

  it('у типа по умолчанию нет ни assistant, ни coordinator — дефолт', () => {
    const r = migrateAssistant({ taskTypes: [type('general', [developer]), type('other', [assistant({ agent: 'codex' })])] })
    assert.deepEqual(r.settings?.assistant, DEFAULT_ASSISTANT_SETTINGS)
  })

  it('тип без своих ролей — по DEFAULT_ROLES (агент координатора)', () => {
    const r = migrateAssistant({ taskTypes: [type('general', undefined), type('other', [assistant({ agent: 'codex' }), developer])] })
    assert.deepEqual(r.settings?.assistant, { agent: 'claude' })
  })

  it('тип только из роли assistant — поле roles убирается (тип возьмёт DEFAULT_ROLES)', () => {
    const r = migrateAssistant({ taskTypes: [type('general', [assistant()], { agentRules: 'x' })] })
    assert.deepEqual(r.taskTypes![0].settings, { agentRules: 'x' })
  })

  it('settings.assistant уже задан (откат версии) — побеждает, роль только вычищается', () => {
    const settings = { assistant: { agent: 'codex' as const, model: 'm' } }
    const r = migrateAssistant({ taskTypes: [type('general', [coordinator(), assistant({ agent: 'gemini' })])], settings })
    assert.equal(r.changed, true)
    assert.deepEqual(r.settings, settings)
    assert.deepEqual(r.taskTypes![0].settings.roles!.map((x) => x.id), ['coordinator'])
  })

  it('идемпотентна: повторный прогон ничего не меняет', () => {
    const first = migrateAssistant({ taskTypes: [type('general', [coordinator(), assistant({ model: 'opus' })])] })
    const second = migrateAssistant({ taskTypes: first.taskTypes, settings: first.settings })
    assert.equal(second.changed, false)
    assert.deepEqual(second.settings, { assistant: { agent: 'claude', model: 'opus' } })
  })
})

describe('ProjectManager: миграция ассистента при загрузке', () => {
  let tmp: string
  const file = (): string => path.join(tmp, 'projects.json')
  const saved = (): { taskTypes: TaskType[]; settings?: Record<string, unknown> } => JSON.parse(readFileSync(file(), 'utf8'))

  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-assistant-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('новый пользователь: заготовки без assistant, настройки ассистента — дефолт', () => {
    const pm = new ProjectManager(tmp)
    assert.ok(pm.taskTypes().length > 0)
    for (const t of pm.taskTypes()) assert.ok(!(t.settings.roles ?? DEFAULT_ROLES).some((r) => r.id === 'assistant'), t.id)
    assert.deepEqual(pm.settings().assistant, DEFAULT_ASSISTANT_SETTINGS)
  })

  it('файл со старой ролью: settings.assistant = роль типа по умолчанию, роль исчезла отовсюду, файл записан, второй запуск его не меняет', () => {
    // Библиотека «старой версии»: заготовки с ролью assistant, у типа по умолчанию она правлена человеком.
    const types = presetTaskTypes().map((t) => ({
      ...t,
      settings: { ...t.settings, roles: [...(t.settings.roles ?? []), assistant(t.id === 'backend' ? { agent: 'codex', model: 'gpt-5', effort: 'high', systemPrompt: 'Будь краток' } : {})] }
    }))
    writeFileSync(file(), JSON.stringify({
      version: PROJECTS_FILE_VERSION, taskTypesSeeded: true, taskTypes: types, defaultTaskTypeId: 'backend',
      projects: [], activeId: null, settings: { keepInBackground: false, custom: 1 }, onboarding: { status: 'completed', version: 1, at: 1 }
    }))
    const pm = new ProjectManager(tmp)
    const expected = { agent: 'codex', model: 'gpt-5', effort: 'high', systemPrompt: 'Будь краток' }
    assert.deepEqual(pm.settings().assistant, expected)
    assert.equal(pm.settings().keepInBackground, false)
    for (const t of pm.taskTypes()) assert.ok(!(t.settings.roles ?? []).some((r) => r.id === 'assistant'), t.id)
    const text = readFileSync(file(), 'utf8')
    assert.deepEqual(saved().settings, { keepInBackground: false, custom: 1, assistant: expected }, 'чужие ключи settings сохранены')
    assert.deepEqual(pm.onboardingState().status, 'completed')

    const again = new ProjectManager(tmp)
    assert.deepEqual(again.settings().assistant, expected)
    assert.equal(readFileSync(file(), 'utf8'), text, 'второй запуск ничего не меняет')
  })

  it('файл до типов задач (v1): роль assistant проекта уезжает в тип и вычищается', () => {
    writeFileSync(file(), JSON.stringify({
      projects: [{ id: 'p1', root: tmp, name: 'repo', roles: [coordinator(), assistant({ agent: 'gemini' }), developer] }],
      activeId: 'p1'
    }))
    const pm = new ProjectManager(tmp)
    assert.ok(!pm.roles('p1').some((r) => r.id === 'assistant'))
    assert.deepEqual(pm.roles('p1').map((r) => r.id), ['coordinator', 'developer'])
    // Тип по умолчанию — «Программирование» (тип проекта «repo» не становится типом библиотеки по умолчанию), у него
    // роли assistant не было: ассистент берёт агента его координатора.
    assert.deepEqual(pm.settings().assistant, { agent: 'claude' })
  })
})

describe('настройки ассистента: settings() и setSettings()', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-assistant-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('запись по полям, переживает перезапуск, не задевает остальные настройки', () => {
    const pm = new ProjectManager(tmp)
    const before = pm.settings()
    const next = pm.setSettings({ assistant: { model: 'opus', systemPrompt: '  Отвечай кратко\n' } })
    assert.deepEqual(next.assistant, { agent: 'claude', model: 'opus', systemPrompt: '  Отвечай кратко\n' })
    assert.deepEqual(next.notifications, before.notifications)
    assert.deepEqual(next.updates, before.updates)
    assert.deepEqual(new ProjectManager(tmp).settings().assistant, next.assistant)
    pm.setSettings({ keepInBackground: false })
    assert.deepEqual(pm.settings().assistant, next.assistant, 'патч без assistant его не трогает')
  })

  it('пустая строка очищает поле; смена агента без модели и effort сбрасывает их, с ними — ставит', () => {
    const pm = new ProjectManager(tmp)
    pm.setSettings({ assistant: { model: 'opus', effort: 'high', systemPrompt: 'p' } })
    assert.deepEqual(pm.setSettings({ assistant: { systemPrompt: '  ' } }).assistant, { agent: 'claude', model: 'opus', effort: 'high' })
    assert.deepEqual(pm.setSettings({ assistant: { agent: 'codex' } }).assistant, { agent: 'codex' })
    assert.deepEqual(pm.setSettings({ assistant: { agent: 'claude', model: 'sonnet' } }).assistant, { agent: 'claude', model: 'sonnet' })
    assert.deepEqual(pm.setSettings({ assistant: { agent: 'claude' } }).assistant, { agent: 'claude', model: 'sonnet' }, 'тот же агент — модель остаётся')
  })

  it('валидация: неизвестный агент, не-строка, не объект — ошибка, файл не меняется', () => {
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.setSettings({ assistant: { agent: 'gpt' as 'claude' } }), /ассистент: неизвестный агент gpt/)
    assert.throws(() => pm.setSettings({ assistant: { model: 5 as unknown as string } }), /ассистент: поле model должно быть строкой/)
    assert.throws(() => pm.setSettings({ assistant: [] as unknown as { agent: 'claude' } }), /настройки ассистента: ожидается объект/)
    assert.deepEqual(pm.settings().assistant, DEFAULT_ASSISTANT_SETTINGS)
  })

  it('битые настройки в файле: неизвестный агент — claude, не-строки и пустые строки выпадают', () => {
    assert.deepEqual(loadedAssistantSettings({ agent: 'gpt', model: 5, effort: ' ', systemPrompt: 'p' }), { agent: 'claude', systemPrompt: 'p' })
    assert.deepEqual(loadedAssistantSettings('x'), DEFAULT_ASSISTANT_SETTINGS)
    assert.deepEqual(mergedAssistantSettings({ agent: 'codex', model: 'm' }, { model: ' o3 ' }), { agent: 'codex', model: 'o3' })
  })
})

describe('assistantLaunch', () => {
  it('агент, модель, effort из настроек; режим разрешений всегда auto; стартовое сообщение', () => {
    const l = assistantLaunch({ agent: 'codex', model: 'gpt-5', effort: 'high' }, 'СЛУЖЕБНАЯ')
    assert.deepEqual(l, { agent: 'codex', system: 'СЛУЖЕБНАЯ', prompt: ASSISTANT_START_PROMPT, permissionMode: 'auto', model: 'gpt-5', effort: 'high' })
    assert.equal(ASSISTANT_PERMISSION_MODE, 'auto')
  })

  it('инструкции — блоком «Ассистент» после служебной, директива языка — последней', () => {
    const l = assistantLaunch({ agent: 'claude', systemPrompt: 'Отвечай кратко' }, 'СЛУЖЕБНАЯ', 'en')
    assert.equal(l.system, `СЛУЖЕБНАЯ\n\n# Инструкции роли «Ассистент»\n\nОтвечай кратко\n\n${agentLanguageDirective('en')}`)
    assert.equal('model' in l, false)
    assert.equal('effort' in l, false)
  })
})
