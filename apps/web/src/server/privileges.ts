import { execFileSync } from 'node:child_process'

export function warnRoot(): void {
  if (process.getuid?.() === 0) process.stderr.write('Предупреждение: Orca Web и CLI-агенты работают с правами root и могут изменять любые файлы на сервере. Рекомендуется отдельный пользователь проектов.\n')
}

export function privilegedCommand(command: string, args: string[], nonInteractive = false, userId = process.getuid?.()): [string, string[]] {
  // На минимальных серверах root может не иметь sudo; ему повышение прав не требуется.
  return userId === 0 ? [command, args] : ['sudo', [...(nonInteractive ? ['-n'] : []), command, ...args]]
}

export function execPrivileged(command: string, args: string[], nonInteractive = false): void {
  const [file, arguments_] = privilegedCommand(command, args, nonInteractive)
  execFileSync(file, arguments_, { stdio: 'inherit' })
}
