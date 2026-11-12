import { BoldOutlined, ItalicOutlined, UnderlineOutlined, TableOutlined } from '@ant-design/icons'
import { useEffect,useRef } from 'react'
import { Space } from 'antd'
import { Button } from './Button'

export function cleanHtml(value:string){
  const doc=new DOMParser().parseFromString(value,'text/html')
  const allowed=new Set(['P','DIV','BR','B','STRONG','I','EM','U','SUP','SUB','UL','OL','LI','TABLE','TBODY','THEAD','TR','TD','TH','SPAN'])
  for(const element of Array.from(doc.body.querySelectorAll('*')).reverse()){
    if(['SCRIPT','STYLE','IFRAME','OBJECT','IMG'].includes(element.tagName)){element.remove();continue}
    if(!allowed.has(element.tagName)){element.replaceWith(...Array.from(element.childNodes));continue}
    const retained=['font-weight','font-style','text-decoration'].map(key=>[key,(element as HTMLElement).style.getPropertyValue(key)])
    for(const attr of Array.from(element.attributes))element.removeAttribute(attr.name)
    for(const [key,value] of retained)if(value)(element as HTMLElement).style.setProperty(key,value)
  }
  return doc.body.innerHTML
}

export function RichEditor({value,onChange,readOnly=false}:{value:string;onChange:(value:string)=>void;readOnly?:boolean}){
  const editor=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(editor.current&&editor.current.innerHTML!==value)editor.current.innerHTML=cleanHtml(value)},[value])
  function insert(html:string){const selection=window.getSelection();if(!selection?.rangeCount||!editor.current?.contains(selection.anchorNode))return;const range=selection.getRangeAt(0);range.deleteContents();const fragment=range.createContextualFragment(cleanHtml(html));const last=fragment.lastChild;range.insertNode(fragment);if(last){range.setStartAfter(last);range.collapse(true);selection.removeAllRanges();selection.addRange(range)}onChange(editor.current!.innerHTML)}
  function format(tag:string){const selection=window.getSelection();if(!selection?.rangeCount||!editor.current?.contains(selection.anchorNode))return;const range=selection.getRangeAt(0);if(range.collapsed)return;const element=document.createElement(tag);element.append(range.extractContents());range.insertNode(element);onChange(editor.current!.innerHTML)}
  return <div><Space wrap style={{marginBottom:8}}>{[{tag:'strong',label:'粗体',icon:<BoldOutlined />},{tag:'em',label:'斜体',icon:<ItalicOutlined />},{tag:'u',label:'下划线',icon:<UnderlineOutlined />},{tag:'sup',label:'上标',icon:undefined},{tag:'sub',label:'下标',icon:undefined}].map(({tag,label,icon})=><Button key={tag} icon={icon} disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>format(tag)}>{label}</Button>)}<Button icon={<TableOutlined />} disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>insert('<table><tr><td>内容</td><td>内容</td></tr><tr><td>内容</td><td>内容</td></tr></table><p><br></p>')}>插入表格</Button></Space><div ref={editor} className="rich-editor" contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label="题目富文本内容" aria-multiline="true" onInput={()=>{if(!readOnly)onChange(editor.current!.innerHTML)}} onPaste={e=>{e.preventDefault();if(readOnly)return;const html=e.clipboardData.getData('text/html');if(html)insert(html);else{const text=e.clipboardData.getData('text/plain');const node=document.createElement('p');node.textContent=text;insert(node.outerHTML)}}}/></div>
}
