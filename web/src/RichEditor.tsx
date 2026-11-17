import { BoldOutlined, ItalicOutlined, UnderlineOutlined, TableOutlined,UndoOutlined,RedoOutlined,StrikethroughOutlined,AlignLeftOutlined,AlignCenterOutlined,AlignRightOutlined,OrderedListOutlined,UnorderedListOutlined } from '@ant-design/icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { App,Input,InputNumber,Popover,Select,Space,Tabs,Typography } from 'antd'
import { Button } from './Button'
import {paperFonts,paperFont,hexColor,pointLength,enclosedText,enclosedTextError,paragraphIndent,EditorHistory} from './richTextFormat'
import './richEditorTools.css'
import {paperSymbolGroups} from './paperSymbols'

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

function enclosedNode(doc:Document,value:string){
  const text=enclosedText(value),node=doc.createElement('span')
  if(enclosedTextError(text)){node.textContent=text;return node}
  node.dataset.enclosedText=text;node.contentEditable='false';node.textContent=text
  return node
}

export function cleanHtml(value:string){
  const doc=new DOMParser().parseFromString(value,'text/html')
  const allowed=new Set(['P','DIV','BR','B','STRONG','I','EM','U','SUP','SUB','UL','OL','LI','TABLE','TBODY','THEAD','TR','TD','TH','SPAN'])
  for(const original of Array.from(doc.body.querySelectorAll('*')).reverse()){
    let element=original as HTMLElement
    if(['SCRIPT','STYLE','IFRAME','OBJECT','IMG','SVG','MATH','LINK','META'].includes(element.tagName)){element.remove();continue}
    const strike=['S','STRIKE','DEL'].includes(element.tagName),font=element.tagName==='FONT',heading=/^H[1-6]$/.test(element.tagName)
    const legacyFace=font?element.getAttribute('face')||'':'',legacyColor=font?element.getAttribute('color')||'':'',legacySize=font?Number(element.getAttribute('size')):0
    const headingSize=heading?[24,20,18,16,14,12][Number(element.tagName[1])-1]:0
    if(font||strike||heading){
      const replacement=doc.createElement(heading?'p':'span')
      replacement.setAttribute('style',element.getAttribute('style')||'');replacement.append(...Array.from(element.childNodes));element.replaceWith(replacement);element=replacement
    }
    if(!allowed.has(element.tagName)){element.replaceWith(...Array.from(element.childNodes));continue}
    const raw=element.getAttribute('data-answer-line')
    if(element.tagName==='SPAN'&&raw==='end'){element.replaceWith(answerLine(doc,'end'));continue}
    const length=Number(raw)
    if(element.tagName==='SPAN'&&Number.isFinite(length)&&length>0){element.replaceWith(answerLine(doc,length));continue}
    const enclosed=element.getAttribute('data-enclosed-text')
    const style=element.style,block=['P','DIV','LI','TD','TH'].includes(element.tagName)
    const decoration=style.textDecoration+' '+style.textDecorationLine
    const retained:[string,string][]=[
      ['font-family',paperFont(style.fontFamily||legacyFace)],
      ['font-size',pointLength(style.fontSize||(legacySize?[8,10,12,14,18,24,36][Math.max(0,Math.min(6,legacySize-1))]+'pt':headingSize?headingSize+'pt':''),6,36)],
      ['color',hexColor(style.color||legacyColor)],['background-color',hexColor(style.backgroundColor)],
      ['font-weight',heading||/^(bold|[6-9]00)$/.test(style.fontWeight)?'bold':''],
      ['font-style',style.fontStyle==='italic'?'italic':''],
      ['text-decoration',[/underline/.test(decoration)?'underline':'',strike||/line-through/.test(decoration)?'line-through':''].filter(Boolean).join(' ')],
      ['vertical-align',['super','sub'].includes(style.verticalAlign)?style.verticalAlign:''],
    ]
    if(block)retained.push(
      ['text-align',['left','center','right','justify'].includes(style.textAlign)?style.textAlign:''],
      ['margin-left',pointLength(style.marginLeft,0,144)],['margin-right',pointLength(style.marginRight,0,144)],
      ['text-indent',pointLength(style.textIndent,-72,144)],['margin-top',pointLength(style.marginTop,0,72)],['margin-bottom',pointLength(style.marginBottom,0,72)],
    )
    if(element.tagName==='UL'&&['disc','circle','square'].includes(style.listStyleType))retained.push(['list-style-type',style.listStyleType])
    const leading=Number(element.getAttribute('data-line-leading')),lineHeight=pointLength(style.lineHeight,6,72)
    const orderedStart=element.tagName==='OL'?Number(element.getAttribute('start')):0,orderedType=element.getAttribute('type')||''
    for(const attr of Array.from(element.attributes))element.removeAttribute(attr.name)
    if(block&&(leading>=6&&leading<=72||lineHeight)){
      const points=leading>=6&&leading<=72?leading:parseFloat(lineHeight)
      element.setAttribute('data-line-leading',String(points));element.style.lineHeight=points+'pt'
    }
    if(element.tagName==='OL'){
      if(Number.isInteger(orderedStart)&&orderedStart>=1&&orderedStart<=9999)element.setAttribute('start',String(orderedStart))
      if(['1','a','A','i','I'].includes(orderedType))element.setAttribute('type',orderedType)
    }
    if(enclosed!==null&&element.tagName==='SPAN'){
      const replacement=enclosedNode(doc,enclosed);element.replaceWith(replacement);element=replacement
    }
    for(const [key,css] of retained)if(css)element.style.setProperty(key,css)
  }
  const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT),texts:Text[]=[]
  while(walker.nextNode())texts.push(walker.currentNode as Text)
  for(const text of texts){
    if(text.parentElement?.closest('[data-answer-line],[data-enclosed-text]'))continue
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

type Props={value:string;onChange:(value:string)=>void;readOnly?:boolean;toolbarHost?:HTMLElement|null;autoFocus?:boolean;textStyle?:React.CSSProperties}

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

type Bookmark={start:number[];startOffset:number;end:number[];endOffset:number}
type Snapshot={html:string;selection:Bookmark|null}
function nodePath(root:Node,node:Node){const path:number[]=[];while(node!==root&&node.parentNode){const parent=node.parentNode;path.unshift(Array.prototype.indexOf.call(parent.childNodes,node));node=parent}return path}
function followPath(root:Node,path:number[]){let node=root;for(const index of path){const child=node.childNodes[index];if(!child)break;node=child}return node}
function bookmark(root:HTMLElement,range:Range|null):Bookmark|null{return range&&root.contains(range.commonAncestorContainer)?{start:nodePath(root,range.startContainer),startOffset:range.startOffset,end:nodePath(root,range.endContainer),endOffset:range.endOffset}:null}
function restore(root:HTMLElement,mark:Bookmark|null){
  const range=document.createRange(),limit=(node:Node)=>node.nodeType===Node.TEXT_NODE?(node.textContent||'').length:node.childNodes.length
  if(mark){const start=followPath(root,mark.start),end=followPath(root,mark.end);range.setStart(start,Math.min(mark.startOffset,limit(start)));range.setEnd(end,Math.min(mark.endOffset,limit(end)))}
  else{range.selectNodeContents(root);range.collapse(false)}
  const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);return range
}

export function RichEditor({value,onChange,readOnly=false,toolbarHost,autoFocus=false,textStyle}:Props){
  const {message}=App.useApp()
  const editor=useRef<HTMLDivElement>(null),lastRange=useRef<Range|null>(null),lastValue=useRef<string|null>(null),lastHtml=useRef(''),composing=useRef(false)
  const history=useRef(new EditorHistory<Snapshot>())
  const [length,setLength]=useState(30),[lineCount,setLineCount]=useState(1),[lineNumber,setLineNumber]=useState('none'),[numberStart,setNumberStart]=useState(1)
  const [font,setFont]=useState(''),[fontSize,setFontSize]=useState(parseFloat(String(textStyle?.fontSize??13))),[textColor,setTextColor]=useState('#000000'),[highlight,setHighlight]=useState('#FFFF00')
  const [formats,setFormats]=useState<Record<string,boolean>>({}),[paragraphOpen,setParagraphOpen]=useState(false),[enclosureOpen,setEnclosureOpen]=useState(false),[circleText,setCircleText]=useState('')
  const [tableRows,setTableRows]=useState(2),[tableColumns,setTableColumns]=useState(2)
  const [paragraph,setParagraph]=useState({left:0,right:0,first:0,before:0,after:3,leading:parseFloat(String(textStyle?.lineHeight??20)),align:'left'})
  useLayoutEffect(()=>{
    const root=editor.current;if(!root||lastValue.current===value)return
    const html=cleanHtml(value);root.innerHTML=html;lastHtml.current=html;lastValue.current=value;lastRange.current=null
    history.current.reset({html,selection:null});fitLines(root)
  },[value])
  useLayoutEffect(()=>{
    const root=editor.current;if(!root)return
    const observer=new ResizeObserver(()=>fitLines(root));observer.observe(root)
    return()=>observer.disconnect()
  },[textStyle?.fontSize,textStyle?.lineHeight])
  useEffect(()=>{
    let cancelled=false
    const refit=()=>{if(!cancelled&&editor.current)fitLines(editor.current)}
    void document.fonts.ready.then(refit).catch(()=>{})
    document.fonts.addEventListener('loadingdone',refit)
    return()=>{cancelled=true;document.fonts.removeEventListener('loadingdone',refit)}
  },[])
  function remember(){
    const root=editor.current,selection=window.getSelection()
    if(!root||!selection?.rangeCount)return
    const range=selection.getRangeAt(0);if(!root.contains(range.commonAncestorContainer))return
    lastRange.current=range.cloneRange()
    let anchor=range.startContainer
    if(anchor.nodeType===Node.ELEMENT_NODE&&anchor.childNodes[range.startOffset])anchor=anchor.childNodes[range.startOffset]
    const element=(anchor.nodeType===Node.ELEMENT_NODE?anchor:anchor.parentElement) as HTMLElement|null
    if(element){const css=getComputedStyle(element);setFont(paperFont(css.fontFamily));setFontSize(Math.round(parseFloat(css.fontSize)*.75*100)/100);setTextColor(hexColor(css.color)||'#000000')}
    setFormats(Object.fromEntries(['bold','italic','underline','strikeThrough','superscript','subscript','insertOrderedList','insertUnorderedList'].map(command=>[command,document.queryCommandState(command)])))
  }
  useEffect(()=>{document.addEventListener('selectionchange',remember);return()=>document.removeEventListener('selectionchange',remember)},[])
  useEffect(()=>{if(autoFocus)editor.current?.focus({preventScroll:true})},[autoFocus])
  function changed(group='command'){
    const root=editor.current;if(!root)return
    for(const line of root.querySelectorAll<HTMLElement>('[data-answer-line="end"]'))line.style.removeProperty('width')
    remember();const html=cleanHtml(root.innerHTML),selection=bookmark(root,lastRange.current)
    if(html!==lastHtml.current){history.current.record({html,selection},group);lastHtml.current=html;lastValue.current=html;onChange(html)}
    fitLines(root)
  }
  function rangeForEdit(){
    const root=editor.current;if(!root||readOnly)return
    remember();root.focus({preventScroll:true})
    if(lastRange.current&&root.contains(lastRange.current.commonAncestorContainer))return lastRange.current
    const range=document.createRange();range.selectNodeContents(root);range.collapse(false);return range
  }
  function select(range:Range,commit=true){const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);lastRange.current=range.cloneRange();if(commit)changed()}
  function undo(redo=false){
    const root=editor.current;if(!root||readOnly)return
    const snapshot=redo?history.current.redo():history.current.undo();if(!snapshot)return
    root.innerHTML=snapshot.html;root.focus({preventScroll:true});lastRange.current=restore(root,snapshot.selection)
    lastHtml.current=snapshot.html;lastValue.current=snapshot.html;fitLines(root);remember();onChange(snapshot.html)
  }
  function command(name:string){const range=rangeForEdit();if(!range)return;select(range,false);document.execCommand('styleWithCSS',false,'true');document.execCommand(name);remember();changed()}
  function insert(html:string){
    const range=rangeForEdit();if(!range)return
    range.deleteContents();const fragment=range.createContextualFragment(cleanHtml(html)),last=fragment.lastChild;range.insertNode(fragment)
    if(last)range.setStartAfter(last);range.collapse(true);select(range)
  }
  function insertText(text:string){const node=document.createElement('span');node.textContent=text;insert(node.innerHTML)}
  function inlineStyle(property:string,css:string){
    const root=editor.current,range=rangeForEdit();if(!root||!range)return
    if(range.collapsed){const span=document.createElement('span');span.style.setProperty(property,css);span.textContent='\u200b';range.insertNode(span);range.setStart(span.firstChild!,1);range.collapse(true);select(range);return}
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[]
    while(walker.nextNode()){const node=walker.currentNode as Text;if(range.intersectsNode(node)&&!node.parentElement?.closest('[contenteditable="false"]'))nodes.push(node)}
    const wrappers:HTMLElement[]=[]
    for(const node of nodes.reverse()){
      const start=node===range.startContainer?range.startOffset:0,end=node===range.endContainer?range.endOffset:node.length
      if(end<=start)continue
      const part=node.splitText(start);part.splitText(end-start)
      const span=document.createElement('span');span.style.setProperty(property,css);part.replaceWith(span);span.append(part);wrappers.unshift(span)
    }
    for(const token of root.querySelectorAll<HTMLElement>('[data-enclosed-text]'))if(range.intersectsNode(token))token.style.setProperty(property,css)
    if(wrappers.length){range.setStartBefore(wrappers[0]);range.setEndAfter(wrappers[wrappers.length-1])}
    select(range)
  }
  function blocksForEdit(range:Range){
    const root=editor.current!;let blocks=[...root.querySelectorAll<HTMLElement>('p,div,li,td,th')].filter(block=>range.intersectsNode(block)&&!block.querySelector('p,div,li'))
    if(range.collapsed){const block=(range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement)?.closest<HTMLElement>('p,div,li,td,th');blocks=block&&block!==root&&root.contains(block)?[block]:[]}
    if(!blocks.length){select(range,false);document.execCommand('formatBlock',false,'p');remember();const block=lastRange.current?.startContainer.parentElement?.closest<HTMLElement>('p,div,li,td,th');if(block&&block!==root)blocks=[block]}
    return blocks
  }
  function blockStyle(property:string,css:string){const range=rangeForEdit();if(!range)return;for(const block of blocksForEdit(range))block.style.setProperty(property,css);remember();changed()}
  function indent(offset:number){const range=rangeForEdit();if(!range)return;for(const block of blocksForEdit(range)){const current=parseFloat(pointLength(block.style.marginLeft,0,144))||0;block.style.marginLeft=Math.max(0,Math.min(144,current+offset))+'pt'}remember();changed()}
  function clearFormat(){const range=rangeForEdit();if(!range)return;select(range,false);document.execCommand('removeFormat');for(const block of blocksForEdit(range)){block.removeAttribute('style');block.removeAttribute('data-line-leading')}remember();changed()}
  function openParagraph(open:boolean){
    setParagraphOpen(open);if(!open)return
    const range=lastRange.current,root=editor.current;if(!range||!root)return
    const block=(range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement)?.closest<HTMLElement>('p,div,li,td,th');if(!block)return
    const css=getComputedStyle(block),points=(text:string)=>Math.round((parseFloat(text)||0)*.75*100)/100
    setParagraph({left:points(css.marginLeft),right:points(css.marginRight),first:points(css.textIndent),before:points(css.marginTop),after:points(css.marginBottom),leading:points(css.lineHeight)||parseFloat(String(textStyle?.lineHeight??20)),align:['left','center','right','justify'].includes(css.textAlign)?css.textAlign:'left'})
  }
  function applyParagraph(){
    const range=rangeForEdit();if(!range)return
    const settings={...paragraph,left:paragraphIndent(paragraph.left,paragraph.first)}
    for(const block of blocksForEdit(range)){
      block.style.textAlign=settings.align
      for(const [key,property] of [['left','margin-left'],['right','margin-right'],['first','text-indent'],['before','margin-top'],['after','margin-bottom']] as const)block.style.setProperty(property,settings[key]+'pt')
      block.dataset.lineLeading=String(settings.leading);block.style.lineHeight=settings.leading+'pt'
    }
    setParagraph(settings);setParagraphOpen(false);remember();changed()
  }
  function setLineHeight(points:string){
    const range=rangeForEdit(),root=editor.current,sel=window.getSelection()
    if(!range||!root||!sel)return
    range.collapse(true)
    sel.removeAllRanges();sel.addRange(range)
    const anchor=range.startContainer
    const block=(anchor.nodeType===1?anchor as Element:anchor.parentElement)?.closest<HTMLElement>('p,div,li,td,th')
    if(!block||!root.contains(block))return
    // Use the displayed line boundaries, including soft wraps inside Word paragraphs.
    sel.modify('move','backward','lineboundary')
    sel.modify('extend','forward','lineboundary')
    const lineRange=sel.getRangeAt(0).cloneRange()
    if(!block.contains(lineRange.commonAncestorContainer))return
    const before=document.createRange(),after=document.createRange()
    before.selectNodeContents(block);before.setEnd(lineRange.startContainer,lineRange.startOffset)
    after.selectNodeContents(block);after.setStart(lineRange.endContainer,lineRange.endOffset)
    const prefix=before.cloneContents(),suffix=after.cloneContents()
    const line=document.createElement('div')
    line.append(lineRange.cloneContents())
    if(!line.hasChildNodes())line.append(document.createElement('br'))
    if(points){line.dataset.lineLeading=points;line.style.lineHeight=points+'pt'}
    const fragment=document.createDocumentFragment()
    function appendSide(content:DocumentFragment,first:boolean){
      const edge=first?content.lastChild:content.firstChild
      if(edge instanceof HTMLBRElement)edge.remove()
      if(!content.textContent&&!content.querySelector('br,table,[data-answer-line]'))return
      if(block===root||['TD','TH','LI'].includes(block!.tagName)){
        const wrapper=document.createElement('div')
        if(content.querySelector('div,p,table'))fragment.append(content)
        else {wrapper.append(content);fragment.append(wrapper)}
      }else{
        const wrapper=block!.cloneNode(false) as HTMLElement
        wrapper.append(content);fragment.append(wrapper)
      }
    }
    appendSide(prefix,true);fragment.append(line);appendSide(suffix,false)
    if(block===root||['TD','TH','LI'].includes(block.tagName))block.replaceChildren(fragment)
    else block.replaceWith(fragment)
    range.selectNodeContents(line);range.collapse(false);select(range)
  }
  function pastePlain(text:string){const wrapper=document.createElement('div');for(const line of text.split(/\r?\n/)){const paragraph=document.createElement('p');paragraph.textContent=line;if(!line)paragraph.append(document.createElement('br'));wrapper.append(paragraph)}insert(wrapper.innerHTML)}
  function editTable(action:string){
    const range=rangeForEdit(),root=editor.current;if(!range||!root)return
    const cell=(range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement)?.closest<HTMLTableCellElement>('td,th'),table=cell?.closest<HTMLTableElement>('table')
    if(!cell||!table||!root.contains(table))return
    const row=cell.parentElement as HTMLTableRowElement,column=cell.cellIndex,rowIndex=row.rowIndex
    let target:HTMLElement|undefined
    if(action==='table'||action==='row-delete'&&table.rows.length===1||action==='column-delete'&&row.cells.length===1){const after=document.createElement('p');after.append(document.createElement('br'));table.replaceWith(after);target=after}
    else if(action==='row-before'||action==='row-after'){const added=table.insertRow(rowIndex+(action==='row-after'?1:0));for(let index=0;index<row.cells.length;index++)added.insertCell().append(document.createElement('br'));target=added.cells[Math.min(column,added.cells.length-1)]}
    else if(action==='row-delete'){table.deleteRow(rowIndex);target=table.rows[Math.min(rowIndex,table.rows.length-1)]?.cells[column]}
    else if(action==='column-before'||action==='column-after'){const index=column+(action==='column-after'?1:0);for(const item of Array.from(table.rows))item.insertCell(Math.min(index,item.cells.length)).append(document.createElement('br'));target=table.rows[rowIndex]?.cells[index]}
    else if(action==='column-delete'){for(const item of Array.from(table.rows))if(item.cells[column])item.deleteCell(column);target=table.rows[rowIndex]?.cells[Math.max(0,column-1)]}
    if(target){range.selectNodeContents(target);range.collapse(true);select(range)}else changed()
  }
  function insertTable(){const table=document.createElement('table'),rows=Math.max(1,Math.min(30,Math.trunc(tableRows||2))),columns=Math.max(1,Math.min(12,Math.trunc(tableColumns||2)));for(let row=0;row<rows;row++){const line=table.insertRow();for(let column=0;column<columns;column++)line.insertCell().append(document.createElement('br'))}insert(table.outerHTML+'<p><br></p>')}
  function insertLines(){const fragment=document.createElement('div'),count=Math.max(1,Math.min(100,Math.trunc(lineCount||1)));for(let index=0;index<count;index++){const line=document.createElement('div');if(lineNumber!=='none'){const number=numberStart+index;line.append(lineNumber==='circle'&&number>=1&&number<=20?String.fromCodePoint(0x2460+number-1):lineNumber==='dot'?number+'. ':`（${number}）`)}line.append(answerLine(document,length));fragment.append(line)}insert(fragment.innerHTML)}
  function insertEnclosure(){const error=enclosedTextError(circleText);if(error){message.warning(error);return}insert(enclosedNode(document,circleText).outerHTML);setEnclosureOpen(false)}
  const preserve=(event:React.MouseEvent)=>event.preventDefault()
  const tool=(label:string,action:()=>void,icon?:React.ReactNode,pressed?:boolean)=><Button size="small" icon={icon} aria-label={label} title={label} aria-pressed={pressed} disabled={readOnly} onMouseDown={preserve} onClick={action}>{!icon&&label}</Button>
  const symbolGroups=paperSymbolGroups
  const paragraphPanel=<div className="rich-tool-panel"><div className="rich-tool-panel-grid">{([{key:'left',label:'左缩进',min:0,max:144},{key:'right',label:'右缩进',min:0,max:144},{key:'first',label:'首行缩进',min:-72,max:144},{key:'before',label:'段前间距',min:0,max:72},{key:'after',label:'段后间距',min:0,max:72},{key:'leading',label:'段落行距',min:6,max:72}] as const).map(field=><label key={field.key}>{field.label}（磅）<InputNumber min={field.min} max={field.max} value={paragraph[field.key]} onChange={value=>{if(value!==null)setParagraph(current=>({...current,[field.key]:value}))}}/></label>)}<label>对齐<Select value={paragraph.align} options={[{value:'left',label:'左对齐'},{value:'center',label:'居中'},{value:'right',label:'右对齐'},{value:'justify',label:'两端对齐'}]} onChange={align=>setParagraph(current=>({...current,align}))}/></label></div><Button type="primary" size="small" style={{marginTop:12}} onMouseDown={preserve} onClick={applyParagraph}>应用段落设置</Button></div>
  const linePanel=<Space direction="vertical" className="rich-tool-panel"><Space wrap><label>长度（毫米）<InputNumber min={1} max={400} value={length} onChange={value=>{if(value!==null)setLength(value)}}/></label><label>行数<InputNumber min={1} max={100} precision={0} value={lineCount} onChange={value=>{if(value!==null)setLineCount(value)}}/></label></Space><Space wrap><Select aria-label="答题线编号样式" value={lineNumber} options={[{value:'none',label:'无编号'},{value:'paren',label:'（1）'},{value:'circle',label:'①'},{value:'dot',label:'1.'}]} onChange={setLineNumber}/><label>起始序号<InputNumber min={1} max={9999} precision={0} value={numberStart} onChange={value=>{if(value!==null)setNumberStart(value)}}/></label></Space><Space>{tool('插入横线',insertLines)}{tool('当前行铺满',()=>insert(answerLine(document,'end').outerHTML))}</Space></Space>
  const tablePanel=<Space direction="vertical" className="rich-tool-panel"><Space><label>行<InputNumber min={1} max={30} precision={0} value={tableRows} onChange={value=>{if(value!==null)setTableRows(value)}}/></label><label>列<InputNumber min={1} max={12} precision={0} value={tableColumns} onChange={value=>{if(value!==null)setTableColumns(value)}}/></label>{tool('插入表格',insertTable)}</Space><Typography.Text type="secondary">将光标放入单元格后，可增删行列。</Typography.Text><Space wrap>{[['row-before','上方插行'],['row-after','下方插行'],['column-before','左侧插列'],['column-after','右侧插列'],['row-delete','删除行'],['column-delete','删除列'],['table','删除表格']].map(([action,label])=><Button key={action} size="small" disabled={readOnly} onMouseDown={preserve} onClick={()=>editTable(action)}>{label}</Button>)}</Space></Space>
  const enclosurePanel=<Space direction="vertical" className="rich-tool-panel"><label>带圈文字（1–8 字）<Input value={circleText} status={circleText&&enclosedTextError(circleText)?'error':undefined} aria-label="带圈文字内容" onChange={event=>setCircleText(event.target.value)} onPressEnter={insertEnclosure}/></label>{circleText&&enclosedTextError(circleText)&&<Typography.Text type="danger">{enclosedTextError(circleText)}</Typography.Text>}<Button type="primary" size="small" disabled={!!enclosedTextError(circleText)} onMouseDown={preserve} onClick={insertEnclosure}>插入带圈文字</Button></Space>
  const toolbar=<Space size={4} wrap className="rich-tools" onPointerDownCapture={()=>remember()}>
    <span className="rich-tools-group">{tool('撤销',()=>undo(),<UndoOutlined/>)}{tool('重做',()=>undo(true),<RedoOutlined/>)}</span>
    <span className="rich-tools-group"><select aria-label="字体" value={font} disabled={readOnly} onChange={event=>{setFont(event.target.value);inlineStyle('font-family',event.target.value||'OMP Sans')}}><option value="">跟随整卡</option>{paperFonts.map(family=><option key={family.value} value={family.value}>{family.label}</option>)}</select><label>字号<input type="number" min={6} max={36} aria-label="字号（磅）" value={fontSize} disabled={readOnly} onChange={event=>setFontSize(Number(event.target.value))} onBlur={()=>{if(fontSize>=6&&fontSize<=36)inlineStyle('font-size',fontSize+'pt')}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}}}/></label></span>
    <span className="rich-tools-group">{tool('粗体',()=>command('bold'),<BoldOutlined/>,formats.bold)}{tool('斜体',()=>command('italic'),<ItalicOutlined/>,formats.italic)}{tool('下划线',()=>command('underline'),<UnderlineOutlined/>,formats.underline)}{tool('删除线',()=>command('strikeThrough'),<StrikethroughOutlined/>,formats.strikeThrough)}{tool('上标',()=>command('superscript'),undefined,formats.superscript)}{tool('下标',()=>command('subscript'),undefined,formats.subscript)}</span>
    <span className="rich-tools-group"><label>文字<input type="color" aria-label="文字颜色" value={textColor} disabled={readOnly} onChange={event=>{setTextColor(event.target.value);inlineStyle('color',event.target.value)}}/></label><label>底色<input type="color" aria-label="文字底色" value={highlight} disabled={readOnly} onChange={event=>{setHighlight(event.target.value);inlineStyle('background-color',event.target.value)}}/></label>{tool('清除格式',clearFormat)}</span>
    <span className="rich-tools-group">{tool('左对齐',()=>blockStyle('text-align','left'),<AlignLeftOutlined/>)}{tool('居中',()=>blockStyle('text-align','center'),<AlignCenterOutlined/>)}{tool('右对齐',()=>blockStyle('text-align','right'),<AlignRightOutlined/>)}{tool('两端对齐',()=>blockStyle('text-align','justify'))}{tool('减少缩进',()=>indent(-18))}{tool('增加缩进',()=>indent(18))}{tool('编号列表',()=>command('insertOrderedList'),<OrderedListOutlined/>,formats.insertOrderedList)}{tool('项目符号',()=>command('insertUnorderedList'),<UnorderedListOutlined/>,formats.insertUnorderedList)}</span>
    <label>当前行距<select aria-label="当前行距" value="" disabled={readOnly} onChange={event=>setLineHeight(event.target.value==='inherit'?'':event.target.value)}><option value="" disabled>设置</option><option value="inherit">跟随整卡</option>{[...new Set([fontSize,13,16,18,20,22,24,28,32,36,42,48,60,72])].filter(points=>points>=fontSize).sort((a,b)=>a-b).map(points=><option key={points} value={points}>{points} 磅</option>)}</select></label>
    <Popover trigger="click" title="段落" open={paragraphOpen} onOpenChange={openParagraph} content={paragraphPanel}>{tool('段落设置',()=>{})}</Popover>
    <Popover trigger="click" title="答题横线" content={linePanel}>{tool('横线',()=>{})}</Popover>
    <Popover trigger="click" title="序号与特殊符号" content={<div className="rich-tool-panel"><Tabs size="small" items={symbolGroups.map(group=>({key:group.key,label:group.label,children:<div className="rich-symbol-grid">{group.symbols.map(symbol=><Button size="small" key={symbol} onMouseDown={preserve} disabled={readOnly} onClick={()=>insertText(symbol)}>{symbol}</Button>)}</div>}))}/></div>}>{tool('序号 / 符号',()=>{})}</Popover>
    <Popover trigger="click" title="带圈文字" open={enclosureOpen} onOpenChange={open=>{setEnclosureOpen(open);if(open)setCircleText(window.getSelection()?.toString()||'')}} content={enclosurePanel}>{tool('带圈文字',()=>{})}</Popover>
    <Popover trigger="click" title="表格" content={tablePanel}>{tool('表格',()=>{},<TableOutlined/>)}</Popover>
  </Space>
  return <>{toolbarHost?createPortal(toolbar,toolbarHost):toolbarHost===undefined?toolbar:null}<div ref={editor} className="rich-editor" style={textStyle} contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label="可粘贴 Word 内容的文字编辑框" data-placeholder="输入文字，或从 Word 粘贴" aria-multiline="true"
    onBlur={remember} onPointerUp={()=>{history.current.breakGroup();remember()}} onKeyUp={remember}
    onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false;remember();changed('typing')}}
    onInput={()=>{if(!readOnly&&!composing.current){remember();changed('typing')}}}
    onBeforeInput={event=>{const type=(event.nativeEvent as InputEvent).inputType;if(type==='historyUndo'||type==='historyRedo'){event.preventDefault();undo(type==='historyRedo')}}}
    onKeyDown={event=>{
      if(readOnly||event.nativeEvent.isComposing)return
      if((event.ctrlKey||event.metaKey)&&!event.altKey){const key=event.key.toLowerCase();if(key==='z'||key==='y'){event.preventDefault();undo(key==='y'||event.shiftKey)}else if(['b','i','u'].includes(key)){event.preventDefault();command(({b:'bold',i:'italic',u:'underline'} as Record<string,string>)[key])}}
    }}
    onDoubleClick={event=>{const token=(event.target as Element).closest<HTMLElement>('[data-enclosed-text]');if(token&&editor.current?.contains(token)&&!readOnly){const range=document.createRange();range.selectNode(token);select(range,false);setCircleText(token.dataset.enclosedText||token.textContent||'');setEnclosureOpen(true)}}}
    onPaste={event=>{event.preventDefault();if(readOnly)return;const html=event.clipboardData.getData('text/html');if(html)insert(html);else pastePlain(event.clipboardData.getData('text/plain'))}}/></>
}
