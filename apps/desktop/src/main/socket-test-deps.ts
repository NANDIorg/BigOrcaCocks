import type { ProjectDeps, SocketDeps } from './socket'

/**
 * Заглушки для полей `ProjectDeps`/`SocketDeps` про настройки (docs/assistant-chat.md → «2. Контракт CLI/сокета»),
 * которых не касаются тесты сокета не про настройки (worker/stage/rules) — держать их контракт в актуальном
 * состоянии вручную было бы лишним, а без заглушек `fakeDeps()` там не проходит typecheck. Реальное поведение
 * этих методов проверяет socket-settings.test.ts.
 */
export const NOT_NEEDED_SETTINGS_DEPS: Pick<
  ProjectDeps,
  | 'typesCreate'
  | 'typesRename'
  | 'typesSetDefault'
  | 'typesDuplicate'
  | 'typesUsage'
  | 'typesDelete'
  | 'rolesAdd'
  | 'rolesUpdate'
  | 'rolesRemove'
  | 'permissionMode'
  | 'setPermissionMode'
  | 'nodeTemplates'
  | 'deleteNodeTemplate'
  | 'setActive'
  | 'removeProject'
  | 'setEnabledAgents'
  | 'setColumns'
  | 'setProjectTaskTypes'
  | 'projectRulesGet'
  | 'projectRulesSet'
> = {
  typesCreate: () => { throw new Error('не нужен') },
  typesRename: () => { throw new Error('не нужен') },
  typesSetDefault: () => { throw new Error('не нужен') },
  typesDuplicate: () => { throw new Error('не нужен') },
  typesUsage: () => { throw new Error('не нужен') },
  typesDelete: () => { throw new Error('не нужен') },
  rolesAdd: () => { throw new Error('не нужен') },
  rolesUpdate: () => { throw new Error('не нужен') },
  rolesRemove: () => { throw new Error('не нужен') },
  permissionMode: () => { throw new Error('не нужен') },
  setPermissionMode: () => { throw new Error('не нужен') },
  nodeTemplates: () => { throw new Error('не нужен') },
  deleteNodeTemplate: () => { throw new Error('не нужен') },
  setActive: () => { throw new Error('не нужен') },
  removeProject: () => { throw new Error('не нужен') },
  setEnabledAgents: () => { throw new Error('не нужен') },
  setColumns: () => { throw new Error('не нужен') },
  setProjectTaskTypes: () => { throw new Error('не нужен') },
  projectRulesGet: () => { throw new Error('не нужен') },
  projectRulesSet: () => { throw new Error('не нужен') }
}

/** Заглушки для `SocketDeps.settings`/`setSettings` — см. `NOT_NEEDED_SETTINGS_DEPS`. */
export const NOT_NEEDED_APP_SETTINGS_DEPS: Pick<SocketDeps, 'settings' | 'setSettings'> = {
  settings: () => { throw new Error('не нужен') },
  setSettings: () => { throw new Error('не нужен') }
}
