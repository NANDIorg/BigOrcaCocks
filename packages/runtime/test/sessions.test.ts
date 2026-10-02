import { it } from 'node:test'
import assert from 'node:assert/strict'
import * as runtime from '../src/index.ts'
import type { PtyFactory, SessionEvent } from '../src/index.ts'

const { createSessionRegistry } = runtime

/** Заменяет только OS PTY: буфер, события, lifecycle и маршрутизация остаются настоящими. */
class TestPty {
  private data = (_data: string): void => {}
  private exit = (_event: { exitCode: number }): void => {}
  writes: string[] = []
  sizes: [number, number][] = []
  killed = false
  killExitCode?: number
  onData(listener: (data: string) => void): void { this.data = listener }
  onExit(listener: (event: { exitCode: number }) => void): void { this.exit = listener }
  write(data: string): void { this.writes.push(data) }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]) }
  kill(): void { this.killed = true; if (this.killExitCode !== undefined) this.finish(this.killExitCode) }
  output(data: string): void { this.data(data) }
  finish(code: number): void { this.exit({ exitCode: code }) }
}

function setup(onObserverError?: (error: unknown) => void) {
  const ports: TestPty[] = []
  const starts: { command: string; args: string[] | string; options: Parameters<PtyFactory>[2] }[] = []
  const registry = createSessionRegistry({
    spawn: (command, args, options) => {
      starts.push({ command, args, options })
      const proc = new TestPty()
      ports.push(proc)
      return proc
    }, onObserverError
  })
  const spawn = (extra: Partial<Parameters<typeof registry.spawnPty>[0]> = {}, onExit?: (id: string, code: number) => void): string =>
    registry.spawnPty({ command: 'agent', args: ['task'], cwd: '/project', cols: 80, rows: 24, meta: { role: 'worker', label: 'Задача', projectId: 'p', taskId: 't' }, ...extra }, onExit)
  return { registry, ports, starts, spawn }
}

it('отсоединение клиента сохраняет процесс и tail для нового клиента', () => {
  const { registry, ports, spawn } = setup()
  const first: SessionEvent[] = []
  const off = registry.subscribe(event => first.push(event))
  const id = spawn()
  ports[0].output('before\n')
  off(); off()
  ports[0].output('\x1b[31mafter\x1b[0m\r\n')
  assert.equal(ports[0].killed, false)
  assert.equal(registry.isAlive(id), true)
  assert.equal(first.length, 2)
  const snapshot = registry.terminalSnapshots()
  assert.equal(snapshot[0].tail, 'before\nafter\n')
  assert.equal(snapshot[0].taskId, 't')
  assert.equal(snapshot[0].projectId, 'p')
  const second: SessionEvent[] = []
  registry.subscribe(event => second.push(event))
  ports[0].output('new')
  assert.deepEqual(second, [{ type: 'data', ptyId: id, data: 'new' }])
})

it('snapshot не позволяет изменить метаданные живого терминала', () => {
  const { registry, spawn } = setup()
  spawn()
  registry.listTerminals()[0].label = 'чужая правка'
  assert.equal(registry.terminalSnapshots()[0].label, 'Задача')
})

it('изменение payload одним observer не меняет следующий snapshot и других клиентов', () => {
  const { registry, spawn } = setup()
  registry.subscribe(event => {
    if (event.type === 'changed') { event.terminals[0].label = 'изменено'; event.terminals.length = 0 }
  })
  let label: string | undefined
  registry.subscribe(event => { if (event.type === 'changed') label = event.terminals[0].label })
  spawn()
  assert.equal(label, 'Задача')
  assert.equal(registry.listTerminals()[0].label, 'Задача')
})

it('tail ограничен и snapshot содержит последние 200 строк', () => {
  const { registry, ports, spawn } = setup()
  const id = spawn()
  ports[0].output('old' + 'x'.repeat(256 * 1024))
  assert.equal(registry.ptyTail(id).length, 256 * 1024)
  assert.equal(registry.ptyTail(id).startsWith('old'), false)
  ports[0].output('\n' + Array.from({ length: 300 }, (_, i) => `line-${i}`).join('\n'))
  const tail = registry.terminalSnapshots()[0].tail.split('\n')
  assert.equal(tail.length, 200)
  assert.equal(tail[0], 'line-100')
  assert.equal(tail.at(-1), 'line-299')
})

it('при естественном выходе exit предшествует изменению реестра', () => {
  const { registry, ports, spawn } = setup()
  const events: SessionEvent[] = []
  registry.subscribe(event => events.push(event))
  let exited: [string, number] | undefined
  const id = spawn({}, (ptyId, code) => { exited = [ptyId, code] })
  events.length = 0
  ports[0].finish(8)
  assert.deepEqual(events, [{ type: 'exit', ptyId: id, exitCode: 8 }, { type: 'changed', terminals: [] }])
  assert.deepEqual(exited, [id, 8])
  assert.equal(registry.isAlive(id), false)
})

it('команда из observer доставляет вложенные изменения после исходного события всем клиентам', () => {
  const { registry, spawn } = setup()
  registry.subscribe(event => {
    if (event.type === 'changed' && event.terminals.length) registry.killPty(event.terminals[0].ptyId)
  })
  const snapshots: string[][] = []
  registry.subscribe(event => { if (event.type === 'changed') snapshots.push(event.terminals.map(info => info.ptyId)) })
  const id = spawn()
  assert.deepEqual(snapshots, [[id], []])
  assert.deepEqual(registry.listTerminals(), [])
})

it('немедленный kill из первого changed не теряет синхронный exit и callback запуска', () => {
  const proc = new TestPty()
  proc.killExitCode = 9
  const registry = createSessionRegistry({ spawn: () => proc })
  registry.subscribe(event => {
    if (event.type === 'changed' && event.terminals.length) registry.killPty(event.terminals[0].ptyId)
  })
  const events: SessionEvent[] = []
  registry.subscribe(event => events.push(event))
  let exited: [string, number] | undefined
  const id = registry.spawnPty({ command: 'agent', cols: 80, rows: 24, meta: { role: 'shell', label: 'shell' } },
    (ptyId, code) => { exited = [ptyId, code] })
  assert.deepEqual(exited, [id, 9])
  assert.deepEqual(events.map(event => event.type), ['changed', 'changed', 'exit'])
  assert.deepEqual(registry.listTerminals(), [])
})

it('kill немедленно удаляет запись; поздний exit не дублирует changed', () => {
  const { registry, ports, spawn } = setup()
  const events: SessionEvent[] = []
  registry.subscribe(event => events.push(event))
  const id = spawn()
  events.length = 0
  registry.killPty(id)
  assert.equal(ports[0].killed, true)
  assert.deepEqual(registry.listTerminals(), [])
  ports[0].finish(0)
  assert.deepEqual(events, [{ type: 'changed', terminals: [] }, { type: 'exit', ptyId: id, exitCode: 0 }])
})

it('before запускает main в том же терминале с последним размером даже после nonzero exit', () => {
  const { registry, ports, starts, spawn } = setup()
  const id = spawn({ before: { command: 'setup', args: 'готовая строка' } })
  registry.resizePty(id, 120, 40)
  ports[0].output('setup\n')
  ports[0].finish(3)
  assert.equal(starts.length, 2)
  assert.equal(starts[0].command, 'setup')
  assert.equal(starts[0].args, 'готовая строка')
  assert.equal(starts[1].command, 'agent')
  assert.deepEqual(starts[1].args, ['task'])
  assert.equal(starts[1].options.cols, 120)
  assert.equal(starts[1].options.rows, 40)
  assert.equal(registry.listTerminals()[0].ptyId, id)
  registry.writePty(id, 'input')
  assert.deepEqual(ports[1].writes, ['input'])
  ports[1].output('main')
  assert.equal(registry.ptyTail(id), 'setup\nmain')
})

it('kill во время before не запускает main', () => {
  const { registry, ports, starts, spawn } = setup()
  const id = spawn({ before: { command: 'setup', args: [] } })
  registry.killPty(id)
  ports[0].finish(0)
  assert.equal(starts.length, 1)
  assert.equal(registry.isAlive(id), false)
})

it('ошибка spawn основной команды публикуется и завершает терминал', () => {
  const proc = new TestPty()
  let started = false
  const registry = createSessionRegistry({ spawn: () => {
    if (started) throw new Error('spawn failed')
    started = true
    return proc
  } })
  const events: SessionEvent[] = []
  registry.subscribe(event => events.push(event))
  const id = registry.spawnPty({ command: 'agent', cols: 80, rows: 24, meta: { role: 'shell', label: 'shell' }, before: { command: 'setup', args: [] } })
  events.length = 0
  proc.finish(0)
  assert.equal(events[0].type, 'data')
  if (events[0].type === 'data') assert.match(events[0].data, /agent: spawn failed/)
  assert.deepEqual(events.slice(1), [{ type: 'exit', ptyId: id, exitCode: 0 }, { type: 'changed', terminals: [] }])
  assert.equal(registry.isAlive(id), false)
})

it('ошибка начального spawn не создаёт запись', () => {
  const registry = createSessionRegistry({ spawn: () => { throw new Error('spawn failed') } })
  assert.throws(() => registry.spawnPty({ command: 'agent', cols: 80, rows: 24, meta: { role: 'shell', label: 'shell' } }), /spawn failed/)
  assert.deepEqual(registry.listTerminals(), [])
})

it('исключение observer и его logger не мешает другим подпискам и выходу', () => {
  const failure = new Error('disconnected')
  const observed: unknown[] = []
  const { registry, ports, spawn } = setup(error => { observed.push(error); throw new Error('logger') })
  registry.subscribe(() => { throw failure })
  const events: SessionEvent[] = []
  registry.subscribe(event => events.push(event))
  const id = spawn()
  ports[0].output('text')
  assert.equal(registry.ptyTail(id), 'text')
  ports[0].finish(0)
  assert.deepEqual(events.map(event => event.type), ['changed', 'data', 'exit', 'changed'])
  assert.deepEqual(observed, [failure, failure, failure, failure])
  assert.equal(registry.isAlive(id), false)
})

it('независимые реестры не завершают чужие процессы через killAll', () => {
  const one = setup()
  const two = setup()
  const idOne = one.spawn()
  const idTwo = two.spawn()
  one.registry.killAll()
  assert.equal(one.registry.isAlive(idOne), false)
  assert.equal(two.registry.isAlive(idTwo), true)
  assert.equal(two.ports[0].killed, false)
})

it('ввод меняет активность, просмотр нет; resize соблюдает минимальный размер', t => {
  let time = 100
  t.mock.method(Date, 'now', () => time)
  const { registry, ports, spawn } = setup()
  const id = spawn()
  time = 200
  registry.terminalSnapshots()
  assert.equal(registry.lastActivityAt(id), 100)
  assert.equal(registry.silentFor(id), 100)
  registry.writePty(id, 'x')
  assert.equal(registry.lastActivityAt(id), 200)
  assert.equal(registry.silentFor(id), 100)
  registry.resizePty(id, -4, 0)
  assert.deepEqual(ports[0].sizes, [[2, 1]])
  time = 250
  ports[0].output('out')
  assert.equal(registry.lastActivityAt(id), 250)
  registry.killPty(id)
  assert.equal(registry.lastActivityAt(id), undefined)
  assert.equal(registry.silentFor(id), 0)
  assert.doesNotThrow(() => { registry.writePty(id, 'x'); registry.resizePty(id, 10, 10); registry.killPty(id) })
})

it('очищает служебное окружение Claude и накладывает env вызова', () => {
  const keys = ['CLAUDE_CODE_TEST', 'CLAUDECODE']
  const old = keys.map(key => process.env[key])
  try {
    for (const key of keys) process.env[key] = 'parent'
    const { starts, spawn } = setup()
    spawn({ env: { ORCA_PROJECT: 'p' } })
    assert.equal(starts[0].options.env.CLAUDE_CODE_TEST, undefined)
    assert.equal(starts[0].options.env.CLAUDECODE, undefined)
    assert.equal(starts[0].options.env.ORCA_PROJECT, 'p')
    assert.equal(starts[0].options.cwd, '/project')
    assert.equal(starts[0].options.name, 'xterm-256color')
  } finally {
    keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i] })
  }
})
