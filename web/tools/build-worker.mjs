import { createHash } from 'node:crypto'
import { readdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'

const root=path.resolve('dist')
async function files(folder) {
  const output=[]
  for(const item of await readdir(folder,{withFileTypes:true})) {
    if(item.name.startsWith('.'))continue
    const full=path.join(folder,item.name)
    if(item.isDirectory())output.push(...await files(full))
    else if(/\.(html|js|css|png|svg|webmanifest|ico)$/.test(item.name)&&item.name!=='worker.js')output.push(full)
  }
  return output
}
const manifest=JSON.parse(await readFile(path.join(root,'.vite/manifest.json'),'utf8'))
function staticAssets(entries) {
  const seen=new Set(),urls=new Set()
  function visit(key) {
    if(seen.has(key))return
    seen.add(key)
    const chunk=manifest[key]
    if(!chunk)throw new Error('Missing offline build entry '+key)
    for(const file of [chunk.file,...chunk.css||[],...chunk.assets||[]])urls.add('/'+file)
    for(const dependency of chunk.imports||[])visit(dependency)
  }
  entries.forEach(visit)
  return [...urls]
}
function dynamicEntry(parent,name) {
  const key=manifest[parent].dynamicImports?.find(key=>manifest[key].name===name)
  if(!key)throw new Error('Missing dynamic import '+name+' from '+parent)
  return key
}
const loginEntry=dynamicEntry('index.html','main')
const workspace=dynamicEntry(loginEntry,'AuthenticatedApp')
const startup=staticAssets([loginEntry])
const index=path.join(root,'index.html'),html=await readFile(index,'utf8')
const original=html.replace(/<!--app-preload-->[\s\S]*?<!--\/app-preload-->/,'<!--app-preload--><!--/app-preload-->')
const hints=startup.filter(url=>!original.includes('"'+url+'"')).map(url=>{
  if(url.endsWith('.js'))return '<link rel="modulepreload" crossorigin href="'+url+'">'
  if(url.endsWith('.css'))return '<link rel="preload" as="style" crossorigin href="'+url+'">'
  return ''
}).join('\n')
await writeFile(index,html.replace(/<!--app-preload-->[\s\S]*?<!--\/app-preload-->/,'<!--app-preload-->'+hints+'<!--/app-preload-->'))
const core=[...new Set(['/index.html','/scanner.html','/branding/omp-logo.svg',...staticAssets(['index.html']),...startup])]
const review=staticAssets([workspace,dynamicEntry(workspace,'ReviewTasks'),dynamicEntry(workspace,'Marking')]).concat('/branding/omp-mark.svg')
const paths=(await files(root)).sort(),hash=createHash('sha256')
for(const file of paths){hash.update(path.relative(root,file));const data=await readFile(file);hash.update(file.endsWith('.html')?data.toString().replace(/<meta name="omp-build" content="[^"]*">\s*/g,''):data)}
const version=hash.digest('hex').slice(0,16)
const metadata=JSON.parse(await readFile(path.join(root,'version.json'),'utf8'))
await writeFile(path.join(root,'version.json'),JSON.stringify({...metadata,shell_version:version}))
for(const file of paths.filter(file=>file.endsWith('.html'))){const html=(await readFile(file,'utf8')).replace(/<meta name="omp-build" content="[^"]*">\s*/g,'');await writeFile(file,html.replace('</head>','<meta name="omp-build" content="'+version+'"></head>'))}
const shell=paths.map(file=>'/'+path.relative(root,file).split(path.sep).join('/'))
await writeFile(path.join(root,'worker.js'),`/* Build ${version}: versioned shell and coordinated updates. */
const PREFIX='omp-shell-',VERSION=${JSON.stringify(version)},CACHE=PREFIX+VERSION;
const SHELL=new Set(${JSON.stringify(shell)}),CORE=${JSON.stringify(core)},REVIEW=${JSON.stringify(review)};
const CORE_MARK='/.omp-split-shell',REVIEW_MARK='/.omp-offline-review';
const readyClients=new Set();
let pending=null,warmingReview;
async function prepareReview(){
  if(warmingReview)return warmingReview;
  warmingReview=(async()=>{
    const cache=await caches.open(CACHE);
    if(await cache.match(REVIEW_MARK))return;
    const status=await Promise.all(REVIEW.map(async url=>(await cache.match(url))?null:url));
    const missing=status.filter(Boolean);
    // Let foreground navigation and scoring requests use the connection first.
    for(let i=0;i<missing.length;i+=3)await cache.addAll(missing.slice(i,i+3));
    await cache.put(REVIEW_MARK,new Response('ready'));
  })().finally(()=>{warmingReview=null});
  return warmingReview;
}
async function previousReview(){
  for(const key of (await caches.keys()).reverse()){
    if(!key.startsWith(PREFIX)||key===CACHE)continue;
    const previous=await caches.open(key);
    if(await previous.match(REVIEW_MARK))return true;
    // The previous all-in-one shell included the offline grading workspace.
    if(!await previous.match(CORE_MARK)&&await previous.match('/scanner.html'))return true;
  }
  return false;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(CORE);
  for(const url of ['/index.html','/scanner.html']){
    const html=await (await cache.match(url)).text();
    if(!html.includes('<meta name="omp-build" content="'+VERSION+'">'))throw Error('Shell version mismatch');
  }
  await cache.put(CORE_MARK,new Response('ready'));
  if(await previousReview())await prepareReview();
})()));
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
  if(await previousReview()){
    try{await prepareReview()}catch{event.source.postMessage({type:'UPDATE_ABORTED'});return;}
  }
  const clients=await windows();
  if(pending)return;
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
  if(value?.type==='PREPARE_REVIEW_SHELL'){
    event.waitUntil(prepareReview().catch(()=>{}));return;
  }
  if(value?.type==='GET_BUILD_VERSION'){
    const reply={type:'BUILD_VERSION',version:VERSION};
    if(event.ports?.[0])event.ports[0].postMessage(reply);else event.source?.postMessage(reply);
    return;
  }
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
  if(url.search||request.headers?.has('range')||(!SHELL.has(url.pathname)&&!url.pathname.startsWith('/assets/')))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),current=await cache.match(url.pathname);if(current)return current;
    if(url.pathname.startsWith('/assets/')&&!SHELL.has(url.pathname)){
      for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE){const response=await (await caches.open(key)).match(url.pathname);if(response)return response;}
    }
    const response=await fetch(request);
    if(SHELL.has(url.pathname)&&response.status===200&&!response.redirected&&!/no-store|private/i.test(response.headers.get('Cache-Control')||'')){
      event.waitUntil(cache.put(url.pathname,response.clone()).catch(()=>{}));
    }
    return response;
  })());
});
`)
console.log(`PWA worker ${version}: ${core.length} startup assets, ${review.length} offline review assets, ${shell.length} available on demand`)
