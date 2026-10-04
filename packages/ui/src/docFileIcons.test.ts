import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docFileIconOf } from './docFileIcons'

test('исходники получают значок своего языка, включая Swift, JSX и TSX', () => {
  for (const [path, logo] of [
    ['src/Screen.SWIFT', 'swift'], ['C:\\repo\\main.ts', 'typescript'], ['index.mts', 'typescript'],
    ['main.js', 'javascript'], ['App.tsx', 'react'], ['App.jsx', 'react'],
    ['main.py', 'python'], ['main.rs', 'rust'], ['main.go', 'go'], ['Main.java', 'java'],
    ['Main.kt', 'kotlin'], ['main.dart', 'dart'], ['main.c', 'c'], ['main.cpp', 'cplusplus'],
    ['main.cs', 'csharp'], ['main.fs', 'fsharp'], ['main.rb', 'ruby'], ['main.php', 'php'],
    ['main.lua', 'lua'], ['main.r', 'r'], ['main.ex', 'elixir'], ['main.erl', 'erlang'],
    ['main.hs', 'haskell'], ['main.clj', 'clojure'], ['main.scala', 'scala'],
    ['main.zig', 'zig'], ['main.nim', 'nim'], ['main.nix', 'nixos'], ['main.tf', 'terraform'],
    ['schema.graphql', 'graphql'], ['main.groovy', 'groovy'], ['build.gradle', 'gradle']
  ]) assert.deepEqual(docFileIconOf(path), { kind: 'code', logo }, path)
})

test('разметка, стили и конфиги имеют узнаваемые значки', () => {
  for (const [path, kind, logo] of [
    ['index.html', 'html', 'html5'], ['README.md', 'doc', 'markdown'],
    ['style.css', 'code', 'css3'], ['style.scss', 'code', 'sass'], ['style.less', 'code', 'less'],
    ['config.jsonc', 'config', 'json'], ['config.yaml', 'config', 'yaml'],
    ['Component.vue', 'code', 'vuejs'], ['Component.svelte', 'code', 'svelte'], ['Page.astro', 'code', 'astro'],
    ['script.ps1', 'code', 'powershell'], ['Dockerfile.dev', 'code', 'docker']
  ]) assert.deepEqual(docFileIconOf(path), { kind, logo }, path)
  assert.deepEqual(docFileIconOf('config.toml'), { kind: 'config' })
  assert.deepEqual(docFileIconOf('.env.local'), { kind: 'env' })
})

test('имена служебных файлов уточняют значок раньше расширения', () => {
  for (const [path, kind, logo] of [
    ['package.json', 'config', 'nodejs'], ['package-lock.json', 'config', 'npm'],
    ['pnpm-lock.yaml', 'config', 'pnpm'], ['yarn.lock', 'text', 'yarn'],
    ['Cargo.toml', 'config', 'rust'], ['Cargo.lock', 'text', 'rust'],
    ['.gitignore', 'config', 'git'], ['.gitattributes', 'config', 'git'], ['.gitmodules', 'config', 'git'],
    ['docker-compose.yml', 'config', 'docker'], ['compose.yaml', 'config', 'docker'],
    ['folder/Podfile', 'code', 'ruby']
  ]) assert.deepEqual(docFileIconOf(path), { kind, logo }, path)
})

test('архивы, медиа, шрифты, таблицы и базы отличаются от общего бинарного файла', () => {
  for (const [path, kind, glyph] of [
    ['backup.tar.gz', 'binary', 'archive'], ['package.zip', 'binary', 'archive'],
    ['sound.mp3', 'binary', 'audio'], ['movie.mp4', 'binary', 'video'],
    ['font.woff2', 'binary', 'font'], ['data.sqlite', 'binary', 'database'],
    ['query.sql', 'code', 'database'], ['export.csv', 'code', 'table'],
    ['script.zsh', 'code', 'terminal'], ['.bashrc', 'code', 'terminal'], ['change.patch', 'code', 'diff']
  ]) assert.deepEqual(docFileIconOf(path), { kind, glyph }, path)
})

test('уточнённый main вид важнее расширения; неизвестные файлы сохраняют общий значок', () => {
  assert.deepEqual(docFileIconOf('main.swift', 'binary'), { kind: 'binary' })
  assert.deepEqual(docFileIconOf('main.py', 'image'), { kind: 'image' })
  assert.deepEqual(docFileIconOf('bin/run', 'text'), { kind: 'text' })
  assert.deepEqual(docFileIconOf('icon.svg'), { kind: 'image' })
  assert.deepEqual(docFileIconOf('document.pdf'), { kind: 'pdf' })
  for (const path of ['notes.txt', 'LICENSE']) assert.deepEqual(docFileIconOf(path), { kind: 'text' })
  for (const path of ['dir.swift/file.unknown', 'constructor', '__proto__']) assert.deepEqual(docFileIconOf(path), { kind: 'file' })
})
