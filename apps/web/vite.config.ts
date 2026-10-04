import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
export default defineConfig({ plugins: [react()], define: { __ORCA_VERSION__: JSON.stringify(manifest.version) }, root: resolve(import.meta.dirname, 'src/browser'), build: { outDir: resolve(import.meta.dirname, 'dist/browser'), emptyOutDir: true } })
