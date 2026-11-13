export type SessionLease={expires_at:number;server_time:number;user?:{id:string}}
export type StoredSession={token:string;expires_at?:number;deadline?:number;user_id?:string}
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>
export const sessionKey='omp-session'

export class SharedSession {
  private value:StoredSession|null=null
  private listeners=new Set<(value:StoredSession|null)=>void>()
  constructor(private storage:StorageLike,legacy:StorageLike,private now=Date.now){
    this.value=this.read()
    if(!storage.getItem('omp-session-migrated')){
      const token=legacy.getItem('omp-token')
      if(!this.value&&token)this.write({token,user_id:legacy.getItem('omp-review-user')||undefined})
      storage.setItem('omp-session-migrated','1')
    }
    legacy.removeItem('omp-token')
  }
  private read():StoredSession|null{
    try{const v=JSON.parse(this.storage.getItem(sessionKey)||'null');return v&&typeof v.token==='string'&&v.token?{token:v.token,...typeof v.expires_at==='number'&&Number.isFinite(v.expires_at)?{expires_at:v.expires_at}:{},...typeof v.deadline==='number'&&Number.isFinite(v.deadline)?{deadline:v.deadline}:{},...typeof v.user_id==='string'?{user_id:v.user_id}:{}}:null}catch{return null}
  }
  private emit(){for(const listener of this.listeners)listener(this.value)}
  private write(value:StoredSession|null){
    this.value=value
    if(value)this.storage.setItem(sessionKey,JSON.stringify(value));else this.storage.removeItem(sessionKey)
    this.emit()
  }
  snapshot(){return this.value}
  token(){return this.value?.token||''}
  subscribe(listener:(value:StoredSession|null)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  refresh(){const next=this.read();if(JSON.stringify(next)!==JSON.stringify(this.value)){this.value=next;this.emit()}}
  login(token:string,lease?:SessionLease){
    this.write({token,...lease?{expires_at:lease.expires_at,deadline:this.now()+Math.max(0,lease.expires_at-lease.server_time)*1000,user_id:lease.user?.id}:{}})
  }
  update(expected:string,lease:SessionLease){
    this.refresh()
    if(this.token()!==expected)return false
    const old=this.value!
    if(old.expires_at!==undefined&&lease.expires_at<old.expires_at)return true
    this.write({...old,expires_at:lease.expires_at,deadline:this.now()+Math.max(0,lease.expires_at-lease.server_time)*1000,...lease.user?{user_id:lease.user.id}:{}})
    return true
  }
  clear(expected?:string){
    this.refresh()
    if(expected&&this.value&&this.value.token!==expected)return false
    this.write(null);return true
  }
}

// Leading and trailing calls coalesce dense input without generating any idle
// renewal requests. The elapsed time refers to the last trusted interaction.
export class UserActivity {
  private last=-Infinity
  private sent=-Infinity
  private dirty=false
  private stopped=false
  private flight=false
  private timer:ReturnType<typeof setTimeout>|undefined
  constructor(private renew:(idleMs:number)=>Promise<unknown>,private now=Date.now,private schedule=setTimeout,private cancel=clearTimeout){}
  interact(trusted:boolean){
    if(!trusted||this.stopped)return
    this.last=this.now();this.dirty=true;this.queue()
  }
  private queue(){
    if(this.stopped||this.flight||this.timer||!this.dirty)return
    const delay=Math.max(0,1000-(this.now()-this.sent))
    if(delay)this.timer=this.schedule(()=>{this.timer=undefined;void this.flush()},delay)
    else void this.flush()
  }
  private async flush(){
    if(this.stopped||!this.dirty)return
    this.dirty=false;this.flight=true;this.sent=this.now()
    try{await this.renew(Math.max(0,this.sent-this.last))}catch{/* Network failures wait for a new user action. */}
    finally{this.flight=false;this.queue()}
  }
  flushPending(){
    if(this.stopped||!this.dirty)return
    if(this.timer){this.cancel(this.timer);this.timer=undefined}
    this.dirty=false;this.sent=this.now()
    void this.renew(Math.max(0,this.sent-this.last)).catch(()=>{})
  }
  stop(){this.stopped=true;if(this.timer)this.cancel(this.timer)}
}
