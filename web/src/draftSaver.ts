export type DraftValue={id:string;draft_version?:number}
export type DraftWrite<T>={value:T;request_id:string;base_version:number}

// One writer per editor; edits made during a request remain pending for the next save.
export class DraftSaver<T extends DraftValue>{
  value:T
  dirty=false
  saving=false
  error=''
  savedAt=0
  private generation=0
  private pending?:DraftWrite<T>&{generation:number}
  private running?:Promise<T>
  constructor(value:T,private write:(request:DraftWrite<T>)=>Promise<T>,private notify:()=>void){this.value=value}
  edit(value:T){this.value=value;this.generation++;this.dirty=true;this.error='';this.notify()}
  load(value:T){if(this.saving)throw new Error('草稿正在保存，请稍后切换');this.value=value;this.generation++;this.pending=undefined;this.dirty=false;this.error='';this.savedAt=0;this.notify()}
  flush():Promise<T>{
    if(this.running)return this.running
    if(!this.dirty)return Promise.resolve(this.value)
    this.saving=true;this.error=''
    this.running=(async()=>{
      try{
        while(this.dirty){
          const job=this.pending||{value:structuredClone(this.value),request_id:crypto.randomUUID(),base_version:this.value.draft_version||0,generation:this.generation}
          this.pending=job
          const saved=await this.write(job)
          this.pending=undefined;this.savedAt=Date.now()
          this.dirty=this.generation!==job.generation
          this.value=this.dirty?{...this.value,id:saved.id,draft_version:saved.draft_version}:saved
          this.notify()
        }
        return this.value
      }catch(error){this.error=(error as Error).message;throw error}
      finally{this.saving=false;this.running=undefined;this.notify()}
    })()
    this.notify()
    return this.running
  }
}
