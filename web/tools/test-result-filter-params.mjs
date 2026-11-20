import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const source=await readFile(new URL('../src/resultFilterParams.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {readResultFilters,withResultFilters,resultExportRequest,resultExportExtension,formalReports}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const page=new URLSearchParams({group_id:'card',metric:'converted',room_tag_id:'room',class_ids:'c1,c2',student_ids:'s1',statuses:'completed',group_ids:'g1,g2',q:' 张 '})
const inherited=readResultFilters(page)
assert.deepEqual(inherited.classIds,['c1','c2'])
assert.deepEqual(inherited.groupIds,['g1','g2'])
const filtered=withResultFilters(page,{...inherited,classIds:['c2'],studentIds:[],q:' 李 '})
assert.equal(page.get('class_ids'),'c1,c2')
assert.equal(filtered.get('class_ids'),'c2')
assert.equal(filtered.has('student_ids'),false)
assert.equal(filtered.get('q'),'李')
for(const report of [...formalReports,'ranking','students','classes','distribution']){
  const {path,params}=resultExportRequest('card','card',filtered,report,'xlsx')
  assert.equal(params.get('class_ids'),'c2')
  assert.equal(params.get('room_tag_id'),'room')
  assert.equal(params.get('q'),'李')
  assert.equal(params.get('metric'),'converted')
  assert.equal(path,formalReports.includes(report)?'/analysis/reports/export':'/analysis/group/export')
  assert.equal(params.get('view'),formalReports.includes(report)?null:report)
  if(formalReports.includes(report))assert.equal(params.get('report'),report)
}
for(const report of [...formalReports,'summary','class-summary']){
  const {path,params}=resultExportRequest('project','exam',filtered,report,'xlsx')
  assert.equal(path,formalReports.includes(report)?'/analysis/reports/export':'/analysis/project/export')
  assert.equal(params.get('view'),formalReports.includes(report)?null:report)
  assert.equal(resultExportExtension('project',report,'xlsx'),formalReports.includes(report)?'zip':'xlsx')
  assert.equal(params.get('project_id'),'exam')
  assert.equal(params.get('group_ids'),'g1,g2')
  assert.equal(params.get('class_ids'),'c2')
}
console.log('Result filters: inherited scope, editable filters and all report export routes passed')
