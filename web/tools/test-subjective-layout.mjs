import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

async function moduleAt(name){
  const source=await readFile(new URL('../src/'+name,import.meta.url),'utf8')
  const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}
const {subjectiveRegion}=await moduleAt('sheetRegions.ts')
const {subjectiveLayoutKey}=await moduleAt('subjectiveLayout.ts')
const template={id:'draft',draft_version:1,paper:'A3',sides:2,sheet_columns:2,layout_version:3,questions:[]}
const area={page:1,x:12,y:120,width:194,height:60}
const shrunk=subjectiveRegion(template,1,{x:100,y:180},{x:100,y:145},area,true)
assert.equal(shrunk.height,25)
assert.equal(shrunk.min_height,25)
assert.equal(shrunk.y,120)
assert.equal(shrunk.anchor_y,120)
assert.equal(shrunk.width,194)
const grown=subjectiveRegion(template,1,{x:100,y:180},{x:100,y:400},area,true)
assert.equal(grown.y+grown.height,270)
assert.equal(subjectiveRegion(template,1,{x:100,y:180},{x:100,y:119},area,true).height,8)
assert.equal(subjectiveLayoutKey(template),subjectiveLayoutKey({...template,id:'other',draft_version:9,draft_signature:'saved',status:'draft'}))
assert.notEqual(subjectiveLayoutKey(template),subjectiveLayoutKey({...template,font_size:16}))
console.log('Subjective layout: resize minimum, column/footer boundaries and autosave-independent request keys passed')
