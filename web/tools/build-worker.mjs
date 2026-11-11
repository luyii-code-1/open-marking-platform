import { createHash } from 'node:crypto'
import { readdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'

const root=path.resolve('dist')
async function files(folder) {
  const output=[]
  for(const item of await readdir(folder,{withFileTypes:true})) {
    const full=path.join(folder,item.name)
    if(item.isDirectory())output.push(...await files(full))
    else if(/\.(html|js|css|png|svg|webmanifest|ico)$/.test(item.name)&&item.name!=='worker.js')output.push(full)
  }
  return output
}
const paths=(await files(root)).sort(),hash=createHash('sha256')
for(const file of paths){hash.update(path.relative(root,file));hash.update(await readFile(file))}
const version=hash.digest('hex').slice(0,16)
const shell=paths.map(file=>'/'+path.relative(root,file).split(path.sep).join('/'))
await writeFile(path.join(root,'worker.js'),`/* Build ${version}: application shell only. */
const PREFIX='omp-shell-';
const CACHE=PREFIX+${JSON.stringify(version)};
const SHELL=${JSON.stringify(shell)};
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')event.waitUntil(self.skipWaiting());
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname==='/api'||url.pathname.startsWith('/api/'))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(async()=>{
      const response=await (await caches.open(CACHE)).match('/index.html');
      return response||new Response('请联网后重新打开阅卷平台',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
    }));
    return;
  }
  if(!SHELL.includes(url.pathname)||url.search)return;
  event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(url.pathname))||fetch(request)));
});
`)
console.log(`PWA worker ${version}: ${shell.length} static assets`)
