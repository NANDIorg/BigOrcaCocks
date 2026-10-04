import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { initLocale, useLocale } from './i18n'
import { appFontFamily } from '../shared/theme'
import { appearance } from './appearance'
import { initWindowChrome, type WindowControlsOverlay } from './windowChrome'
import { configureUiHost, getUiApi } from './host'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

function Root(): React.JSX.Element { useLocale(); return <App /> }
/** Entry point Desktop/Web получает client/platform; цвета и компоненты имеют одного владельца. */
export function mountOrcaUi(element: HTMLElement, host: Parameters<typeof configureUiHost>[0]): () => void {
  configureUiHost(host)
  document.documentElement.style.setProperty('--font-sans', appFontFamily)
  appearance.start(getUiApi()?.app)
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
  const disposeChrome = initWindowChrome(getUiApi()?.app?.windowChrome, document.documentElement, overlay, getUiApi()?.app?.onWindowFullscreen)
  initLocale(getUiApi()?.app)
  const root = ReactDOM.createRoot(element)
  root.render(<React.StrictMode><Root /></React.StrictMode>)
  return () => { appearance.dispose(); disposeChrome(); root.unmount() }
}
