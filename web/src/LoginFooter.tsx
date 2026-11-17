import { useEffect, useState } from 'react'
import { request } from './api'

// HTML comes from the server's footer sanitizer for both saved content and previews.
export function LoginFooterContent({ html }: { html: string }) {
  return <div className="login-footer-content" dangerouslySetInnerHTML={{ __html: html }} />
}

export function LoginFooter() {
  const [html, setHtml] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function refresh() {
      try {
        const value = await request<{ html: string }>('/public/login-footer', { cache: 'no-store', signal: controller.signal })
        if (!controller.signal.aborted) setHtml(value.html)
      } catch { if (!controller.signal.aborted) setHtml('') }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { controller.abort(); window.removeEventListener('focus', refresh) }
  }, [])
  return html ? <footer className="login-footer"><LoginFooterContent html={html} /></footer> : null
}
