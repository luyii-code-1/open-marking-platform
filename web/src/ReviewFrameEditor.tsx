import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Alert, Modal, Radio, Space, Spin, Typography } from 'antd'
import { Button } from './Button'
import { requestBlob, type Question, type Region, type Template } from './api'

type Point = { x: number; y: number }
const sideName = (page: number) => page === 1 ? '正面' : '背面'

export function ReviewFrameEditor({ template, question, onSave, onClose }: {
  template: Template; question: Question; onSave: (frames: Region[]) => void; onClose: () => void
}) {
  const width = template.paper === 'A3' ? 420 : 210
  const height = 297
  const pages = [...new Set(question.regions.map(r => r.page))].sort()
  const [page, setPage] = useState(pages[0])
  const [frames, setFrames] = useState(question.review_frames ?? [])
  const [preview, setPreview] = useState<{page: number; url: string}>()
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Region>()
  const start = useRef<Point | undefined>(undefined)
  const payload = JSON.stringify({...template, questions: template.questions.map(q => ({...q, answer: [], review_frames: []}))})

  useEffect(() => {
    const abort = new AbortController()
    let url = ''
    setError('')
    requestBlob('/templates/preview?page='+page, {method:'POST', body:payload, signal:abort.signal})
      .then(blob => {
        if (!abort.signal.aborted) {
          url = URL.createObjectURL(blob)
          setPreview({page, url})
        }
      }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [page, payload])

  const areas = question.regions.filter(r => r.page === page)
  const x = Math.min(...areas.map(r => r.x)), y = Math.min(...areas.map(r => r.y))
  const automatic = {page, x, y, width:Math.max(...areas.map(r => r.x+r.width))-x, height:Math.max(...areas.map(r => r.y+r.height))-y}
  const manual = frames.find(r => r.page === page)
  const box = draft ?? manual ?? automatic
  const others = template.questions.filter(q => q.id !== question.id).flatMap(q => q.regions.filter(r => r.page === page))
  const image = preview?.page === page ? preview.url : undefined

  function replace(frame?: Region) {
    setFrames(old => [...old.filter(r => r.page !== page), ...(frame ? [frame] : [])])
  }
  function point(e: PointerEvent<SVGSVGElement>) {
    const matrix = e.currentTarget.getScreenCTM()!
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
    return {x:Math.round(Math.max(0, Math.min(width, p.x))*10)/10, y:Math.round(Math.max(0, Math.min(height, p.y))*10)/10}
  }
  function rectangle(a: Point, b: Point): Region {
    return {page, x:Math.min(a.x,b.x), y:Math.min(a.y,b.y), width:Math.abs(a.x-b.x), height:Math.abs(a.y-b.y)}
  }
  function end() { start.current = undefined; setDraft(undefined) }
  return <Modal open width={850} title="阅卷显示范围" okText="应用" cancelText="取消" onCancel={onClose}
    onOk={() => onSave(frames.filter(r => pages.includes(r.page)))}>
    <Space direction="vertical" style={{width:'100%'}}>
      <Space wrap>
        {pages.length > 1 ? <Radio.Group value={page} options={pages.map(p => ({label:sideName(p),value:p}))} optionType="button"
          onChange={e => { end(); setPage(e.target.value) }}/> : <strong>{sideName(page)}</strong>}
        <Button onClick={() => replace({page,x:0,y:0,width,height})}>选取整面</Button>
        <Button disabled={!manual} onClick={() => replace()}>恢复自动范围</Button>
      </Space>
      <Typography.Text type="secondary">在题卡上拖动可重画本面显示框。框内保留纸面排版，其他题目的答题区会遮住。</Typography.Text>
      {error ? <Alert type="error" message={error}/> : !image ? <Spin/> :
        <svg viewBox={`0 0 ${width} ${height}`} style={{display:'block',width:'100%',height:'min(56vh, 540px)',touchAction:'none',cursor:'crosshair'}}
          aria-label={sideName(page)+'阅卷显示框'}
          onPointerDown={e => { if (!e.isPrimary || e.button !== 0) return; start.current=point(e); e.currentTarget.setPointerCapture(e.pointerId) }}
          onPointerMove={e => { if (e.isPrimary && start.current) setDraft(rectangle(start.current,point(e))) }}
          onPointerUp={e => {
            if (!e.isPrimary || !start.current) return
            const next=rectangle(start.current,point(e))
            if (next.width>=1 && next.height>=1) replace(next)
            end()
          }} onPointerCancel={end}>
          <image href={image} width={width} height={height}/>
          {others.map((r,i)=><rect key={i} x={r.x} y={r.y} width={r.width} height={r.height} fill="white"/>)}
          <path fill="#17212e" opacity=".18" fillRule="evenodd" d={`M0 0h${width}v${height}H0z M${box.x} ${box.y}h${box.width}v${box.height}h-${box.width}z`}/>
          <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="none" stroke="#0866ff" strokeWidth=".7"/>
        </svg>}
    </Space>
  </Modal>
}
