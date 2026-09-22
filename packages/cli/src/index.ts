#!/usr/bin/env node
/**
 * orca-board — тонкий клиент к unix-сокету приложения.
 * Вызывается агентами из их Bash. Состоянием владеет приложение.
 *
 * Пока заглушка: разбирает команду и печатает JSON-запрос, который
 * будет отправлен в сокет. Транспорт добавим следующим шагом.
 */
const [command, sub, ...rest] = process.argv.slice(2)

const args: Record<string, string | boolean> = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  const next = rest[i + 1]
  if (next && !next.startsWith('--')) {
    args[key] = next
    i++
  } else {
    args[key] = true
  }
}

const request = { method: `${command}.${sub}`, params: args, dispatchId: process.env.ORCA_DISPATCH_ID }
process.stdout.write(JSON.stringify(request, null, 2) + '\n')
