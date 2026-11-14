const { pathToFileURL } = require('node:url')
const methods = new Set(['state','connect','downloadProject','openProject','createBatch','assignRoom','choosePlugin','scanSettings','devices','start','stop','import','pair','upload','refreshBatch','sendForReview','retryPage','exclude','preview','roomReview','originalPage','onlinePage','offlinePage'])
const protocol = 'omp-scanner-4'
function serverUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol)) throw new Error('服务器地址无效。')
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('扫描服务器需要 HTTPS。')
  url.pathname = url.pathname.replace(/\/*$/, '/')
  if (!url.pathname.endsWith('/api/v1/')) url.pathname += 'api/v1/'
  return url.href
}
function pageUrl(server) { return new URL('../../scanner.html', serverUrl(server)).href }
function allowed(url, server, localPage) {
  try {
    const candidate = new URL(url); candidate.hash = ''; candidate.search = ''
    return candidate.href === localPage || !!server && candidate.href === pageUrl(server)
  } catch { return false }
}
function validateRequest(value) {
  if (!value || typeof value.id !== 'string' || !value.id.length || value.id.length > 100 || value.protocol !== protocol || !methods.has(value.method) || !value.args || typeof value.args !== 'object' || Array.isArray(value.args) || JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error('客户端请求无效。')
  return value
}
module.exports = { protocol, serverUrl, pageUrl, allowed, validateRequest, localUrl: file => pathToFileURL(file).href }

