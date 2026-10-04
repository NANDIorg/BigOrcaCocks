import { build } from 'esbuild'
import { mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url)); const out = join(root, 'dist')
// Удаляем только собственный build output: installed artifact не содержит старых chunks.
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
await build({ entryPoints: { index: join(root, 'src/index.ts'), start: join(root, 'src/start.ts') }, outdir: out, bundle: true, splitting: true, banner: { js: '#!/usr/bin/env node' },
  format: 'esm', platform: 'node', target: 'node24', outExtension: { '.js': '.mjs' }, packages: 'bundle', external: ['node-pty'], metafile: true,
  plugins: [{ name: 'host-boundaries', setup(builder) { builder.onResolve({ filter: /^electron(?:\/|$)/ }, args => ({ errors: [{ text: `Headless не импортирует ${args.path}` }] })) } }] }).then(result => writeFileSync(join(out, 'build-meta.json'), JSON.stringify(result.metafile)))
cpSync(join(root, '../../skills'), join(out, 'skills'), { recursive: true })
cpSync(join(root, '../../packages/cli/bin'), join(out, 'cli'), { recursive: true })
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: source.name, version: source.version, type: 'module', engines: { node: '24.x' },
  main: 'index.mjs', exports: './index.mjs', bin: { 'orca-runtime': 'start.mjs' }, dependencies: { 'node-pty': '1.1.0' } }, null, 2))
