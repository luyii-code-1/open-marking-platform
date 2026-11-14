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
    const style=(element as HTMLElement).style
    const retained=[
      ['font-weight',/^(bold|[6-9]00)$/.test(style.fontWeight)?'bold':''],
      ['font-style',style.fontStyle==='italic'?'italic':''],
      ['text-decoration',/underline/.test(style.textDecoration+' '+style.textDecorationLine)?'underline':''],
      ['vertical-align',['super','sub'].includes(style.verticalAlign)?style.verticalAlign:''],
    ]
    for(const attr of Array.from(element.attributes))element.removeAttribute(attr.name)
    for(const [key,value] of retained)if(value)(element as HTMLElement).style.setProperty(key,value)
  }
  const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT)
  const texts:Text[]=[]
  while(walker.nextNode())texts.push(walker.currentNode as Text)
  for(const text of texts){
    const parts=text.data.split(/(_(?:[ \t\u00a0]*_)+)/g)
    if(parts.length>1){
      const fragment=doc.createDocumentFragment()
      parts.forEach((part,i)=>{
        if(i%2===0)fragment.append(part)
        else {const line=doc.createElement('u');line.textContent='\u00a0'.repeat(part.length*2);fragment.append(line)}
      })
      text.replaceWith(fragment)
    }else if(text.parentElement?.closest('u,[style*="underline"]')){
      text.data=text.data.replace(/[ \t]{2,}|^[ \t]+$/g,space=>'\u00a0'.repeat(space.length))
    }
  }
  return doc.body.innerHTML
}

export function RichEditor({value,onChange,readOnly=false}:{value:string;onChange:(value:string)=>void;readOnly?:boolean}){
  const editor=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(editor.current&&editor.current.innerHTML!==value)editor.current.innerHTML=cleanHtml(value)},[value])
  function insert(html:string){const root=editor.current,selection=window.getSelection()
    if(!root||!selection)return
    let range:Range
    if(selection.rangeCount&&root.contains(selection.anchorNode))range=selection.getRangeAt(0)
    else {root.focus();range=document.createRange();range.selectNodeContents(root);range.collapse(false)}
    range.deleteContents();const fragment=range.createContextualFragment(cleanHtml(html));const last=fragment.lastChild;range.insertNode(fragment);if(last){range.setStartAfter(last);range.collapse(true);selection.removeAllRanges();selection.addRange(range)}onChange(editor.current!.innerHTML)}
  function format(tag:string){const selection=window.getSelection();if(!selection?.rangeCount||!editor.current?.contains(selection.anchorNode))return;const range=selection.getRangeAt(0);if(range.collapsed)return;const element=document.createElement(tag);element.append(range.extractContents());range.insertNode(element);onChange(editor.current!.innerHTML)}
  function pastePlain(text:string){
    const wrapper=document.createElement('div')
    for(const line of text.split(/\r?\n/)){const p=document.createElement('p');p.textContent=line;if(!line)p.append(document.createElement('br'));wrapper.append(p)}
    insert(wrapper.innerHTML)
  }
  return <div><Space wrap style={{marginBottom:8}}>{[{tag:'strong',label:'粗体',icon:<BoldOutlined />},{tag:'em',label:'斜体',icon:<ItalicOutlined />},{tag:'u',label:'下划线',icon:<UnderlineOutlined />},{tag:'sup',label:'上标',icon:undefined},{tag:'sub',label:'下标',icon:undefined}].map(({tag,label,icon})=><Button key={tag} icon={icon} disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>format(tag)}>{label}</Button>)}<Button disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>insert('<u>'+'&nbsp;'.repeat(24)+'</u>')}>插入答题线</Button><Button icon={<TableOutlined />} disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>insert('<table><tr><td>内容</td><td>内容</td></tr><tr><td>内容</td><td>内容</td></tr></table><p><br></p>')}>插入表格</Button></Space><div ref={editor} className="rich-editor" contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label="可粘贴 Word 内容的文字编辑框" data-placeholder="输入文字，或从 Word 粘贴" aria-multiline="true" onInput={()=>{if(!readOnly)onChange(editor.current!.innerHTML)}} onPaste={e=>{e.preventDefault();if(readOnly)return;const html=e.clipboardData.getData('text/html');if(html)insert(html);else pastePlain(e.clipboardData.getData('text/plain'))}}/></div>
}
