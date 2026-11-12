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
for(const file of paths){hash.update(path.relative(root,file));const data=await readFile(file);hash.update(file.endsWith('.html')?data.toString().replace(/<meta name="omp-build" content="[^"]*">\s*/g,''):data)}
const version=hash.digest('hex').slice(0,16)
for(const file of paths.filter(file=>file.endsWith('.html'))){const html=(await readFile(file,'utf8')).replace(/<meta name="omp-build" content="[^"]*">\s*/g,'');await writeFile(file,html.replace('</head>','<meta name="omp-build" content="'+version+'"></head>'))}
const shell=paths.map(file=>'/'+path.relative(root,file).split(path.sep).join('/'))
await writeFile(path.join(root,'worker.js'),`/* Build ${version}: versioned shell and coordinated updates. */
const PREFIX='omp-shell-',VERSION=${JSON.stringify(version)},CACHE=PREFIX+VERSION;
const SHELL=${JSON.stringify(shell)};
const readyClients=new Set();
let pending=null;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
async function windows(){return (await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client=>new URL(client.url).origin===self.location.origin)}
async function prune(){
  const clients=await windows();
  if(clients.some(client=>!readyClients.has(client.id)))return;
  const old=(await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==CACHE);
  for(const key of old.slice(0,-1))await caches.delete(key);
}
async function prepare(event,legacy){
  if(pending||!event.source?.id)return;
  const clients=await windows();
  if(legacy){
    if(clients.length!==1||clients[0].id!==event.source.id){event.source.postMessage({type:'UPDATE_ABORTED'});return;}
    await self.skipWaiting();return;
  }
  const requestId=String(Date.now())+'-'+Math.random();
  let finish;
  const outcome=new Promise(resolve=>{finish=resolve});
  pending={requestId,clients:new Set(clients.map(c=>c.id)),remaining:new Set(clients.map(c=>c.id)),finish,cancelled:false};
  const timer=setTimeout(()=>finish(false),8000);
  for(const client of clients)client.postMessage({type:'CHECK_UPDATE',requestId});
  if(!clients.length)finish(false);
  let accepted=await outcome;
  clearTimeout(timer);
  const latest=await windows();
  if(pending.cancelled)accepted=false;
  if(latest.some(c=>!clients.some(original=>original.id===c.id)))accepted=false;
  for(const client of latest)client.postMessage({type:accepted?'UPDATE_COMMIT':'UPDATE_ABORTED'});
  pending=null;
  if(accepted)await self.skipWaiting();
}
self.addEventListener('message',event=>{
  const value=event.data;
  if(value?.type==='PREPARE_UPDATE')event.waitUntil(prepare(event,false));
  else if(value?.type==='SKIP_WAITING')event.waitUntil(prepare(event,true));
  else if(value?.type==='UPDATE_CANCEL'&&pending&&pending.requestId===value.requestId&&pending.clients.has(event.source?.id)){pending.cancelled=true;pending.finish(false);}
  else if(value?.type==='UPDATE_READY'&&pending&&pending.requestId===value.requestId&&pending.remaining.has(event.source?.id)){
    if(value.ready!==true)pending.finish(false);
    else {pending.remaining.delete(event.source.id);if(!pending.remaining.size)pending.finish(true);}
  }else if(value?.type==='CLIENT_READY'&&value.build===VERSION&&event.source?.id){readyClients.add(event.source.id);event.waitUntil(prune());}
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname==='/api'||url.pathname.startsWith('/api/'))return;
  if(request.mode==='navigate'){
    event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(url.pathname==='/scanner.html'?'/scanner.html':'/index.html'))||fetch(request)));
    return;
  }
  if(url.search||(!SHELL.includes(url.pathname)&&!url.pathname.startsWith('/assets/')))return;
  event.respondWith((async()=>{
    const current=await (await caches.open(CACHE)).match(url.pathname);if(current)return current;
    for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE){const response=await (await caches.open(key)).match(url.pathname);if(response)return response;}
    return fetch(request);
  })());
});
`)
console.log(`PWA worker ${version}: ${shell.length} static assets`)
