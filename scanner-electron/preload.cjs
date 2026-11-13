const { contextBridge, ipcRenderer } = require('electron')
// Keep the existing online scanner page's WebView message contract.
const listeners = new Set()
ipcRenderer.on('scanner:message', (_event, data) => {
  for (const listener of listeners) listener({ data })
})
contextBridge.exposeInMainWorld('chrome', {
  webview: {
    postMessage(value) { ipcRenderer.send('scanner:request', value) },
    addEventListener(event, listener) { if (event === 'message' && typeof listener === 'function') listeners.add(listener) },
    removeEventListener(event, listener) { if (event === 'message') listeners.delete(listener) },
  },
})
