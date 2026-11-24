import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
const entry=fileURLToPath(new URL('./main.tsx',import.meta.url))
const out=new URL('../../../docs/handover/试卷讲评Demo.html',import.meta.url)
const bundle=await build({entryPoints:[entry],bundle:true,write:false,outfile:'demo.js',format:'iife',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'}})
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text
const css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text
await mkdir(new URL('.',out),{recursive:true})
await writeFile(out,'<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>教师端 · 试卷讲评 Demo</title><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></html>')
