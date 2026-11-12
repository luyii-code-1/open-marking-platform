import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../src/Button.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
const module = { exports: {} }
new Function('require', 'exports', 'module', outputText)(require, module.exports, module)
const { Button } = module.exports
const { SaveOutlined } = require('@ant-design/icons')
for (const props of [
  { block: true, size: 'large', type: 'primary', children: '登录' },
  { children: '保存草稿', icon: React.createElement(SaveOutlined) },
  { children: '下一题', iconPosition: 'end' },
  { icon: React.createElement(SaveOutlined), 'aria-label': '保存' },
]) {
  const markup = renderToStaticMarkup(React.createElement(Button, { ...props, loading: true }))
  assert.match(markup, /ant-btn-loading/)
  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /ant-btn-icon ant-btn-loading-icon/)
  assert.match(markup, /<svg[^>]+data-icon="loading"/)
  if (props.children) assert.ok(markup.replace(/<[^>]+>/g, '').replace(/\s/g, '').includes(props.children), 'The accessible label stays in the button')
}
const css = await readFile(new URL('../src/ui.css', import.meta.url), 'utf8')
const spinner = css.match(/\.ant-btn\.ant-btn-loading>\.ant-btn-icon\{([^}]+)\}/)?.[1]
assert.ok(spinner, 'All Ant Design loading icon wrappers must use the same positioning')
for (const declaration of ['position:absolute!important', 'inset:0!important', 'display:grid!important', 'place-items:center', 'transform:none!important', 'opacity:1!important']) assert.ok(spinner.includes(declaration), declaration)
assert.ok(!spinner.includes('translate('), 'CSSMotion scale transforms must not replace a centering translation')

async function checkIcons(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), folder)
    if (entry.isDirectory()) { await checkIcons(path); continue }
    if (!/\.(tsx?|css|svg|json|webmanifest|html)$/.test(entry.name)) continue
    const text = await readFile(path, 'utf8')
    assert.ok(!/\p{Extended_Pictographic}|[\uFE0F\u20E3\u{1F1E6}-\u{1F1FF}]/u.test(text), `Use SVG library icons instead of emoji: ${path.pathname}`)
    if (entry.name.endsWith('.tsx')) assert.ok(!/[⋯☰▶◀→←↻]/u.test(text), `Use SVG library icons instead of graphical characters: ${path.pathname}`)
  }
}
await checkIcons(new URL('../src/', import.meta.url))
await checkIcons(new URL('../public/', import.meta.url))
console.log('Icons passed: loading button SVG/labels, motion-safe centering, front-end emoji and graphical character checks')
