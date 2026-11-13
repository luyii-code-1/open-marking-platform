import {useEffect,useState,type CSSProperties} from 'react'
import type {ReviewSheet} from './reviewImages'
export function ReviewImage({sheet,image,style,className}:{sheet?:ReviewSheet;image?:Blob;style?:CSSProperties;className?:string}){
  const [urls,setUrls]=useState<string[]>([])
  useEffect(()=>{const next=(sheet?sheet.pages.map(p=>p.blob):image?[image]:[]).map(blob=>URL.createObjectURL(blob));setUrls(next);return()=>next.forEach(url=>URL.revokeObjectURL(url))},[sheet,image])
  if(!sheet)return urls[0]?<img src={urls[0]} alt="当前作答图像" draggable={false} className={className} style={style}/>:null
  const rects=sheet.regions.map(r=>r.rect||[0,0,sheet.pages[r.page].width,sheet.pages[r.page].height])
  const width=Math.max(...rects.map(r=>r[2])),height=rects.reduce((sum,r)=>sum+r[3],0)+12*(rects.length-1)
  let top=0
  return <svg className={`review-sheet ${className||''}`} style={style} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="当前题目作答区域"><rect width={width} height={height} fill="white"/>{sheet.regions.map((region,index)=>{
    const page=sheet.pages[region.page],rect=rects[index],y=top;top+=rect[3]+12
    return <svg key={index} x={0} y={y} width={rect[2]} height={rect[3]} viewBox={rect.join(' ')} overflow="hidden"><image href={urls[region.page]} width={page.width} height={page.height}/></svg>
  })}</svg>
}
