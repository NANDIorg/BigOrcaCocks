import { build } from 'esbuild'
import { mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url)); const out = join(root, 'dist')
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
// Inquirer → mute-stream использует CommonJS require('stream') внутри ESM chunk.
const result = await build({ entryPoints: { index: join(root, 'src/server/index.ts'), control: join(root, 'src/server/control.ts'), admin: join(root, 'src/server/admin.ts') }, outdir: out,
  bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', outExtension: { '.js': '.mjs' }, packages: 'bundle', external: ['node-pty'], metafile: true,
  banner: { js: "import { createRequire as __orcaBundleRequire } from 'node:module'; const require = __orcaBundleRequire(import.meta.url);" },
  plugins: [{ name: 'web-host-boundaries', setup(builder) { builder.onResolve({ filter: /^electron(?:\/|$)/ }, args => ({ errors: [{ text: `Web не импортирует ${args.path}` }] })) } }] })
writeFileSync(join(out, 'build-meta.json'), JSON.stringify(result.metafile))
cpSync(join(root, '../../skills'), join(out, 'skills'), { recursive: true })
cpSync(join(root, '../../packages/cli/bin'), join(out, 'cli'), { recursive: true })
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: source.name, version: source.version, type: 'module', engines: { node: '24.x' }, main: 'index.mjs', exports: './index.mjs',
  bin: { 'orca-web': 'control.mjs' }, dependencies: { 'node-pty': '1.1.0' } }, null, 2))
