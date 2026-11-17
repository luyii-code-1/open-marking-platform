import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
const source=await readFile(new URL('../src/tableSorting.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {sortableColumns,compareCells}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const custom=(a,b)=>a.score-b.score
const columns=sortableColumns([{title:'姓名',dataIndex:'name'},{title:'信息',children:[{title:'成绩',dataIndex:['result','score']}]},{title:'班级',render:(_,row)=>({props:{children:row.class_name}})},{title:'分值',render:(_,row)=>({props:{value:row.score}})},{title:'名次',sorter:custom},{title:'操作',render:()=>({props:{children:'编辑'}})}])
assert(compareCells('2班','10班')<0)
assert(compareCells(9.5,10)<0)
assert(compareCells(null,0)>0)
assert(compareCells(null,0,'descend')<0)
assert(columns[1].children[0].sorter({result:{score:5}},{result:{score:12}})<0)
assert(columns[2].sorter({class_name:'2班'},{class_name:'10班'})<0)
assert(columns[3].sorter({score:2},{score:10})<0)
assert.equal(columns[4].sorter,custom)
assert.equal(columns[5].sorter,undefined)
assert.equal(sortableColumns([{title:'姓名',dataIndex:'name'}],true)[0].sorter,true)
const rows=[{name:'10班'},{name:'2班'},{name:'1班'}]
assert.deepEqual([...rows].sort(columns[0].sorter).map(r=>r.name),['1班','2班','10班'])
console.log('Table sorting passed: numeric, natural Chinese, empty cells, rendered values, nested columns and server sorting')
