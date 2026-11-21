import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/scannerJpegEstimate.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { isJpegQuality, jpegSize, loadJpegEstimate, totalJpegBytes } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))

for (const quality of [60, 80, 90]) assert.equal(isJpegQuality(quality), true)
for (const quality of [undefined, null, '80', 75]) assert.equal(isJpegQuality(quality), false)

const requests = []
function load(args) {
  return new Promise((resolve, reject) => requests.push({ args, resolve, reject }))
}
const results = []
const publish = result => results.push(result)
const flush = () => new Promise(resolve => setImmediate(resolve))
const context = { paper: 'A3', batch_id: 'batch', group_id: 'group', template_id: 'template' }
const cancel = loadJpegEstimate({ ...context, quality: 80 }, load, publish)
cancel()
loadJpegEstimate({ ...context, quality: 60 }, load, publish)
assert.deepEqual(requests[1].args, { ...context, quality: 60 })
const scan = { quality: 60, size: 128 * 1024, source: 'scan', paper: 'A3' }
requests[1].resolve(scan)
requests[0].resolve({ ...scan, quality: 80, size: 148 * 1024 })
await flush()
assert.deepEqual(results, [{ sample: scan }])
assert.equal(jpegSize(scan.size, true), '128 KB')
assert.equal(jpegSize(totalJpegBytes(scan.size, 100)), '12.5 MB')
assert.equal(jpegSize(totalJpegBytes(scan.size, 8192)), '1 GB')
assert.equal(jpegSize(2 * 1024 ** 2, true), '2,048 KB')
for (const count of [null, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
  assert.equal(totalJpegBytes(scan.size, count), null)
}
assert.equal(requests.length, 2)

loadJpegEstimate({ paper: 'A4', quality: 90 }, load, publish)
const reference = { quality: 90, size: 125000, source: 'reference', paper: 'A4' }
requests[2].resolve(reference)
await flush()
assert.deepEqual(results.at(-1), { sample: reference })

loadJpegEstimate({ paper: 'A4', quality: 60 }, load, publish)
requests[3].resolve(reference)
await flush()
assert.ok(results.at(-1).error)
loadJpegEstimate({ paper: 'A4', quality: 80 }, load, publish)
requests[4].reject(new Error('读取图片失败'))
await flush()
assert.deepEqual(results.at(-1), { error: '读取图片失败' })
console.log('Scanner JPEG estimate passed: quality support, sample scope, request ordering and image-count totals')
