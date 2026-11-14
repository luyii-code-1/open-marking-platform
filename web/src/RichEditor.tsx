import { BoldOutlined, ItalicOutlined, UnderlineOutlined, TableOutlined } from '@ant-design/icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Space } from 'antd'
import { Button } from './Button'

function answerLine(doc:Document,mm:number|'end') {
  const length=mm==='end'?'end':Math.max(1,Math.min(400,Math.round(mm*10)/10))
  const node=doc.createElement('span')
  node.dataset.answerLine=String(length)
  node.contentEditable='false'
  if(length!=='end')node.style.width=length+'mm'
  node.setAttribute('aria-label',length==='end'?'答题线铺到行末':length+'毫米答题线')
  node.textContent='\u00a0'
  return node
}

export function cleanHtml(value:string){
  const doc=new DOMParser().parseFromString(value,'text/html')
  const allowed=new Set(['P','DIV','BR','B','STRONG','I','EM','U','SUP','SUB','UL','OL','LI','TABLE','TBODY','THEAD','TR','TD','TH','SPAN'])
  for(const element of Array.from(doc.body.querySelectorAll('*')).reverse()){
    if(['SCRIPT','STYLE','IFRAME','OBJECT','IMG'].includes(element.tagName)){element.remove();continue}
    if(!allowed.has(element.tagName)){element.replaceWith(...Array.from(element.childNodes));continue}
    const raw=element.getAttribute('data-answer-line')
    if(element.tagName==='SPAN'&&raw==='end'){element.replaceWith(answerLine(doc,'end'));continue}
    const length=Number(raw)
    if(element.tagName==='SPAN'&&Number.isFinite(length)&&length>0){element.replaceWith(answerLine(doc,length));continue}
    const style=(element as HTMLElement).style
    const retained=[
      ['font-weight',/^(bold|[6-9]00)$/.test(style.fontWeight)?'bold':''],
      ['font-style',style.fontStyle==='italic'?'italic':''],
      ['text-decoration',/underline/.test(style.textDecoration+' '+style.textDecorationLine)?'underline':''],
      ['vertical-align',['super','sub'].includes(style.verticalAlign)?style.verticalAlign:''],
    ]
    for(const attr of Array.from(element.attributes))element.removeAttribute(attr.name)
    for(const [key,css] of retained)if(css)(element as HTMLElement).style.setProperty(key,css)
  }
  const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT)
  const texts:Text[]=[]
  while(walker.nextNode())texts.push(walker.currentNode as Text)
  for(const text of texts){
    if(text.parentElement?.closest('[data-answer-line]'))continue
    const underlined=!!text.parentElement?.closest('u,[style*="underline"]')
    const blank=underlined?/(_(?:[ \t\u00a0]*_)+|[ \t\u00a0]{2,})/g:/(_(?:[ \t\u00a0]*_)+)/g
    const parts=text.data.split(blank)
    if(parts.length===1)continue
    const fragment=doc.createDocumentFragment()
    parts.forEach((part,i)=>fragment.append(i%2?answerLine(doc,part.length*(part.includes('_')?1.42:.71)):part))
    text.replaceWith(fragment)
  }
  return doc.body.innerHTML
}

type Props={value:string;onChange:(value:string)=>void;readOnly?:boolean;toolbarHost?:HTMLElement|null;autoFocus?:boolean}

function fitLines(root:HTMLElement){
  for(const line of root.querySelectorAll<HTMLElement>('[data-answer-line="end"]')){
    const block=line.parentElement?.closest<HTMLElement>('p,div,li,td,th')??root
    // Give the probe one layout unit so consecutive fills wrap onto distinct rows.
    line.style.width='0.015625px'
    const rect=block.getBoundingClientRect(),css=getComputedStyle(block)
    // The paper editor lives in a scaled SVG. Convert viewport pixels back to layout pixels.
    const rightInset=parseFloat(css.paddingRight)+parseFloat(css.borderRightWidth)
    const leftInset=parseFloat(css.paddingLeft)+parseFloat(css.borderLeftWidth)
    const boxWidth=parseFloat(css.width)+(css.boxSizing==='border-box'?0:leftInset+rightInset)
    const scale=rect.width/boxWidth
    if(!Number.isFinite(scale)||scale<=0)continue
    const right=(rect.right-line.getBoundingClientRect().left)/scale
    line.style.width=Math.max(0,Math.floor((right-rightInset)*64)/64)+'px'
  }
}

export function RichEditor({value,onChange,readOnly=false,toolbarHost,autoFocus=false}:Props){
  const editor=useRef<HTMLDivElement>(null),lastRange=useRef<Range|null>(null)
  const lastValue=useRef<string|null>(null)
  const [length,setLength]=useState(30)
  useLayoutEffect(()=>{
    const root=editor.current
    if(!root||lastValue.current===value)return
    root.innerHTML=cleanHtml(value)
    lastValue.current=value
    fitLines(root)
  },[value])
  useLayoutEffect(()=>{
    const root=editor.current
    if(!root)return
    const observer=new ResizeObserver(()=>fitLines(root))
    observer.observe(root)
    return ()=>observer.disconnect()
  },[])
  function changed(){
    const root=editor.current!
    // Store the line's intent; its measured screen width belongs only to this editor.
    for(const line of root.querySelectorAll<HTMLElement>('[data-answer-line="end"]'))line.style.removeProperty('width')
    const html=root.innerHTML
    fitLines(root)
    lastValue.current=html
    onChange(html)
  }
  useEffect(()=>{if(autoFocus)editor.current?.focus({preventScroll:true})},[autoFocus])
  function remember(){
    const selection=window.getSelection()
    if(selection?.rangeCount&&editor.current?.contains(selection.getRangeAt(0).commonAncestorContainer))lastRange.current=selection.getRangeAt(0).cloneRange()
  }
  function rangeForEdit(){
    const root=editor.current
    if(!root||readOnly)return
    remember()
    root.focus({preventScroll:true})
    const saved=lastRange.current
    if(saved&&root.contains(saved.commonAncestorContainer))return saved
    const range=document.createRange()
    range.selectNodeContents(root);range.collapse(false)
    return range
  }
  function select(range:Range){
    const selection=window.getSelection()
    selection?.removeAllRanges();selection?.addRange(range)
    lastRange.current=range.cloneRange()
    changed()
  }
  function insert(html:string){
    const range=rangeForEdit()
    if(!range)return
    range.deleteContents()
    const fragment=range.createContextualFragment(cleanHtml(html)),last=fragment.lastChild
    range.insertNode(fragment)
    if(last)range.setStartAfter(last)
    range.collapse(true);select(range)
  }
  function format(tag:string){
    const range=rangeForEdit()
    if(!range)return
    if(tag==='u'&&range.collapsed){
      const selection=window.getSelection()
      selection?.removeAllRanges();selection?.addRange(range)
      document.execCommand('underline')
      return
    }
    if(range.collapsed)return
    const element=document.createElement(tag)
    element.append(range.extractContents());range.insertNode(element)
    range.selectNodeContents(element);select(range)
  }
  function pastePlain(text:string){
    const wrapper=document.createElement('div')
    for(const line of text.split(/\r?\n/)){const p=document.createElement('p');p.textContent=line;if(!line)p.append(document.createElement('br'));wrapper.append(p)}
    insert(wrapper.innerHTML)
  }
  const toolbar=<Space size={4} wrap className="rich-tools">
    {[{tag:'strong',label:'粗体',icon:<BoldOutlined/>},{tag:'em',label:'斜体',icon:<ItalicOutlined/>},{tag:'u',label:'下划线',icon:<UnderlineOutlined/>},{tag:'sup',label:'上标'},{tag:'sub',label:'下标'}].map(({tag,label,icon})=><Button size="small" key={tag} icon={icon} aria-label={label} title={label} disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>format(tag)}>{!icon&&label}</Button>)}
    <select aria-label="答题线长度" value={length} disabled={readOnly} onChange={e=>setLength(Number(e.target.value))}>{[15,30,45,60].map(n=><option key={n} value={n}>{n} mm</option>)}</select>
    <Button size="small" disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(answerLine(document,length).outerHTML)}>插入答题线</Button>
    <Button size="small" disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(answerLine(document,'end').outerHTML)}>铺到行末</Button>
    <Button size="small" aria-label="插入表格" title="插入表格" icon={<TableOutlined/>} disabled={readOnly} onMouseDown={e=>e.preventDefault()} onClick={()=>insert('<table><tr><td>内容</td><td>内容</td></tr><tr><td>内容</td><td>内容</td></tr></table><p><br></p>')}/>
  </Space>
  return <>{toolbarHost?createPortal(toolbar,toolbarHost):toolbarHost===undefined?toolbar:null}<div ref={editor} className="rich-editor" contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label="可粘贴 Word 内容的文字编辑框" data-placeholder="输入文字，或从 Word 粘贴" aria-multiline="true" onBlur={remember} onPointerUp={remember} onKeyUp={remember} onInput={()=>{if(!readOnly){remember();changed()}}} onPaste={e=>{e.preventDefault();if(readOnly)return;const html=e.clipboardData.getData('text/html');if(html)insert(html);else pastePlain(e.clipboardData.getData('text/plain'))}}/></>
}
