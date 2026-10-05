import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

async function wizard() { return import('../src/server/wizard.ts') }
const context = { home: '/home/orca', root: false, installer: true }
function io(answers: string[]) {
  const prompts: string[] = []; const output: string[] = []
  return { prompts, output, write: (value: string) => { output.push(value) }, ask: async (prompt: string) => {
    prompts.push(prompt); assert.ok(answers.length, `Неожиданный вопрос: ${prompt}`); return answers.shift()!
  } }
}

test('Enter выбирает SSH, объясняет проекты и подтверждает план до применения', async () => {
  const { collectSetup } = await wizard(); const terminal = io(['', '', 'operator', '', ''])
  const result = await collectSetup(terminal, context)
  assert.equal(result.mode, 'local'); assert.equal(result.projectRoot, join(context.home, 'projects'))
  assert.equal(result.provision, true); assert.equal(result.login, 'operator')
  assert.match(terminal.output.join(''), /поменять/i); assert.match(terminal.output.join(''), /репозитор/i)
  assert.match(terminal.prompts.at(-1)!, /Применить/)
})

test('root требует ROOT, пустое подтверждение отменяет мастер', async () => {
  const { collectSetup } = await wizard(); const terminal = io([''])
  await assert.rejects(collectSetup(terminal, { ...context, root: true }), /отмен/i)
  assert.equal(terminal.prompts.length, 1)
})

test('отказ OPEN не позволяет опубликовать панель', async () => {
  const { collectSetup } = await wizard(); const terminal = io(['2', '/home/orca/projects', 'orca.example.com', '', ''])
  await assert.rejects(collectSetup(terminal, context), /отмен/i)
  assert.match(terminal.output.join(''), /форму входа/)
})

test('публичный мастер принимает разные домены и явное OPEN', async () => {
  const { collectSetup } = await wizard()
  const terminal = io(['2', '', 'https://orca.example.com/', '', 'OPEN', 'operator', 'ops@example.com', '', ''])
  const result = await collectSetup(terminal, context)
  assert.equal(result.domain, 'orca.example.com'); assert.equal(result.previewDomain, 'preview.example.com')
  assert.equal(result.email, 'ops@example.com'); assert.equal(result.provision, true)
})

test('повторный мастер сохраняет аккаунт и существующий путь по умолчанию', async () => {
  const { collectSetup } = await wizard()
  const terminal = io(['', '', '', ''])
  const existing = { projectRoots: [join(context.home, 'repos')], mode: 'local' as const, origin: 'http://localhost:3737', previewOrigin: 'http://127.0.0.1:3738' }
  const result = await collectSetup(terminal, { ...context, existing })
  assert.equal(result.projectRoot, existing.projectRoots[0]); assert.equal(result.login, undefined)
  assert.ok(terminal.prompts.every(prompt => !prompt.includes('Логин')))
})

test('домен не допускает IP, путь, порт, директивы proxy и одинаковые hosts', async () => {
  const { parseHostname } = await wizard()
  for (const value of ['127.0.0.1', 'https://example.com/ru', 'example.com:443', 'foo.example {', 'a..example', '-a.example', 'a.example\nlog']) {
    assert.throws(() => parseHostname(value), /домен/i, value)
  }
  assert.equal(parseHostname('HTTPS://Orca.Example.COM/'), 'orca.example.com')
})

test('SSH-инструкция учитывает нестандартный порт и не допускает аргументы из имени подключения', async () => {
  const { sshInstructions } = await wizard()
  assert.match(sshInstructions('root@example.com', 3737, 3738, '2222'), /-p 2222/)
  assert.match(sshInstructions('-oProxyCommand=bad', 3737, 3738), /ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА/)
})

test('для нового пользователя мастер заполняет отсутствующее имя и email автора Git', async () => {
  const { collectSetup } = await wizard(); const terminal = io(['', '', 'operator', '', '', '', ''])
  const result = await collectSetup(terminal, { ...context, gitIdentityMissing: true, gitEmail: 'existing@example.com' })
  assert.equal(result.gitName, 'Orca'); assert.equal(result.gitEmail, 'existing@example.com')
})

test('после прерванной установки существующий аккаунт сохраняется без нового пароля', async () => {
  const { collectSetup } = await wizard(); const terminal = io(['', '', '', ''])
  const result = await collectSetup(terminal, { ...context, accountsExist: true })
  assert.equal(result.login, undefined)
})

test('русское да включает автоматизацию, в том числе закрытие публичных маршрутов', async () => {
  const { collectSetup } = await wizard(); const terminal = io(['1', '', 'да', 'да'])
  const result = await collectSetup(terminal, { ...context, existing: { projectRoots: ['/srv/git'], mode: 'proxy', origin: 'https://orca.example.com', previewOrigin: 'https://preview.example.com' } })
  assert.equal(result.provision, true); assert.equal(result.mode, 'local')
})

test('перезапуск работающей установки требует RESTART и отказ сохраняет настройки', async () => {
  const { collectSetup } = await wizard(); const terminal = io(['', '', 'y', ''])
  await assert.rejects(collectSetup(terminal, { ...context, running: true, existing: { projectRoots: ['/srv/git'], mode: 'local', origin: 'http://localhost:3737', previewOrigin: 'http://127.0.0.1:3738' } }), /отмен/)
  assert.match(terminal.output.join(''), /задания|терминалы/)
})
