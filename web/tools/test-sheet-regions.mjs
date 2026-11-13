import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const source=await readFile(new URL('../src/sheetRegions.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {forbiddenRegion,forbiddenConflict}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const template={paper:'A3',sheet_columns:3,questions:[],forbidden_regions:[]}
const area=forbiddenRegion(template,1,{x:20,y:120},{x:500,y:500})
assert.deepEqual(area,{page:1,x:20,y:120,width:118.6,height:150})
const moved=forbiddenRegion(template,1,{x:20,y:120},{x:30,y:10},area)
assert.equal(moved.y,100);assert.ok(moved.x+moved.width<=138.6667)
const resized=forbiddenRegion(template,1,{x:0,y:0},{x:200,y:300},area,true)
assert.ok(resized.x+resized.width<=138.6667);assert.equal(resized.y+resized.height,270)
assert.equal(forbiddenConflict(template,area),'')
assert.ok(forbiddenConflict({...template,forbidden_regions:[area]},area))
assert.equal(forbiddenConflict({...template,forbidden_regions:[area]},area,0),'')
assert.ok(forbiddenConflict({...template,questions:[{regions:[area]}]},area))
assert.ok(forbiddenConflict(template,{...area,width:1}))
console.log('Manual forbidden regions passed: panel bounds, move, resize and overlap handling')
