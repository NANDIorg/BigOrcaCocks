/**
 * Путь сокета приложения для CLI: $ORCA_SOCKET, иначе на Windows — именованный канал
 * (Node net принимает его и в listen, и в connect), иначе unix-сокет ~/.orca-board/orca.sock.
 * Чистая функция без node-импортов: core импортирует и renderer. Окружение передаёт вызывающий.
 * Та же логика продублирована в packages/cli/bin/orca-board.js — менять синхронно.
 */
export function defaultSocketPath(opts: {
  env: Record<string, string | undefined>
  platform: string
  homedir: string
}): string {
  const { env, platform, homedir } = opts
  if (env.ORCA_SOCKET !== undefined) return env.ORCA_SOCKET
  if (platform === 'win32') return '\\\\.\\pipe\\orca-board'
  return `${homedir.replace(/\/+$/, '')}/.orca-board/orca.sock`
}
