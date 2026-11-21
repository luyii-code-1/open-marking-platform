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

const timeSource = await readFile(new URL('../src/httpGuardTime.ts', import.meta.url), 'utf8')
const timeJs = ts.transpileModule(timeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { presetRange, shanghaiMinute, parseShanghaiMinute, countBuckets, trafficHash, readTrafficRange, eventsForBucket } =
  await import('data:text/javascript;base64,' + Buffer.from(timeJs).toString('base64'))
const morning = Date.parse('2026-11-21T00:07:17+08:00')
const today = presetRange('today', morning)
assert.equal(shanghaiMinute(today.start), '2026-11-21T00:00')
assert.equal(shanghaiMinute(today.end), '2026-11-21T00:08')
assert.equal(today.interval, 'hour')
assert.equal(readTrafficRange('#/http-guard/traffic', morning).metric, 'pv')
assert.deepEqual(readTrafficRange(trafficHash(today, 'uv'), morning), { range: today, metric: 'uv', error: '' })
assert.equal(readTrafficRange(trafficHash(today, 'uv'), morning + 86400000).range.preset, 'custom')
const yesterday = presetRange('yesterday', morning)
assert.equal(yesterday.end, today.start)
assert.equal(shanghaiMinute(yesterday.start), '2026-11-20T00:00')
assert.equal(countBuckets(yesterday, 'hour'), 24)
assert.equal(countBuckets(yesterday, 'day'), 1)
for (const [preset, length, first] of [['7d', 7, '2026-11-15T00:00'], ['30d', 30, '2026-10-23T00:00']]) {
  const range = presetRange(preset, morning)
  assert.equal(shanghaiMinute(range.start), first)
  assert.equal(countBuckets(range, 'day'), length)
  assert.equal(readTrafficRange(trafficHash(range, 'bytes_out'), morning).range.preset, preset)
}
const crossing = { start: parseShanghaiMinute('2026-11-20T23:59'), end: parseShanghaiMinute('2026-11-21T00:01'), preset: 'custom', interval: 'minute' }
assert.equal(countBuckets(crossing, 'minute'), 2)
assert.equal(countBuckets(crossing, 'hour'), 2)
assert.equal(countBuckets(crossing, 'day'), 2)
assert.deepEqual(readTrafficRange(trafficHash(crossing, 'avg_ms'), morning), { range: crossing, metric: 'avg_ms', error: '' })
assert.equal(eventsForBucket(crossing), '#/http-guard/events?start=' + crossing.start + '&end=' + crossing.end)
assert.equal(parseShanghaiMinute('2026-02-31T01:00'), null)
assert.ok(readTrafficRange('#/http-guard/traffic?start=12&end=60', morning).error)
assert.ok(readTrafficRange(trafficHash({ ...yesterday, interval: 'minute' }, 'pv'), morning).error)
assert.equal(countBuckets({ start: today.start, end: today.start + 400 * 60 }, 'minute'), 400)
console.log('HTTP guard time ranges passed: Shanghai calendar days, hourly default, custom links, granularity limits and log drill-down')
