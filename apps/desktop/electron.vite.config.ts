import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
// Описание установленной версии доступно без сети, в том числе в portable. Отсутствующие notes ломают сборку.
const releaseNotes = readFileSync(resolve(__dirname, `../../docs/releases/v${version}.md`), 'utf8').trim()
if (!releaseNotes) throw new Error(`Описание релиза v${version} пустое`)

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
    define: {
      __ORCA_UPDATES_PREVIEW__: JSON.stringify(process.env.ORCA_UPDATES_PREVIEW === '1'),
      __ORCA_CURRENT_RELEASE__: JSON.stringify({ version, releaseNotes })
    },
    plugins: [react()],
    resolve: { alias: { '@orca-board/core': resolve(__dirname, '../../packages/core/src/index.ts') } }
  }
})
