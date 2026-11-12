import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/pendingAction.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { PendingAction } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

const action = new PendingAction(), events = []
let complete, calls = 0
const pending = action.run('download:project-a', () => { calls++; return new Promise(resolve => { complete = resolve }) }, key => events.push(key))
const buttons = ['download:project-a', 'download:project-b', 'connect', 'createBatch']
assert.deepEqual(buttons.filter(key => key === action.key), ['download:project-a'])
await action.run('download:project-a', async () => { calls++ }, key => events.push(key))
await action.run('download:project-b', async () => { calls++ }, key => events.push(key))
assert.equal(calls, 1, 'Repeated clicks must not send a second command while the operation owns the controls')
const independent = new PendingAction()
assert.equal(await independent.run('save-profile', async () => 'saved', () => {}), 'saved')
assert.equal(action.key, 'download:project-a', 'Another section must not clear the active row')
complete('downloaded')
assert.equal(await pending, 'downloaded')
assert.deepEqual(events, ['download:project-a', null])
assert.equal(action.key, null)
await assert.rejects(action.run('publish', async () => { throw new Error('network') }, key => events.push(key)), /network/)
assert.equal(action.key, null, 'A failed operation must release its loading state')
assert.equal(await action.run('save-draft', async () => 'draft', key => events.push(key)), 'draft')
assert.deepEqual(events.slice(2), ['publish', null, 'save-draft', null])
console.log('Action state passed: row isolation, duplicate submission guard, independent sections, failure cleanup and retry')
