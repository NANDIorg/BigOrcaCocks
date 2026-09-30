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
