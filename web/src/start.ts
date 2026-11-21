// The HTML shell stays visible until the application and its styles are ready.
void import('./main').catch(() => {
  const status = document.getElementById('start-status')
  const retry = document.getElementById('start-retry')
  if (status && retry) {
    status.textContent = '页面资源加载失败，请检查网络连接。'
    retry.hidden = false
    retry.addEventListener('click', () => window.location.reload(), { once: true })
  }
})
