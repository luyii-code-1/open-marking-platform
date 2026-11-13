const { app, BrowserWindow, ipcMain, dialog, session, protocol: electronProtocol, net } = require('electron')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const path = require('node:path')
const { protocol, serverUrl, pageUrl, allowed, validateRequest, localUrl } = require('./policy.cjs')

const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'dist', 'scanner-electron', 'resources')
electronProtocol.registerSchemesAsPrivileged([{ scheme: 'omp-scanner-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const localPage = 'omp-scanner-ui://app/scanner.html'
let window, host, server = '', quitting = false, ready = false, sequence = 0, pageGeneration = 0
const pending = new Map()
const activations = process.argv.filter(value => value.startsWith('omp-scanner:'))
function send(value) { if (window && !window.isDestroyed() && allowed(window.webContents.getURL(), server, localPage)) window.webContents.send('scanner:message', value) }
function invoke(method, args = {}) {
  return new Promise((resolve, reject) => {
    if (!host || host.killed || !ready) return reject(new Error('扫描服务尚未就绪。'))
    const id = 'host-' + ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('扫描服务响应超时。')) }, 120000)
    pending.set(id, { resolve, reject, timer })
    host.stdin.write(JSON.stringify({ id, protocol, method, args }) + '\n')
  })
}
async function navigate(target) {
  if (!allowed(target, server, localPage)) throw new Error('扫描页面地址无效。')
  try { await window.loadURL(target) } catch { if (target !== localPage) await window.loadURL(localPage) }
}
async function confirmServer(target) {
  const normalized = serverUrl(target)
  if (normalized === server) return normalized
  const result = await dialog.showMessageBox(window, { type: 'question', title: '连接扫描服务器', message: '将本机连接到：\n' + new URL(normalized).origin, buttons: ['连接', '取消'], defaultId: 1, cancelId: 1 })
  if (result.response !== 0) throw new Error('已取消服务器切换。')
  return normalized
}
async function activate(uri) {
  if (!ready || !window) { activations.push(uri); return }
  if (window.isMinimized()) window.restore()
  window.focus()
  if (!uri) return
  try {
    const pairing = await invoke('parseActivation', { uri })
    const next = await confirmServer(pairing.server)
    const result = await invoke('connect', { server_url: next, pairing_code: pairing.code })
    server = next; await navigate(result.page_url)
  } catch (error) { await dialog.showMessageBox(window, { type: 'error', message: error.message }) }
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, argv) => { void activate(argv.find(value => value.startsWith('omp-scanner:')) || '') })
  app.on('before-quit', event => { if (!quitting && window) { event.preventDefault(); window.close() } })
  app.on('window-all-closed', () => app.quit())
  app.whenReady().then(async () => {
    electronProtocol.handle('omp-scanner-ui', request => {
      const url = new URL(request.url)
      const root = path.join(base, 'native', 'ui')
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname))
      if (url.host !== 'app' || !file.startsWith(root + path.sep)) return new Response('', { status: 403 })
      return net.fetch(localUrl(file))
    })
    app.setAppUserModelId('cn.omp.scanner.electron')
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.on('will-download', event => event.preventDefault())
    window = new BrowserWindow({ width: 1280, height: 850, minWidth: 960, minHeight: 640, title: '扫描工作台', backgroundColor: '#f3f5f4', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (!allowed(url, server, localPage)) event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { if (!allowed(url, server, localPage)) event.preventDefault() })
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) pageGeneration++ })
    window.on('close', event => {
      if (quitting) return
      event.preventDefault()
      if (window.closing) return
      window.closing = true
      void invoke('close').catch(() => {}).finally(() => { quitting = true; host?.stdin.end(); window.destroy(); app.quit() })
    })
    ipcMain.on('scanner:request', async (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowed(event.senderFrame.url, server, localPage)) return
      const generation = pageGeneration
      try {
        validateRequest(value)
        if (value.method === 'offlinePage') { send({ id: value.id, ok: true, result: {} }); await navigate(localPage); return }
        const next = value.method === 'connect' ? await confirmServer(value.args.server_url) : null
        const result = await invoke(value.method, value.args)
        if (next) server = next
        if (generation !== pageGeneration) return
        send({ id: value.id, ok: true, result })
        if (['connect', 'onlinePage'].includes(value.method) && result?.page_url) await navigate(result.page_url)
      } catch (error) { if (generation === pageGeneration && typeof value?.id === 'string') send({ id: value.id, ok: false, error: error.message }) }
    })
    host = spawn(path.join(base, 'native', 'OMP.Scanner.Host.exe'), [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] })
    host.stderr.on('data', () => {})
    host.on('error', error => { dialog.showErrorBox('扫描服务启动失败', error.message); quitting = true; app.quit() })
    host.on('exit', () => {
      ready = false
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('扫描服务已关闭。')) }
      pending.clear()
      if (!quitting && !window.closing) { dialog.showErrorBox('扫描服务已关闭', '请重新打开扫描客户端。'); quitting = true; app.quit() }
    })
    createInterface({ input: host.stdout }).on('line', async line => {
      let value
      try { value = JSON.parse(line) } catch { return }
      if (value.event === 'ready') {
        ready = true; server = value.server
        await navigate(value.page_url || localPage); window.show()
        for (const uri of activations.splice(0)) await activate(uri)
      } else if (value.event === 'changed') send(value)
      else {
        const item = pending.get(value.id)
        if (!item) return
        clearTimeout(item.timer); pending.delete(value.id)
        if (value.ok) item.resolve(value.result); else item.reject(new Error(value.error || '扫描操作失败。'))
      }
    })
  }).catch(error => { dialog.showErrorBox('扫描客户端', error.message); quitting = true; app.quit() })
}
