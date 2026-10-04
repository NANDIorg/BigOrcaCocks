import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { isAbsolute } from 'node:path'
import { initializeWebAccount } from './accounts.ts'
import { readPassword } from './password.ts'

const configDir = process.argv[2]
if (!configDir || !isAbsolute(configDir)) throw new Error('Укажите абсолютный каталог конфигурации Web')
if (!stdin.isTTY || !stdout.isTTY) throw new Error('Инициализация аккаунта выполняется в интерактивном терминале')
const readline = createInterface({ input: stdin, output: stdout })
const login = await readline.question('Логин первого оператора: '); readline.close()
const password = await readPassword('Пароль (не отображается): ')
const confirmation = await readPassword('Повторите пароль: ')
if (password !== confirmation) throw new Error('Пароли не совпадают')
await initializeWebAccount({ configDir, login, password })
stdout.write('Первый аккаунт Web создан.\n')
