import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const {outputText}=ts.transpileModule(await readFile(new URL('../src/buildVersion.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {serverBuild,workerBuild,verifyWaitingBuild}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const version='0123456789abcdef'
const metadata={commit:'1234567890',build_number:'20261116.2130',built_at:'2026-11-16T13:30:00.000Z',shell_version:version}
globalThis.fetch=async(url,options)=>{assert.equal(url,'/api/v1/system/build');assert.equal(options.cache,'no-store');return Response.json(metadata)}
const worker=version=>({postMessage(message,ports){assert.equal(message.type,'GET_BUILD_VERSION');ports[0].postMessage({type:'BUILD_VERSION',version});ports[0].close()}})
assert.deepEqual(await serverBuild(),metadata)
assert.equal(await workerBuild(worker(version)),version)
assert.equal(await verifyWaitingBuild(worker(version)),true)
assert.equal(await verifyWaitingBuild(worker('fedcba9876543210')),false,'A waiting worker from a different release must not activate')
globalThis.fetch=async()=>{throw new TypeError('offline')}
assert.equal(await verifyWaitingBuild(worker(version)),false)
const built=JSON.parse(await readFile(new URL('../dist/version.json',import.meta.url),'utf8'))
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8')
const scanner=await readFile(new URL('../dist/scanner.html',import.meta.url),'utf8')
assert.match(built.build_number,/^\d{8}\.\d{4}$/)
for(const page of [html,scanner])assert.ok(page.includes(`name="omp-build" content="${built.shell_version}"`))
console.log('Build identity passed: server, page and worker agree; stale/offline workers defer activation')
