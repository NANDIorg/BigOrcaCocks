/** SVG-логотипы агентов импортируются как строки (Vite `?raw`). */
declare module '*.svg?raw' {
  const content: string
  export default content
}

/** Логотип приложения импортируется как URL, чтобы картинка работала с CSP без inline-разметки. */
declare module '*.svg' {
  const url: string
  export default url
}

/** Vite очищает подписку на геометрию окна при замене модуля в dev. */
interface ImportMeta {
  readonly hot?: import('vite/types/hot').ViteHotContext
}

/** Только проверочная сборка с ORCA_UPDATES_PREVIEW=1 содержит демонстрацию обновлений. */
declare const __ORCA_UPDATES_PREVIEW__: boolean

/** Описание установленного релиза из docs/releases вшивается в renderer при сборке. */
declare const __ORCA_CURRENT_RELEASE__: Pick<import('../../shared/ipc').UpdateInfo, 'version' | 'releaseNotes'>
