import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/httpGuardData.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { selectedSources, checkedLogRows } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))
const first = [{ id: 9, ip: '192.0.2.4' }, { id: 8, ip: '2001:db8::2' }, { id: 7, ip: '' }]
const second = [{ id: 5, ip: '192.0.2.4' }, { id: 4, ip: '192.0.2.5' }]
const pageOne = checkedLogRows([], first, [9, 8, 7])
assert.deepEqual(pageOne, first.slice(0, 2))
const both = checkedLogRows(pageOne, second, [9, 8, 5, 4])
assert.equal(both.length, 4)
assert.deepEqual(selectedSources(both), [first[0], first[1], second[1]])
const unchecked = checkedLogRows(both, first, [5, 4])
assert.deepEqual(selectedSources(unchecked), second)
assert.deepEqual(checkedLogRows(both, first, []), [])
console.log('HTTP guard selection passed: pagination, exact IP deduplication, address validity, deselection')
