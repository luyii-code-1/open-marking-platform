import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2] || fileURLToPath(new URL('../dist/', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(dir, '.vite/manifest.json'), 'utf8'))
function entry(parent, name) {
  const key = manifest[parent].dynamicImports?.find(key => manifest[key].name === name)
  assert.ok(key, `${name} must be a separate dynamic import of ${parent}`)
  return key
}
function staticTree(key, seen = new Set()) {
  if (!seen.has(key)) {
    seen.add(key)
    for (const child of manifest[key].imports || []) staticTree(child, seen)
  }
  return seen
}

const main = entry('index.html', 'main')
const workspace = entry(main, 'AuthenticatedApp')
const core = staticTree(main, staticTree('index.html'))
assert.ok(!core.has(workspace))
const authenticated = staticTree(workspace)
for (const name of ['Dashboard', 'ScannerDesk', 'Exams', 'ReviewTasks', 'Marking', 'Results', 'Personnel', 'Account', 'HttpGuard']) {
  const route = entry(workspace, name)
  assert.ok(!authenticated.has(route), name + ' must load on navigation')
}
const exams = entry(workspace, 'Exams')
assert.ok(!staticTree(exams).has(entry(exams, 'TemplateEditor')))
const coreFiles = new Set([...core].flatMap(key => [manifest[key].file, ...(manifest[key].css || [])]))
assert.ok(![...coreFiles].some(file => /(?:uiTheme|AuthenticatedApp|TemplateEditor|\/scanner-)/.test(file)))
let bytes = 0
for (const file of coreFiles) bytes += gzipSync(await readFile(path.join(dir, file))).length
assert.ok(bytes < 125_000, `Anonymous login JS and CSS grew to ${bytes} gzip bytes`)
console.log(`Anonymous login and startup use ${coreFiles.size} assets (${bytes} gzip bytes). Workspace routes and the template editor load on demand.`)
