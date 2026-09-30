import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@orca-board/core'] })],
    resolve: { alias: { '@orca-board/core': resolve(__dirname, '../../packages/core/src/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // Временный просмотр обновлений включается только явно при локальной сборке; обычный билд использует main.
    define: { __ORCA_UPDATES_PREVIEW__: JSON.stringify(process.env.ORCA_UPDATES_PREVIEW === '1') },
    plugins: [react()],
    resolve: { alias: { '@orca-board/core': resolve(__dirname, '../../packages/core/src/index.ts') } }
  }
})
