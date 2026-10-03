export interface PtySpawnOptions {
  cwd?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cols: number
  rows: number
  /** Проект терминала из UI: регистрируется в реестре как role=shell с этим проектом. */
  projectId?: string
  /** Подпись вкладки терминала из UI. */
  label?: string
}

export type TerminalRole = 'coordinator' | 'worker' | 'assistant' | 'shell'

/** Живой PTY в реестре main (src/main/pty.ts). Источник правды для вкладок «Терминалы». */
export interface TerminalInfo {
  ptyId: string
  label: string
  role: TerminalRole
  taskId?: string
  projectId?: string
  /** Прогон, который открыл этого координатора. */
  runId?: string
  createdAt: number
}

/** Элемент terminals:list: реестр + хвост вывода (последние ~200 строк без ANSI) для восстановления вкладки после перезагрузки окна. */
export interface TerminalSnapshot extends TerminalInfo {
  tail: string
}
