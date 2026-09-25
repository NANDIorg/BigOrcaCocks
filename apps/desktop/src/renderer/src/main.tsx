import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { initLocale, useLocale } from './i18n'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// Язык — до первого рендера (кэш / система), затем из настроек main. Старый preload без app — язык системы.
initLocale(window.orca?.app)

/**
 * Смена языка перерисовывает всё дерево: App создаётся заново при каждом рендере корня, поэтому
 * обновятся и компоненты, которые берут строки через `t()` / хелперы форматирования, а не `useT()`.
 */
function Root(): React.JSX.Element {
  useLocale()
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
