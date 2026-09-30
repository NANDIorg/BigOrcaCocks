// Запуск: pnpm --filter @orca-board/desktop test. Сквозная проверка «Экспорта типа задач» на настоящем ProjectManager
// (projects.json во временной папке) и настоящей записи файла (`writeFileAtomic`, реальная ФС): экспорт → файл на диске →
// чтение → «импорт» на свежем ProjectManager (`saveTaskType(file.type)`, как будет делать будущий импорт) → те же
// раскрытые настройки. Диалог «Сохранить как» подставлен: в `index.ts` он один и тот же для всех сценариев
// (`pickExportFile`), а поток вокруг него — `exportTaskTypeToFile` — здесь настоящий, с теми же зависимостями, что в
// обработчике `taskTypes:export`. Юнит-тесты формата — packages/core/src/task-type-file.test.ts, обработчика — task-type-export.test.ts.
import { describe, it, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ROLES, TASK_TYPE_FILE_FORMAT, TASK_TYPE_FILE_VERSION, defaultSubflow, defaultWorkflow, presetTaskTypes, resolveTaskType,
  taskTypeFileName,
  type Role, type TaskType, type TaskTypeFile, type TaskTypeFileMeta, type WfNode, type Workflow
} from '@orca-board/core'
import { ProjectManager } from './projects'
import { OrcaError } from './i18n'
import { exportTaskTypeToFile, type TaskTypeExportDeps } from './task-type-export'
import { writeFileAtomic } from './persistence'
import { PROJECTS_FILE_VERSION } from './task-types-migration'

const META: TaskTypeFileMeta = { appVersion: '0.9.3', exportedAt: '2026-09-30T12:34:56.000Z' }

let tmp: string
/** Каталог данных приложения (`userData`): в нём projects.json. */
let user: string
/** Куда «пользователь» сохраняет файлы в диалоге. */
let out: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-type-export-e2e-')))
  user = path.join(tmp, 'user')
  out = path.join(tmp, 'out')
  mkdirSync(user)
  mkdirSync(out)
})

afterEach(() => {
  // Каталог только для чтения (сценарий записи без прав) не даёт удалить вложенное — вернём права.
  try { chmodSync(out, 0o755) } catch { /* каталога уже нет */ }
  rmSync(tmp, { recursive: true, force: true })
})

const newManager = (dir: string = user): ProjectManager => new ProjectManager(dir)

/** Дизайнер с моделью, усилием и длинным многострочным промптом: то, что человек настраивал руками. */
const DESIGNER: Role = {
  id: 'designer', title: 'Дизайнер', agent: 'codex', model: 'gpt-5-codex', effort: 'high',
  description: 'Рисует макеты.\nВторая строка описания.',
  systemPrompt: 'Рисуй макеты в Figma.\n\n# Правила\n- «ёлочки» и — тире\n- эмодзи 🎨 тоже'
}

/**
 * Пользовательский тип «со всем»: свои роли (в том числе с агентом, которого может не быть на машине), правила,
 * режим `acceptEdits`, граф версии 2 с путём подзадачи, колонками и ссылками на шаблоны нод. `workflowNotes` — след
 * автомиграции графа: в файл попадать не должен.
 */
function customTypeInput(): Parameters<ProjectManager['saveTaskType']>[0] {
  const roles: Role[] = [...DEFAULT_ROLES.map((r) => ({ ...r })), DESIGNER]
  const sub = defaultSubflow()
  const workflow: Workflow = {
    version: 2,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      {
        id: 'work', type: 'work', x: 220, y: 40, title: 'Реализация', roleIds: ['developer', 'designer'], column: 'col_dev', templateId: 'tpl_work',
        subflow: { nodes: sub.nodes.map((n, i): WfNode => ({ ...n, column: `col_sub_${i}`, templateId: `tpl_sub_${i}` })), edges: sub.edges }
      },
      { id: 'review', type: 'gate', roleId: 'reviewer', x: 440, y: 0, title: 'Ревью', column: 'col_review', templateId: 'tpl_gate' },
      { id: 'end', type: 'end', x: 660, y: 0 }
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
      { id: 'e2', from: 'work', outcome: 'next', to: 'review' },
      { id: 'e3', from: 'review', outcome: 'accept', to: 'end' },
      { id: 'e4', from: 'review', outcome: 'reject', to: 'work' }
    ]
  }
  return {
    title: 'Свой: «всё» / с путём',
    description: 'Полный набор настроек',
    settings: { roles, agentRules: 'Не меняй публичный контракт API.\nМиграции — только новые файлы.', permissionMode: 'acceptEdits', workflow },
    workflowNotes: [{ code: 'mergeRemoved', message: 'Снят merge' }]
  }
}

/** Все значения по ключу на любой глубине — проверить, что поля нет нигде в файле (или есть). */
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesOf(v, key))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([k, v]) => [...(k === key ? [v] : []), ...valuesOf(v, key)])
}

/** Копия значения без `templateId` на любой глубине: экспорт снимает ссылки на локальную библиотеку шаблонов нод. */
function withoutTemplateIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTemplateIds)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'templateId').map(([k, v]) => [k, withoutTemplateIds(v)]))
}

/**
 * Раскрытые настройки без `typeId` (у копии свой id) и без `templateId` (экспорт их снимает) — то, что должно
 * совпасть у исходного типа и его копии из файла.
 */
function settingsOf(t: TaskType): Record<string, unknown> {
  const { typeId: _typeId, ...rest } = resolveTaskType(t)
  return withoutTemplateIds(rest) as Record<string, unknown>
}

/** Зависимости «Экспорта типа» как в обработчике `taskTypes:export` (`index.ts`); диалог возвращает `chosen`. */
function exportDeps(pm: ProjectManager, chosen: string | null, asked: string[] = []): TaskTypeExportDeps {
  return {
    export: (id) => pm.exportTaskType(id, META),
    chooseFile: async (name) => { asked.push(name); return chosen },
    write: writeFileAtomic
  }
}

/** Экспорт в файл `name` каталога `out`, как при выборе пути в диалоге; возвращает разобранный файл и его текст. */
async function exportTo(pm: ProjectManager, typeId: string, name: string): Promise<{ file: TaskTypeFile; text: string; path: string }> {
  const target = path.join(out, name)
  assert.deepEqual(await exportTaskTypeToFile(exportDeps(pm, target), typeId), { path: target })
  const text = readFileSync(target, 'utf8')
  return { file: JSON.parse(text) as TaskTypeFile, text, path: target }
}

/** Файл в каталоге данных: как его видит человек, который открыл `projects.json`. */
const projectsJson = (): string => readFileSync(path.join(user, 'projects.json'), 'utf8')

describe('экспорт типа: файл пригоден для импорта', () => {
  it('7 заготовок и свой тип: файл на диске → свежий ProjectManager → saveTaskType(file.type) → те же раскрытые настройки', async () => {
    const source = newManager()
    const own = source.saveTaskType(customTypeInput())
    const presets = presetTaskTypes()
    assert.equal(presets.length, 7)
    const types = [...presets, own]
    // Приёмник — другая «машина»: свой каталог данных, никаких общих объектов с источником.
    const target = newManager(path.join(tmp, 'other-machine'))

    for (const src of types) {
      const { file } = await exportTo(source, src.id, taskTypeFileName(src.title))
      assert.equal(file.format, TASK_TYPE_FILE_FORMAT, src.id)
      assert.equal(file.formatVersion, TASK_TYPE_FILE_VERSION, src.id)
      assert.equal(file.exportedAt, META.exportedAt)
      assert.equal(file.appVersion, META.appVersion)

      const copy = target.saveTaskType(file.type)
      assert.notEqual(copy.id, src.id, `${src.id}: у копии свой id`)
      assert.equal(copy.title, src.title, src.id)
      assert.equal(copy.description, src.description, src.id)
      assert.deepEqual(settingsOf(copy), settingsOf(src), `${src.id}: раскрытые настройки совпадают`)
      assert.deepEqual(valuesOf(copy, 'templateId'), [], `${src.id}: у копии нет ссылок на шаблоны нод`)
      // Ещё и после «перезапуска» приёмника: то, что сохранилось на диск, а не только то, что в памяти.
      const reloaded = newManager(path.join(tmp, 'other-machine')).taskType(copy.id)
      assert.ok(reloaded, `${src.id}: копия пережила перезапуск`)
      assert.deepEqual(settingsOf(reloaded), settingsOf(src), `${src.id}: после перезапуска`)
    }
  })

  it('круг «экспорт → импорт → экспорт»: type во втором файле такой же, как в первом', async () => {
    const source = newManager()
    const own = source.saveTaskType(customTypeInput())
    const target = newManager(path.join(tmp, 'other-machine'))
    for (const src of [presetTaskTypes()[2], own]) {
      const first = (await exportTo(source, src.id, 'first.json')).file
      const copy = target.saveTaskType(first.type)
      const second = JSON.parse(target.exportTaskType(copy.id, META).text) as TaskTypeFile
      assert.deepEqual(second, first, src.id)
    }
  })

  it('свой тип: роли (в том числе с не своим агентом), правила, режим, граф с путём подзадачи и колонками не теряются', async () => {
    const pm = newManager()
    const own = pm.saveTaskType(customTypeInput())
    const { file } = await exportTo(pm, own.id, 'own.json')
    const s = file.type.settings
    assert.equal(file.type.title, 'Свой: «всё» / с путём')
    assert.equal(file.type.description, 'Полный набор настроек')
    assert.equal(s.permissionMode, 'acceptEdits')
    assert.equal(s.agentRules, 'Не меняй публичный контракт API.\nМиграции — только новые файлы.')
    assert.deepEqual(s.roles.find((r) => r.id === 'designer'), DESIGNER, 'роль с агентом codex, моделью, усилием и промптом — как есть')
    assert.equal(s.workflow.version, 2)
    const work = s.workflow.nodes.find((n) => n.id === 'work')
    assert.ok(work && work.type === 'work' && work.subflow, 'путь подзадачи в файле')
    assert.deepEqual(work.roleIds, ['developer', 'designer'])
    assert.deepEqual([work.x, work.y], [220, 40], 'позиции нод сохранены')
    assert.equal(work.subflow.nodes.length, defaultSubflow().nodes.length)
    assert.equal(work.subflow.edges.length, defaultSubflow().edges.length)
  })
})

describe('экспорт типа: что попадает в файл', () => {
  it('нет id типа, workflowNotes и templateId (и в пути подзадачи); column есть — и у нод графа, и у нод пути', async () => {
    const pm = newManager()
    const own = pm.saveTaskType(customTypeInput())
    assert.ok(pm.taskType(own.id)?.workflowNotes?.length, 'предусловие: у типа есть workflowNotes')
    const { file, text } = await exportTo(pm, own.id, 'own.json')

    assert.deepEqual(Object.keys(file), ['format', 'formatVersion', 'exportedAt', 'appVersion', 'type'])
    assert.equal('id' in file.type, false, 'id типа при импорте выдаётся новый')
    assert.equal('workflowNotes' in file.type, false)
    assert.deepEqual(valuesOf(file, 'workflowNotes'), [])
    assert.deepEqual(valuesOf(file, 'templateId'), [])
    assert.doesNotMatch(text, /templateId|workflowNotes/)
    assert.doesNotMatch(text, new RegExp(own.id), 'id типа нигде в тексте')

    const columns = valuesOf(file.type.settings.workflow, 'column')
    assert.ok(columns.includes('col_dev'), 'column ноды графа')
    assert.ok(columns.includes('col_review'))
    assert.ok(columns.includes('col_sub_0'), 'column ноды пути подзадачи')
    assert.equal(columns.length, 2 + defaultSubflow().nodes.length, 'колонки — на всех нодах, где они были')
  })

  it('у 7 заготовок нет id типа, workflowNotes и templateId', async () => {
    const pm = newManager()
    for (const preset of presetTaskTypes()) {
      const { file } = await exportTo(pm, preset.id, taskTypeFileName(preset.title))
      assert.equal('id' in file.type, false, preset.id)
      assert.deepEqual(valuesOf(file, 'workflowNotes'), [], preset.id)
      assert.deepEqual(valuesOf(file, 'templateId'), [], preset.id)
    }
  })

  it('тип «Новый тип» (settings: {}): роли, граф и режим раскрыты, правил нет', async () => {
    const pm = newManager()
    const t = pm.saveTaskType({ title: 'Новый тип', settings: {} })
    const { file } = await exportTo(pm, t.id, 'new.json')
    assert.deepEqual(file.type, {
      title: 'Новый тип',
      settings: { permissionMode: 'auto', roles: DEFAULT_ROLES, workflow: defaultWorkflow(DEFAULT_ROLES) }
    })
  })

  it('формат файла: UTF-8, отступ 2 пробела, перевод строки в конце, кириллица не экранирована', async () => {
    const pm = newManager()
    const { text } = await exportTo(pm, 'backend', 'backend.json')
    assert.ok(text.endsWith('}\n'))
    assert.ok(!text.endsWith('\n\n'))
    assert.match(text, /^\{\n {2}"format": "orca-board\.task-type",\n {2}"formatVersion": 1,\n/)
    assert.match(text, /"title": "Бэкенд"/)
    assert.doesNotMatch(text, /\\u04/, 'кириллица — символами, а не \\uXXXX')
    assert.doesNotMatch(text, /\r/)
  })
})

describe('экспорт типа: сохранённая версия', () => {
  it('правка типа после экспорта на файл не влияет; следующий экспорт видит правку', async () => {
    const pm = newManager()
    const own = pm.saveTaskType(customTypeInput())
    const first = await exportTo(pm, own.id, 'v1.json')

    pm.saveTaskType({ ...customTypeInput(), id: own.id, title: 'Переименован', settings: { agentRules: 'другое', permissionMode: 'bypassPermissions' } })
    assert.equal(pm.taskType(own.id)?.title, 'Переименован')
    assert.equal(readFileSync(first.path, 'utf8'), first.text, 'файл на диске — прежний, байт в байт')
    assert.equal(first.file.type.title, 'Свой: «всё» / с путём')

    const second = await exportTo(pm, own.id, 'v2.json')
    assert.equal(second.file.type.title, 'Переименован')
    assert.equal(second.file.type.settings.agentRules, 'другое')
    assert.equal(second.file.type.settings.permissionMode, 'bypassPermissions')
    assert.notEqual(second.text, first.text)
  })

  it('экспортируется сохранённое состояние: правка роли через patch видна сразу, до перезапуска', async () => {
    const pm = newManager()
    const t = pm.saveTaskType({ title: 'Свой', settings: {} })
    pm.updateRole(t.id, 'reviewer', { model: 'opus' })
    const { file } = await exportTo(pm, t.id, 'own.json')
    assert.equal(file.type.settings.roles.find((r) => r.id === 'reviewer')?.model, 'opus')
  })

  it('правка разобранного файла тип не меняет (глубокие копии)', async () => {
    const pm = newManager()
    const own = pm.saveTaskType(customTypeInput())
    const before = JSON.stringify(pm.taskType(own.id))
    const { file } = await exportTo(pm, own.id, 'own.json')
    file.type.settings.roles[0].title = 'испорчено'
    file.type.settings.workflow.nodes[1].x = -1
    file.type.settings.roles.pop()
    assert.equal(JSON.stringify(pm.taskType(own.id)), before)
    assert.equal(JSON.stringify(newManager().taskType(own.id)), before, 'и на диске тоже')
  })

  it('экспорт ничего не пишет в projects.json', async () => {
    const pm = newManager()
    pm.saveTaskType(customTypeInput())
    const before = projectsJson()
    const mtime = statSync(path.join(user, 'projects.json')).mtimeMs
    for (const t of pm.taskTypes()) await exportTo(pm, t.id, `${t.id}.json`)
    assert.equal(projectsJson(), before)
    assert.equal(statSync(path.join(user, 'projects.json')).mtimeMs, mtime)
  })
})

describe('экспорт типа: диалог и запись на настоящей ФС', () => {
  it('успех: диалог получил имя по названию, файл записан целиком, .tmp не осталось', async () => {
    const pm = newManager()
    const asked: string[] = []
    const target = path.join(out, 'выбрано-в-диалоге.json')
    const res = await exportTaskTypeToFile(exportDeps(pm, target, asked), 'backend')
    assert.deepEqual(res, { path: target })
    assert.deepEqual(asked, ['task-type-Бэкенд.json'])
    assert.equal(readFileSync(target, 'utf8'), pm.exportTaskType('backend', META).text)
    assert.deepEqual(readdirSync(out), ['выбрано-в-диалоге.json'])
  })

  it('отмена диалога: null, в каталоге пусто', async () => {
    const pm = newManager()
    const asked: string[] = []
    assert.equal(await exportTaskTypeToFile(exportDeps(pm, null, asked), 'backend'), null)
    assert.equal(asked.length, 1, 'диалог показан')
    assert.deepEqual(readdirSync(out), [])
  })

  it('файл уже есть: заменён целиком (подтверждение — дело системного диалога)', async () => {
    const pm = newManager()
    const target = path.join(out, 'x.json')
    writeFileSync(target, 'старое содержимое, длиннее нового'.repeat(5000))
    await exportTaskTypeToFile(exportDeps(pm, target), 'docs')
    assert.equal(readFileSync(target, 'utf8'), pm.exportTaskType('docs', META).text)
    assert.deepEqual(readdirSync(out), ['x.json'])
  })

  it('каталог только для чтения: type.exportFailed с путём и причиной, файла и .tmp нет', async (t: TestContext) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('права каталога не действуют (Windows или root)')
    const pm = newManager()
    chmodSync(out, 0o555)
    const target = path.join(out, 'ro.json')
    await assert.rejects(exportTaskTypeToFile(exportDeps(pm, target), 'backend'), (e: unknown) => {
      assert.ok(e instanceof OrcaError)
      assert.equal(e.key, 'type.exportFailed')
      assert.equal(e.params?.path, target)
      assert.match(String(e.params?.reason), /EACCES|EPERM/)
      assert.ok(e.message.includes(target), 'в тексте — путь')
      return true
    })
    assert.deepEqual(readdirSync(out), [], 'ни файла, ни .tmp')
    // Права вернули — тот же экспорт проходит: ошибка не «залипла».
    chmodSync(out, 0o755)
    assert.deepEqual(await exportTaskTypeToFile(exportDeps(pm, target), 'backend'), { path: target })
  })

  it('путь — каталог: type.exportFailed, .tmp убран, каталог цел', async () => {
    const pm = newManager()
    const dir = path.join(out, 'папка.json')
    mkdirSync(dir)
    await assert.rejects(exportTaskTypeToFile(exportDeps(pm, dir), 'backend'), (e: unknown) => e instanceof OrcaError && e.key === 'type.exportFailed')
    assert.deepEqual(readdirSync(out), ['папка.json'])
    assert.ok(statSync(dir).isDirectory())
  })

  it('граф версии 99: workflow.future до диалога, файла нет', async () => {
    const future = { ...defaultWorkflow(DEFAULT_ROLES), version: 99 }
    writeFileSync(path.join(user, 'projects.json'), JSON.stringify({
      version: PROJECTS_FILE_VERSION, projects: [], taskTypesSeeded: true,
      taskTypes: [{ id: 'type_future', title: 'Из будущего', settings: { workflow: future } }]
    }))
    const pm = newManager()
    const asked: string[] = []
    await assert.rejects(exportTaskTypeToFile(exportDeps(pm, path.join(out, 'f.json'), asked), 'type_future'), (e: unknown) => {
      assert.ok(e instanceof OrcaError)
      assert.equal(e.key, 'workflow.future')
      assert.match(e.message, /версии 99.*обновите приложение/)
      return true
    })
    assert.deepEqual(asked, [], 'диалог не открывался')
    assert.deepEqual(readdirSync(out), [])
  })

  it('тип удалён между кликом и записью: type.notFound, диалога нет', async () => {
    const pm = newManager()
    pm.deleteTaskType('docs')
    const asked: string[] = []
    await assert.rejects(exportTaskTypeToFile(exportDeps(pm, path.join(out, 'd.json'), asked), 'docs'), (e: unknown) => e instanceof OrcaError && e.key === 'type.notFound')
    assert.deepEqual(asked, [])
    assert.deepEqual(readdirSync(out), [])
  })

  it('граф с ошибками (роль удалена) не блокирует экспорт: бэкап сломанного типа тоже нужен', async () => {
    const pm = newManager()
    const own = pm.saveTaskType(customTypeInput())
    // Удаляем роль, на которую ссылается граф: тип сохраняется, граф остаётся как был.
    pm.removeRole(own.id, 'designer')
    const { file } = await exportTo(pm, own.id, 'broken.json')
    assert.ok(!file.type.settings.roles.some((r) => r.id === 'designer'))
    const work = file.type.settings.workflow.nodes.find((n) => n.id === 'work')
    assert.ok(work?.type === 'work' && work.roleIds?.includes('designer'), 'граф как есть, со ссылкой на удалённую роль')
  })
})

describe('экспорт типа: имя файла и размер', () => {
  it('название со спецсимволами, кириллицей и слишком длинное: корректное имя, файл создаётся', async () => {
    const pm = newManager()
    const titles = [
      'A/B\\C:D*E?F"G<H>I|J',
      'Бэкенд: API / «мобильный»  клиент',
      '  ...точки и пробелы...  ',
      '\u0007управляющие\tсимволы\n',
      'CON',
      '???',
      'Ж'.repeat(300),
      'x'.repeat(300),
      '🎨'.repeat(30)
    ]
    for (const title of titles) {
      const t = pm.saveTaskType({ title, settings: {} })
      const { fileName } = pm.exportTaskType(t.id, META)
      assert.equal(fileName, taskTypeFileName(title))
      assert.match(fileName, /^task-type(-[^\\/:*?"<>|\u0000-\u001f\s]+)?\.json$/u, `${JSON.stringify(title)} → ${fileName}`)
      assert.ok(Array.from(fileName).length <= 'task-type-'.length + 60 + '.json'.length, `не длиннее лимита: ${fileName}`)
      const { file, path: written } = await exportTo(pm, t.id, fileName)
      assert.equal(path.basename(written), fileName)
      assert.equal(file.type.title, title.trim(), 'название внутри файла — как сохранено, без замены символов')
    }
    assert.equal(taskTypeFileName('???'), 'task-type.json')
    assert.equal(taskTypeFileName('CON'), 'task-type-CON.json')
  })

  // Дефект D1 (T4, исправлен в T5): лимит длины названия был только в символах (60), а не в байтах. 60 четырёхбайтовых
  // символов (эмодзи) давали имя ровно в 255 байт — предел имени файла на ext4 (Linux, CI ubuntu), — а `writeFileAtomic`
  // пишет сначала в `<имя>.tmp` (+4 байта) → ENAMETOOLONG → `type.exportFailed`. На APFS (macOS) 259 байт проходят,
  // поэтому проверка — по байтам, а не по ФС. Теперь `taskTypeFileName` считает ещё и байты с запасом под `.tmp`.
  it('имя файла из 4-байтовых символов вместе с суффиксом .tmp помещается в 255 байт', () => {
    const fileName = taskTypeFileName('🎨'.repeat(100))
    assert.ok(Buffer.byteLength(`${fileName}.tmp`) <= 255, `${Buffer.byteLength(fileName)} байт имени + 4 байта .tmp`)
  })

  it('промпт ~1 МБ: файл записан целиком и разбирается обратно без потерь', async () => {
    const pm = newManager()
    const prompt = 'Проверяй ветку по существу. 🔍\n'.repeat(40_000)
    assert.ok(Buffer.byteLength(prompt) > 1_000_000)
    const roles: Role[] = DEFAULT_ROLES.map((r) => (r.id === 'reviewer' ? { ...r, systemPrompt: prompt } : { ...r }))
    const t = pm.saveTaskType({ title: 'Большой промпт', settings: { roles, agentRules: prompt } })
    const { file, text, path: written } = await exportTo(pm, t.id, 'big.json')
    assert.equal(statSync(written).size, Buffer.byteLength(text), 'на диск записан весь текст')
    assert.ok(statSync(written).size > 2_000_000, 'два больших поля — больше 2 МБ')
    assert.equal(file.type.settings.roles.find((r) => r.id === 'reviewer')?.systemPrompt, prompt, 'промпт роли без усечения')
    assert.equal(file.type.settings.agentRules, prompt, 'правила без усечения')
    // И «импорт» такого файла проходит.
    const copy = newManager(path.join(tmp, 'other-machine')).saveTaskType(file.type)
    assert.equal(copy.settings.roles?.find((r) => r.id === 'reviewer')?.systemPrompt, prompt)
  })

  it('.tmp не остаётся и после серии успешных экспортов в один каталог', async () => {
    const pm = newManager()
    for (const t of pm.taskTypes()) await exportTo(pm, t.id, taskTypeFileName(t.title))
    const names = readdirSync(out)
    assert.equal(names.length, 7)
    assert.ok(names.every((n) => n.endsWith('.json')) && !names.some((n) => existsSync(path.join(out, `${n}.tmp`))))
  })
})
