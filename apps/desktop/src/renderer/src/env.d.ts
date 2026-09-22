/** SVG-логотипы агентов импортируются как строки (Vite `?raw`). */
declare module '*.svg?raw' {
  const content: string
  export default content
}
