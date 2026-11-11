import { useEffect, useState } from 'react'
import { Alert, Spin } from 'antd'
export function AssetImage({ src, className, style }: { src: string; className?: string; style?: React.CSSProperties }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false, objectUrl = ''; setUrl(''); setError('')
    if (!src) return
    const target = new URL(src, location.origin)
    const sameOrigin = target.origin === location.origin
    fetch(target.href, { headers: sameOrigin ? { Authorization: `Bearer ${sessionStorage.getItem('omp-token') || ''}` } : {} }).then(async response => { if (!response.ok) throw new Error(`图像加载失败（${response.status}）`); return response.blob() }).then(blob => { if (!cancelled) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) } }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [src])
  return error ? <Alert type="error" message={error} /> : !url ? <div className="image-loading"><Spin /></div> : <img src={url} alt="作答图像" className={className} style={{ maxWidth: '100%', ...style }} draggable={false} />
}
