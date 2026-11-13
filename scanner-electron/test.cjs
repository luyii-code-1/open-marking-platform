const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { protocol, serverUrl, pageUrl, allowed, validateRequest } = require('./policy.cjs')
test('Only the configured scanner page receives native access', () => {
  const local = 'omp-scanner-ui://app/scanner.html', server = 'https://school.example/api/v1/'
  assert.equal(serverUrl('https://school.example'), server)
  assert.equal(pageUrl(server), 'https://school.example/scanner.html')
  assert.equal(allowed('https://school.example/scanner.html?version=2',server,local),true)
  for (const url of ['https://other.example/scanner.html','https://school.example/','https://school.example/other.html','file:///C:/Windows/win.ini']) assert.equal(allowed(url,server,local),false)
  assert.equal(allowed(local,'',local),true)
  for (const url of ['file:///C:/test','http://school.example','https://user:pass@school.example']) assert.throws(()=>serverUrl(url))
  assert.equal(serverUrl('http://localhost:8000'),'http://localhost:8000/api/v1/')
})
test('Renderer requests cannot invoke host lifecycle methods', () => {
  const request = {id:'1',protocol,method:'state',args:{}}
  assert.equal(validateRequest(request),request)
  for(const method of ['close','parseActivation','exec','readFile']) assert.throws(()=>validateRequest({...request,method}))
  assert.throws(()=>validateRequest({...request,protocol:'old'}))
  assert.throws(()=>validateRequest({...request,args:[]}))
})
test('Preload preserves the existing WebView message protocol without exposing IPC', () => {
  let exposed,receive;const sent=[]
  const electron={contextBridge:{exposeInMainWorld(name,value){assert.equal(name,'chrome');exposed=value}},ipcRenderer:{on(channel,listener){assert.equal(channel,'scanner:message');receive=listener},send(...args){sent.push(args)}}}
  vm.runInNewContext(fs.readFileSync(__dirname+'/preload.cjs','utf8'),{require(name){assert.equal(name,'electron');return electron}})
  let message
  const listener=event=>message=event.data
  exposed.webview.addEventListener('message',listener)
  exposed.webview.postMessage({id:'one',method:'state'})
  assert.equal(sent[0][0],'scanner:request')
  receive({}, {id:'one',ok:true})
  assert.equal(message.id,'one')
  exposed.webview.removeEventListener('message',listener);message=undefined;receive({},{});assert.equal(message,undefined)
  assert.equal(exposed.ipcRenderer,undefined)
})
