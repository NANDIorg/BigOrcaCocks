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

/** Значки файлов загружаются отдельными ресурсами: CSP не разрешает data: URL. */
declare module '*.svg?no-inline' {
  const url: string
  export default url
}

/** Vite очищает подписку на геометрию окна при замене модуля в dev. */
interface ImportMeta {
  readonly hot?: import('vite/types/hot').ViteHotContext
}

