import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const source=await readFile(new URL('../src/recordFilters.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {filterRecords}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const rows=[{id:'a',name:'张老师',grades:['g1'],subjects:['数学']},{id:'b',name:'李老师',grades:['g2'],subjects:['语文']},{id:'c',name:'王老师',grades:['g2','g3'],subjects:['数学']}]
const fields=[{key:'grade',label:'年级',options:[{value:'g1',label:'高一'},{value:'g2',label:'高二'},{value:'g3',label:'高三'}],values:r=>r.grades},{key:'subject',label:'科目',options:[],values:r=>r.subjects}]
assert.deepEqual(filterRecords(rows,fields,{grade:['g1','g2'],subject:['数学']},'').map(r=>r.id),['a','c'])
assert.deepEqual(filterRecords(rows,fields,{grade:['g2']},'王').map(r=>r.id),['c'])
assert.deepEqual(filterRecords(rows,fields,{},'高二','grade').map(r=>r.id),['b','c'])
assert.deepEqual(filterRecords(rows,fields,{},'数学','subject').map(r=>r.id),['a','c'])
assert.equal(filterRecords(rows,fields,{},'不存在').length,0)
assert.equal(rows.length,3)
console.log('Record filters: AND between fields, OR within fields, keyword and display-label lookup passed')
