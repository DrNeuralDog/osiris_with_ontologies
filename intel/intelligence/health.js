const M=require('../ontology/model');
const {healthState,freshness,retryDelay,integer,policy:effectivePolicy}=require('./policy');
const SOURCE_ID=/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
function sourceId(id){M.check(typeof id==='string'&&SOURCE_ID.test(id),'Invalid source ID');return id;}
class SourceHealth {
 constructor(store){this.store=store;}
 async register(raw){
  const id=sourceId(raw.id),category=M.text(raw.category,'category',40),name=M.text(raw.name,'source name',160);
  M.check(['provider','camera','service'].includes(raw.scope||'provider'),'Invalid source scope');
  const endpoint=M.text(raw.endpoint||id,'endpoint identifier',300),policy=M.jsonObject(raw.policy);
  for(const key of Object.keys(policy)) { M.check(['live','fresh','historical'].includes(key),'Invalid freshness policy'); integer(policy[key],0,1,31536000,key); }
  const thresholds=effectivePolicy(category,policy);
  M.check(thresholds.live<=thresholds.fresh&&thresholds.fresh<=thresholds.historical,'Invalid freshness order');
  await this.store.transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(782341005)');
  const exists=(await db.query('SELECT 1 FROM intelligence_sources WHERE id=$1',[id])).rowCount;
  if(!exists){const count=(await db.query('SELECT count(*)::int n FROM intelligence_sources WHERE scope=$1',[raw.scope||'provider'])).rows[0].n;M.check(count<(raw.scope==='camera'?2000:500),'Source registry capacity reached');}
  await db.query(`INSERT INTO intelligence_sources(id,name,category,endpoint,scope,parent_id,policy,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,endpoint=excluded.endpoint,policy=excluded.policy || intelligence_sources.policy,updated_at=now()`,[id,name,category,endpoint,raw.scope||'provider',raw.parent_id||null,policy,raw.enabled!==false]);
  });
  return id;
 }
 async record(id,raw,now=Date.now()){
  sourceId(id); M.check(raw&&typeof raw.ok==='boolean','Health result required');
  const latency=raw.latency_ms==null?null:integer(Math.round(raw.latency_ms),0,0,300000,'latency'),http=raw.http_status==null?null:integer(raw.http_status,200,100,599,'HTTP status');
  const count=raw.record_count==null?null:integer(raw.record_count,0,0,10000000,'record count'),at=M.timestamp(raw.checked_at)||new Date(now).toISOString();
  M.check(Math.abs(new Date(at).getTime()-now)<3600000,'Health sample too old or future');
  const dataAt=M.timestamp(raw.data_at),error=raw.ok?null:M.text(raw.error_category||'UNKNOWN','error category',80);
  const media=raw.camera_media==null?null:M.jsonObject(raw.camera_media);
  if(media){M.check(Object.keys(media).every(k=>['snapshot_status','stream_status'].includes(k)),'Invalid camera media fields');M.check(['SNAPSHOT_AVAILABLE','SNAPSHOT_UNAVAILABLE','UNKNOWN'].includes(media.snapshot_status),'Invalid snapshot status');M.check(['UNKNOWN','EXTERNAL_ONLY','STREAM_UNSUPPORTED'].includes(media.stream_status),'Server snapshot probe cannot certify video');}
  return this.store.transaction(async db=>{
   const row=(await db.query('SELECT * FROM intelligence_sources WHERE id=$1 FOR UPDATE',[id])).rows[0]; if(!row)throw new M.InputError('Source not found',404);
   if(media)M.check(row.scope==='camera','Media health requires camera scope');
   // Coalesce probes from many tabs; successes and failures remain real upstream attempts.
   if(row.last_checked_at&&new Date(at)-new Date(row.last_checked_at)<1000&&raw.ok===(row.consecutive_failures===0))return {coalesced:true};
   const failures=raw.ok?0:row.consecutive_failures+1;
   await db.query(`INSERT INTO intelligence_source_samples(source_id,checked_at,ok,latency_ms,error_category,http_status,record_count,data_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,at,raw.ok,latency,error,http,count,dataAt]);
   await db.query(`UPDATE intelligence_sources SET last_checked_at=$2,last_success_at=CASE WHEN $3 THEN $2 ELSE last_success_at END,last_failure_at=CASE WHEN NOT $3 THEN $2 ELSE last_failure_at END,
    consecutive_failures=$4,last_error_category=$5,last_http_status=$6,record_count=COALESCE($7,record_count),data_at=CASE WHEN $3 THEN COALESCE($8,data_at) ELSE data_at END,next_check_at=$9,camera_media=COALESCE($10::jsonb,camera_media),updated_at=now() WHERE id=$1`,[id,at,raw.ok,failures,error,http,count,dataAt,new Date(new Date(at).getTime()+(row.scope==='camera'&&raw.ok?600:retryDelay(failures,row.scope==='camera'?120:60))*1000),media]);
   await db.query('DELETE FROM intelligence_source_samples WHERE source_id=$1 AND id NOT IN (SELECT id FROM intelligence_source_samples WHERE source_id=$1 ORDER BY checked_at DESC,id DESC LIMIT 100)',[id]);
   return {coalesced:false,consecutive_failures:failures};
  });
 }
 async list(raw={}){
  const limit=integer(raw.limit,100,1,200),scope=raw.scope||'provider';M.check(['provider','camera','service','all'].includes(scope),'Invalid scope');
  if(raw.status)M.check(['HEALTHY','DEGRADED','STALE','OFFLINE','UNKNOWN'].includes(raw.status),'Invalid status');
  const cursor=raw.cursor?sourceId(raw.cursor):'',category=raw.category?M.text(raw.category,'category',40):null;
  const ids=raw.ids||null;if(ids)M.check(Array.isArray(ids)&&ids.length>0&&ids.length<=30&&ids.every(id=>sourceId(id)),'Invalid source selection');
  const rows=(await this.store.pool.query(`SELECT s.*,COALESCE(a.samples,'[]') samples FROM intelligence_sources s LEFT JOIN LATERAL (
    SELECT jsonb_agg(t ORDER BY checked_at DESC) samples FROM (SELECT ok,latency_ms,checked_at,error_category,http_status,record_count,data_at FROM intelligence_source_samples WHERE source_id=s.id ORDER BY checked_at DESC,id DESC LIMIT 100) t) a ON true
    WHERE ($1='all' OR scope=$1) AND ($2::text IS NULL OR category=$2) AND id>$3 AND ($5::text[] IS NULL OR id=ANY($5)) ORDER BY id LIMIT $4`,[scope,category,cursor,limit+1,ids])).rows;
  const more=rows.length>limit,selected=rows.slice(0,limit),items=selected.map(r=>{
   const samples=r.samples,latencies=samples.map(s=>s.latency_ms).filter(v=>v!=null).sort((a,b)=>a-b);
   const {samples:_,...source}=r;return {...source,status:healthState(r,samples),freshness:freshness(r.data_at,r.category,Date.now(),r.policy),sample_count:samples.length,success_rate:samples.length?samples.filter(s=>s.ok).length/samples.length:null,median_latency_ms:latencies.length?latencies[Math.floor(latencies.length/2)]:null};
  }).filter(r=>!raw.status||r.status===raw.status);
  return {items,next_cursor:more?selected.at(-1).id:null,window:'last 100 real checks per source',checked_at:new Date().toISOString()};
 }
 async get(id){const row=(await this.store.pool.query('SELECT * FROM intelligence_sources WHERE id=$1',[sourceId(id)])).rows[0];if(!row)throw new M.InputError('Source not found',404);return row;}
 async detail(id){const row=await this.get(id),samples=(await this.samples(id,100)).items;return {...row,status:healthState(row,samples),freshness:freshness(row.data_at,row.category,Date.now(),row.policy)};}
 async samples(id,limit){await this.get(id);return {items:(await this.store.pool.query('SELECT * FROM intelligence_source_samples WHERE source_id=$1 ORDER BY checked_at DESC,id DESC LIMIT $2',[id,integer(limit,20,1,100)])).rows};}
}
module.exports={SourceHealth,sourceId};
