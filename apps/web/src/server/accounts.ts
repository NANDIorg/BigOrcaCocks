import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { createPrivateJson, replacePrivateJson, readPrivateJson, record } from './private-json.ts'
import { mkdir, rmdir } from 'node:fs/promises'

export interface WebAccount {
  id: string
  login: string
  password: { algorithm: 'scrypt'; salt: string; hash: string; N: 32768; r: 8; p: 1; keyLength: 64 }
}
const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export function validWebPassword(password: unknown): password is string {
  return typeof password === 'string' && Array.from(password).length >= 12 && Buffer.byteLength(password, 'utf8') <= 256
}
function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, parameters, (error, key) => error ? reject(error) : resolve(key)))
}
export async function createWebAccount(login: string, password: string): Promise<WebAccount> {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)) throw new Error('Логин: 3–64 строчных латинских символа, цифры, точка, дефис или подчёркивание')
  if (!validWebPassword(password)) throw new Error('Пароль: минимум 12 символов, максимум 256 байт UTF-8')
  const salt = randomBytes(16); const hash = await derive(password, salt)
  return { id: randomUUID(), login, password: { algorithm: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64'), N: 32768, r: 8, p: 1, keyLength: 64 } }
}
export async function verifyWebPassword(account: WebAccount, password: string): Promise<boolean> {
  if (!validWebPassword(password)) return false
  const key = await derive(password, Buffer.from(account.password.salt, 'base64'))
  const stored = Buffer.from(account.password.hash, 'base64')
  return stored.length === key.length && timingSafeEqual(stored, key)
}
export async function loadWebAccounts(file: string): Promise<readonly WebAccount[]> {
  const raw = await readPrivateJson(file, 64 * 1024)
  if (!record(raw) || raw.schemaVersion !== 1 || Object.keys(raw).some(key => !['schemaVersion', 'accounts'].includes(key)) || !Array.isArray(raw.accounts) || !raw.accounts.length || raw.accounts.length > 16) throw new Error('Неподдерживаемый файл аккаунтов Web')
  const ids = new Set<string>(); const logins = new Set<string>()
  return raw.accounts.map((value: unknown): WebAccount => {
    if (!record(value) || Object.keys(value).some(key => !['id', 'login', 'password'].includes(key)) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.login !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.login) || !record(value.password)) throw new Error('Некорректный аккаунт Web')
    const hash = value.password
    const canonical = (text: unknown, length: number) => typeof text === 'string' && Buffer.from(text, 'base64').length === length && Buffer.from(text, 'base64').toString('base64') === text
    if (Object.keys(hash).some(key => !['algorithm', 'salt', 'hash', 'N', 'r', 'p', 'keyLength'].includes(key)) || hash.algorithm !== 'scrypt' || hash.N !== 32768 || hash.r !== 8 || hash.p !== 1 || hash.keyLength !== 64 || !canonical(hash.salt, 16) || !canonical(hash.hash, 64) || ids.has(value.id) || logins.has(value.login)) throw new Error('Некорректная password запись Web')
    ids.add(value.id); logins.add(value.login)
    return value as unknown as WebAccount
  })
}
export async function initializeWebAccount(options: { configDir: string; login: string; password: string }): Promise<void> {
  const account = await createWebAccount(options.login, options.password)
  await createPrivateJson(join(options.configDir, 'accounts.json'), { schemaVersion: 1, accounts: [account] })
}
export async function addWebAccount(options: { configDir: string; login: string; password: string }): Promise<void> {
  const account = await createWebAccount(options.login, options.password)
  const lock = join(options.configDir, '.accounts-lock'); await mkdir(lock, { mode: 0o700 })
  try {
    const file = join(options.configDir, 'accounts.json'); const accounts = await loadWebAccounts(file)
    if (accounts.length >= 16 || accounts.some(value => value.login === account.login)) throw new Error('Логин занят или достигнут лимит аккаунтов')
    await replacePrivateJson(file, { schemaVersion: 1, accounts: [...accounts, account] })
  } finally { await rmdir(lock) }
}
