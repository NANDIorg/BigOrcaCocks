import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { initLocale, useLocale } from './i18n'
import { appFontFamily } from '../../shared/theme'
import { appearance } from './appearance'
import { initWindowChrome, type WindowControlsOverlay } from './windowChrome'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// Общие токены ставим до первого рендера, чтобы стартовое окно не мигало прежней палитрой.
document.documentElement.style.setProperty('--font-sans', appFontFamily)
appearance.start(window.orca?.app)
if (import.meta.hot) import.meta.hot.dispose(() => appearance.dispose())

// До первого рендера; старый main/preload сохраняет обычную компоновку.
const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
const disposeWindowChrome = initWindowChrome(window.orca?.app?.windowChrome, document.documentElement, overlay)
if (import.meta.hot) import.meta.hot.dispose(disposeWindowChrome)

// Язык — до первого рендера (кэш или русский), затем из настроек main. Старый preload без app — не падаем.
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
