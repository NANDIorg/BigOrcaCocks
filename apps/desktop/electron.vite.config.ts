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
    plugins: [react()],
    resolve: { alias: { '@orca-board/core': resolve(__dirname, '../../packages/core/src/index.ts') } }
  }
})
