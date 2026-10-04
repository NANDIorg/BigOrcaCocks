import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSyntaxBudget, highlightSyntax, syntaxLanguageOf, syntaxHtml, type SyntaxNode } from './syntaxHighlight'

function textOf(nodes: SyntaxNode[]): string {
  return nodes.map(node => typeof node === 'string' ? node : textOf(node.children)).join('')
}

function classesOf(nodes: SyntaxNode[]): string[] {
  return nodes.flatMap(node => typeof node === 'string' ? [] : [node.className, ...classesOf(node.children)])
}

test('язык определяется по расширению, точечному имени и имени без расширения', () => {
  for (const [path, expected] of [
    ['src/App.TSX', 'tsx'], ['C:\\repo\\index.jsx', 'jsx'], ['index.mts', 'typescript'],
    ['script.py', 'python'], ['main.swift', 'swift'], ['main.rs', 'rust'], ['query.sql', 'sql'],
    ['package.json', 'json'], ['settings.jsonc', 'json5'], ['config.yaml', 'yaml'],
    ['Cargo.lock', 'toml'], ['config.toml', 'toml'], ['.env.local', 'dotenv'],
    ['Dockerfile.dev', 'docker'], ['Makefile', 'makefile'], ['.gitignore', 'gitignore'],
    ['index.html', 'markup'], ['icon.svg', 'markup'], ['style.scss', 'scss'],
    ['main.tf', 'hcl'], ['schema.proto', 'protobuf'], ['README.md', 'markdown'],
    ['component.vue', 'markup'], ['component.svelte', 'markup'], ['page.astro', 'markup'],
    ['README.mdx', 'markdown'], ['.zshrc', 'bash'], ['script.fish', 'fish'], ['build.gradle', 'groovy']
  ]) assert.equal(syntaxLanguageOf(path), expected, path)
  for (const path of ['notes.txt', 'app.log', 'LICENSE', 'data.unknown', '__proto__', 'constructor']) {
    assert.equal(syntaxLanguageOf(path), undefined, path)
  }
})

test('подсвечивает разные языки, конфиги и разметку без изменения текста', () => {
  for (const [path, text, token] of [
    ['main.ts', 'const value: string = "hello";\n', 'keyword'],
    ['App.tsx', 'const App = () => <button disabled>OK</button>\n', 'tag'],
    ['main.py', 'def greet():\n    return "hello"\n', 'keyword'],
    ['main.swift', 'let value = "hello"\n', 'keyword'],
    ['main.go', 'package main\nfunc main() {}\n', 'keyword'],
    ['query.sql', 'SELECT name FROM users WHERE id = 42;\n', 'keyword'],
    ['settings.jsonc', '// comment\n{"enabled": true}\n', 'comment'],
    ['config.yaml', 'enabled: true\nport: 3000\n', 'key'],
    ['.env.local', '# comment\nPORT=3000\n', 'comment'],
    ['Dockerfile', 'FROM node:24\nRUN npm install\n', 'keyword'],
    ['README.md', '# Title\n**bold**\n', 'title'],
    ['icon.svg', '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>\n', 'tag'],
    ['style.css', '.item { color: red; }\n', 'property'],
    ['change.diff', '-removed\n+added\n', 'inserted']
  ]) {
    const nodes = highlightSyntax(text, syntaxLanguageOf(path))
    assert.equal(textOf(nodes), text, path)
    assert.ok(classesOf(nodes).some(className => className.split(' ').includes(token)), `${path}: ${token}`)
  }
})

test('сохраняет табы, пустые строки, Unicode и переводы строк для поиска и копирования', () => {
  const text = '\tconst message = "Привет 🐋 & < >";\r\n\r\n// comment\r\n'
  assert.equal(textOf(highlightSyntax(text, 'ts')), text)
})

test('язык блока Markdown принимает алиасы и игнорирует пояснение после языка', () => {
  for (const language of ['ts', 'typescript', 'TypeScript', 'ts title="example.ts"']) {
    assert.ok(classesOf(highlightSyntax('const value = 1', language)).includes('token keyword'), language)
  }
  assert.ok(classesOf(highlightSyntax('PORT=3000', 'env')).length > 0)
})

test('неизвестный язык и обычный текст показываются без подсветки', () => {
  for (const language of [undefined, 'unknown-language', 'text', 'plaintext', 'none', '__proto__', 'constructor']) {
    assert.deepEqual(highlightSyntax('<script>alert(1)</script>', language), ['<script>alert(1)</script>'])
  }
})

test('большой и минифицированный файл остаётся читаемым обычным текстом', () => {
  for (const text of ['const value = 1;\n'.repeat(20_000), `const value = "${'x'.repeat(20_000)}";`]) {
    assert.deepEqual(highlightSyntax(text, 'javascript'), [text])
  }
})

test('множество небольших блоков Markdown делит один бюджет подсветки', () => {
  const budget = createSyntaxBudget()
  const text = 'const value = { count: 42, text: "hello" };\n'.repeat(100)
  let highlighted = 0
  for (let block = 0; block < 220; block++) {
    const nodes = highlightSyntax(text, 'typescript', budget)
    assert.equal(textOf(nodes), text)
    if (classesOf(nodes).length) highlighted++
  }
  assert.ok(highlighted > 0)
  assert.ok(highlighted < 20, `${highlighted} blocks`)
})

test('слишком подробный исходник остаётся текстом даже при небольшом размере файла', () => {
  const text = 'const value = { count: 42 };\n'.repeat(2000)
  assert.deepEqual(highlightSyntax(text, 'typescript'), [text])
})

test('HTML для Markdown экранирует исходник и выводит только безопасные токены', () => {
  const source = '<script>alert("x")</script><img src=x onerror="alert(1)">'
  const html = syntaxHtml(source, 'html')
  assert.ok(html.includes('class="token'))
  assert.ok(html.includes('&lt;'))
  assert.doesNotMatch(html, /<(?!\/?span(?:\s|>))[^>]*>/)
  assert.equal(syntaxHtml('<b>&"\'</b>', 'unknown'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;')
})
