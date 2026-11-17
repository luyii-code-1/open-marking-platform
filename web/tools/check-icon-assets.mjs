import assert from 'node:assert/strict'
import {access,readFile,readdir} from 'node:fs/promises'
import {createRequire} from 'node:module'

const require=createRequire(import.meta.url)
const source=await readFile(new URL('../src/fluent-icons.css',import.meta.url),'utf8')
const references=[...source.matchAll(/url\("(@fluentui\/svg-icons\/icons\/[^"\n]+)"\)/g)].map(match=>match[1])
assert.ok(references.length>0,'The icon stylesheet must reference its SVG assets')
for(const reference of new Set(references)){
  let file
  try{file=require.resolve(reference)}catch{throw new Error(`Missing icon asset: ${reference}. Run npm ci before building.`)}
  assert.match(await readFile(file,'utf8'),/<svg\b/,reference)
}

if(process.argv.includes('--built')){
  const root=new URL('../dist/',import.meta.url),assets=new URL('assets/',root)
  const files=(await readdir(assets)).filter(file=>file.endsWith('.css'))
  const css=(await Promise.all(files.map(file=>readFile(new URL(file,assets),'utf8')))).join('\n')
  assert.ok(!css.includes('@fluentui/'),'Built CSS must contain resolved SVG assets')
  const icons=[...css.matchAll(/--fluent-glyph:\s*url\((?:"([^"]+)"|'([^']+)'|([^\s)]+))\)/g)].map(match=>match[1]||match[2]||match[3])
  assert.ok(icons.length>=new Set(references).size,'The built CSS must retain every icon mapping')
  for(const icon of new Set(icons)){
    if(icon.startsWith('data:image/svg+xml')){
      const comma=icon.indexOf(','),header=icon.slice(0,comma),data=icon.slice(comma+1)
      const svg=header.endsWith(';base64')?Buffer.from(data,'base64').toString():decodeURIComponent(data)
      assert.match(svg,/<svg\b/)
    }else{
      assert.ok(icon.startsWith('/assets/'),`Unexpected icon URL: ${icon}`)
      const file=new URL(icon.slice(1),root)
      assert.ok(file.href.startsWith(assets.href),'Icon assets must remain inside the build')
      await access(file)
    }
  }
  console.log(`Bundled icons passed: ${icons.length} resolved SVG mappings`)
}else console.log(`Icon assets passed: ${new Set(references).size} SVG files available`)
