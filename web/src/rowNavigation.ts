import type { HTMLAttributes } from 'react'

export function rowNavigation(enter:()=>void,label:string):HTMLAttributes<HTMLElement>{
  return {
    tabIndex:0,'aria-label':`打开${label}`,className:'navigable-row',
    onClick:event=>{if(!(event.target as Element).closest('a,button,input,select,textarea,[role="button"],.ant-dropdown-trigger')&&!window.getSelection()?.toString())enter()},
    onKeyDown:event=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();enter()}},
  }
}
