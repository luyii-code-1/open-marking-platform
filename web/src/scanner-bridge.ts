export const scannerProtocol = 'omp-scanner-3'
type NativeMessage = { data: any }
type NativeView = { postMessage: (value: unknown) => void; addEventListener: (event: string, listener: (message: NativeMessage) => void) => void }
const native = (window as unknown as { chrome?: { webview?: NativeView } }).chrome?.webview
const pending = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const events = new EventTarget()
native?.addEventListener('message', ({ data }) => {
  if (data?.event === 'changed' && data.protocol === scannerProtocol) { events.dispatchEvent(new Event('change')); return }
  const request = pending.get(data?.id)
  if (!request) return
  pending.delete(data.id); clearTimeout(request.timer)
  if (data.ok) request.resolve(data.result)
  else request.reject(new Error(data.error || '客户端操作未完成'))
})
export const hasScannerHost = !!native
export function scannerCall<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!native) return Promise.reject(new Error('请在扫描客户端打开此页面'))
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('操作仍未返回，请核查客户端状态后再试')) }, 120_000)
    pending.set(id, { resolve, reject, timer }); native.postMessage({ id, protocol: scannerProtocol, method, args })
  })
}
export function watchScanner(callback: () => void) { events.addEventListener('change', callback); return () => events.removeEventListener('change', callback) }
