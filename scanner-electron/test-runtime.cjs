// Headless renderer/native IPC regression; no UI inspection or user profile access.
const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-electron-runtime-'))
app.setPath('userData', path.join(temporary, 'electron'))
const native = process.argv.find(value => value.startsWith('--native='))?.slice(9)
let window, host, completed = false
const timer = setTimeout(() => finish(1, 'Renderer/native IPC timed out'), 30000)
function finish(code, message) {
  if (completed) return
  completed = true; clearTimeout(timer)
  console.log(message)
  if (host && !host.killed) host.stdin.end()
  window?.destroy(); app.exit(code)
}
app.whenReady().then(async () => {
  if (!native) throw new Error('--native=path/to/OMP.Scanner.Host.exe is required')
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.webContents.on('preload-error', (_event, _path, error) => finish(1, 'PRELOAD FAIL: ' + error.message))
  ipcMain.on('scanner:request', (event, value) => {
    if (event.sender === window.webContents) host.stdin.write(JSON.stringify(value) + '\n')
  })
  host = spawn(native, ['--transport-self-test', path.join(temporary, 'queue')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  host.on('error', error => finish(1, error.message))
  host.stderr.on('data', () => {})
  const ready = new Promise(resolve => {
    createInterface({ input: host.stdout }).on('line', line => {
      const value = JSON.parse(line)
      if (value.event === 'ready') resolve()
      else window.webContents.send('scanner:message', value)
    })
  })
  await ready
  await window.loadURL('data:text/html,<html><body>IPC fixture</body></html>')
  if (completed) return
  const result = await window.webContents.executeJavaScript(`new Promise(resolve => {
    const native = window.chrome?.webview;
    if (!native) { resolve({ok:false,reason:'Scanner host not detected'}); return; }
    native.addEventListener('message', ({data}) => {
      if (data.id === 'runtime-state') resolve({ok:data.ok && data.result.protocol === 'omp-scanner-4',protocol:data.result?.protocol,legacyAdapterReady:window.chrome.webview===window.ompScannerHost});
    });
    native.postMessage({id:'runtime-state',protocol:'omp-scanner-4',method:'state',args:{}});
  })`)
  finish(result.ok ? 0 : 1, JSON.stringify(result))
}).catch(error => finish(1, error.stack))
