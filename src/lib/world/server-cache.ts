import {recordSourceCheck} from '@/lib/source-health-reporter';
/** Process-local bounded cache; no request URL is accepted from the browser. */
export class ProviderCache {
 private values=new Map<string,{until:number;value:unknown}>();
 private pending=new Map<string,Promise<unknown>>();
 private next=0; private failures=0;
 private day=0; private calls=0;
 private lastError:string|null=null;
 constructor(readonly id:string,readonly ttl:number,readonly interval:number,readonly capacity=24,readonly dailyLimit=500){}
 inspect<T>(key:string){const entry=this.values.get(key);return {value:entry?.value as T|undefined,age_ms:entry?Math.max(0,Date.now()-(entry.until-this.ttl)):null,state:entry&&entry.until>Date.now()?'HIT':this.pending.has(key)?'COALESCED':'MISS',retry_after_ms:Math.max(this.pending.size?2000:0,this.next-Date.now()),last_error:this.lastError};}
 async get<T>(key:string,load:()=>Promise<T>):Promise<T>{
  const saved=this.values.get(key);if(saved&&saved.until>Date.now())return saved.value as T;
  const running=this.pending.get(key);if(running)return running as Promise<T>;
  if(this.pending.size||Date.now()<this.next)throw new Error('PROVIDER_BACKOFF');
  const day=Math.floor(Date.now()/86400000);if(day!==this.day){this.day=day;this.calls=0;}if(this.calls>=this.dailyLimit)throw new Error('DAILY_PROVIDER_BUDGET');this.calls++;
  this.next=Date.now()+this.interval;const start=Date.now();
  const job=load().then(value=>{
   this.failures=0;this.lastError=null;if(this.values.size>=this.capacity)this.values.delete(this.values.keys().next().value!);
   this.values.set(key,{value,until:Date.now()+this.ttl});
   const result=(value&&typeof value==='object'?value:{}) as {records?:{observed_at?:string|null}[];frames?:{time:number}[]};
   const dates=(result.records||[]).map(r=>r.observed_at).filter((v):v is string=>!!v&&Number.isFinite(Date.parse(v))).sort();
   recordSourceCheck({source:{id:`world:${this.id}`,name:this.id,category:this.id==='overpass'?'static':this.id==='open-meteo'||this.id==='rainviewer'?'weather':'news',endpoint:this.id},sample:{ok:true,latency_ms:Date.now()-start,record_count:result.records?.length??result.frames?.length,data_at:dates.at(-1)||(result.frames?.length?new Date(result.frames.at(-1)!.time).toISOString():undefined)}});return value;
  }).catch(error=>{
   this.lastError=error instanceof Error?error.message:'NETWORK_OR_PARSE';
   this.failures++;this.next=Date.now()+Math.min(3600000,Math.max(60000,this.interval)*2**Math.min(this.failures,6));
   recordSourceCheck({source:{id:`world:${this.id}`,name:this.id,category:this.id==='overpass'?'static':this.id==='open-meteo'||this.id==='rainviewer'?'weather':'news',endpoint:this.id},sample:{ok:false,latency_ms:Math.min(300000,Date.now()-start),error_category:/^HTTP_\d+$/.test(error.message)?error.message:'NETWORK_OR_PARSE'}});throw error;
  }).finally(()=>this.pending.delete(key));this.pending.set(key,job);return job;
 }
}
export async function boundedJSON(url:string,init:RequestInit={},max=8*1024*1024):Promise<unknown>{
 const res=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(20000),cache:'no-store',headers:{'User-Agent':'OSIRIS-local/3.0 (+https://github.com/DrNeuralDog/osiris_with_ontologies)',...init.headers}});
 if(!res.ok){await res.body?.cancel();throw new Error(`HTTP_${res.status}`);}return readBoundedJSON(res,max);
}
export async function readBoundedJSON(res:Response,max:number):Promise<unknown>{
 const reader=res.body?.getReader();if(!reader)throw new Error('EMPTY_RESPONSE');
 const chunks:Uint8Array[]=[];let bytes=0;try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>max){await reader.cancel();throw new Error('PAYLOAD_LIMIT');}chunks.push(r.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{reader.releaseLock();}
}
