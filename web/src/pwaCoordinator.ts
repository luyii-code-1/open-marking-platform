import { lockReviewUpdate, settleReviewWrites } from './reviewStore'
import { hasUnsavedChanges } from './useNavigation'

let committing=false
let prepareTimer:ReturnType<typeof setTimeout>|undefined
export function reportPwaReady(){navigator.serviceWorker?.controller?.postMessage({type:'CLIENT_READY',build:document.querySelector('meta[name="omp-build"]')?.getAttribute('content')})}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message',event=>{
    const value=event.data
    if(value?.type==='CHECK_UPDATE'){
      lockReviewUpdate(true)
      clearTimeout(prepareTimer)
      prepareTimer=setTimeout(()=>{if(!committing){lockReviewUpdate(false);window.dispatchEvent(new Event('omp-update-aborted'))}},12000)
      void settleReviewWrites().then(()=>{
        (event.source as ServiceWorker|null)?.postMessage({type:'UPDATE_READY',requestId:value.requestId,ready:!hasUnsavedChanges()})
      }).catch(()=>(event.source as ServiceWorker|null)?.postMessage({type:'UPDATE_READY',requestId:value.requestId,ready:false}))
    }else if(value?.type==='UPDATE_ABORTED'){
      clearTimeout(prepareTimer);lockReviewUpdate(false);committing=false;window.dispatchEvent(new Event('omp-update-aborted'))
    }else if(value?.type==='UPDATE_COMMIT'){clearTimeout(prepareTimer);committing=true}
  })
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(committing)location.reload();else reportPwaReady()})
  reportPwaReady()
}
