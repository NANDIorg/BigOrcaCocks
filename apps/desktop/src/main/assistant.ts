// Чистые функции ассистента доски — без electron, чтобы их можно было проверить node:test.

export interface AssistantEnvInput {
  socketPath: string
  /** PATH с bin CLI (`workerPath()`). */
  path: string
  /** Node из Electron для обёртки orca-board в собранном приложении; undefined — внешний node. */
  nodePath?: string
}

/**
 * Окружение ассистента. Ассистент один на всё приложение, поэтому `ORCA_PROJECT` нет: проект он называет
 * явно (`--project`), а без флага CLI берёт активный в UI. `ORCA_RUN_ID` тоже нет — прогона у ассистента нет.
 */
export function assistantEnv(input: AssistantEnvInput): Record<string, string> {
  return {
    ...(input.nodePath ? { ORCA_NODE: input.nodePath } : {}),
    ORCA_SOCKET: input.socketPath,
    PATH: input.path,
    ORCA_ROLE: 'assistant'
  }
}
