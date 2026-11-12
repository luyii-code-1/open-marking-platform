import { lockReviewUpdate, settleReviewWrites } from './reviewStore'
import { hasUnsavedChanges } from './useNavigation'
import { canAutomaticallyUpdate, hasPendingMutations, watchMutations } from './updatePolicy'

let committing=false
let prepareTimer:ReturnType<typeof setTimeout>|undefined
let lastActivity=Date.now()
let preparing:{source:ServiceWorker|null;requestId:string}|undefined
const editedForms=new Set<HTMLFormElement>()
function cancelPreparation(){
  if(!preparing||committing)return
  preparing.source?.postMessage({type:'UPDATE_CANCEL',requestId:preparing.requestId})
  preparing=undefined;clearTimeout(prepareTimer);lockReviewUpdate(false)
}
export function canPreparePwaUpdate(){
  for(const form of editedForms)if(!form.isConnected)editedForms.delete(form)
  const focused=document.activeElement as HTMLElement|null
  const editing=!!focused&&(focused.matches('input,textarea,select,[role="textbox"]')||focused.isContentEditable)
  return canAutomaticallyUpdate({now:Date.now(),lastActivity,editing,mutating:hasPendingMutations(),dirty:hasUnsavedChanges()||editedForms.size>0})
}
function activity(event:Event){
  lastActivity=Date.now()
  cancelPreparation()
  if(event.type==='input'||event.type==='change'){
    const form=(event.target as HTMLElement|null)?.closest?.('form')
    if(form)editedForms.add(form)
  }
}
for(const name of ['pointerdown','keydown','input','change'])window.addEventListener(name,activity,{capture:true,passive:true})
watchMutations(cancelPreparation)
export function reportPwaReady(){navigator.serviceWorker?.controller?.postMessage({type:'CLIENT_READY',build:document.querySelector('meta[name="omp-build"]')?.getAttribute('content')})}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message',event=>{
    const value=event.data
    if(value?.type==='CHECK_UPDATE'){
      if(!canPreparePwaUpdate()){
        (event.source as ServiceWorker|null)?.postMessage({type:'UPDATE_READY',requestId:value.requestId,ready:false})
        return
      }
      preparing={source:event.source as ServiceWorker|null,requestId:value.requestId}
      lockReviewUpdate(true)
      clearTimeout(prepareTimer)
      prepareTimer=setTimeout(cancelPreparation,12000)
      void settleReviewWrites().then(()=>{
        (event.source as ServiceWorker|null)?.postMessage({type:'UPDATE_READY',requestId:value.requestId,ready:preparing?.requestId===value.requestId&&canPreparePwaUpdate()})
      }).catch(()=>(event.source as ServiceWorker|null)?.postMessage({type:'UPDATE_READY',requestId:value.requestId,ready:false}))
    }else if(value?.type==='UPDATE_ABORTED'){
      clearTimeout(prepareTimer);lockReviewUpdate(false);committing=false;preparing=undefined
    }else if(value?.type==='UPDATE_COMMIT'){clearTimeout(prepareTimer);committing=true;preparing=undefined}
  })
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(committing)location.reload();else reportPwaReady()})
  reportPwaReady()
}
