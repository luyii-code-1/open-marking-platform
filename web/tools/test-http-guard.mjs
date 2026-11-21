import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/httpGuardData.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { selectedSources, checkedLogRows, removeSelectedIp, formatRate, formatExpiry, summarizePerformance } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))
const first = [{ id: 9, ip: '192.0.2.4' }, { id: 8, ip: '2001:db8::2' }, { id: 7, ip: '' }]
const second = [{ id: 5, ip: '192.0.2.4' }, { id: 4, ip: '192.0.2.5' }]
const pageOne = checkedLogRows([], first, [9, 8, 7])
assert.deepEqual(pageOne, first.slice(0, 2))
const both = checkedLogRows(pageOne, second, [9, 8, 5, 4])
assert.equal(both.length, 4)
assert.deepEqual(selectedSources(both), [first[0], first[1], second[1]])
const withoutIp = removeSelectedIp(both, '192.0.2.4')
assert.deepEqual(selectedSources(withoutIp), [first[1], second[1]])
const unchecked = checkedLogRows(both, first, [5, 4])
assert.deepEqual(selectedSources(unchecked), second)
assert.deepEqual(checkedLogRows(both, first, []), [])
assert.equal(formatRate(0, 100), '0%')
assert.equal(formatRate(1, 2000), '< 0.1%')
assert.equal(formatRate(25, 200), '12.5%')
assert.equal(formatExpiry(0, 1000).label, '长期有效')
assert.equal(formatExpiry(900, 1000).expired, true)
assert.equal(formatExpiry(4600, 1000).expired, false)
const perf = summarizePerformance([
  { route: '/a', method: 'GET', requests: 100, errors: 1, avg_ms: 12, p95_ms: 40, max_ms: 80 },
  { route: '/b', method: 'POST', requests: 50, errors: 2, avg_ms: 90, p95_ms: 320, max_ms: 500 },
])
assert.equal(perf.routeCount, 2)
assert.equal(perf.totalRequests, 150)
assert.equal(perf.totalErrors, 3)
assert.equal(perf.slowest?.route, '/b')
console.log('HTTP guard selection and helpers passed: pagination, exact IP deduplication, removal, formatting, performance summary')
