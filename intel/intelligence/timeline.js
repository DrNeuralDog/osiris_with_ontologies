const M=require('../ontology/model');
const {integer,POLICIES}=require('./policy');
const {hash}=require('./history');
const P=require('./timeline-policy');
const DAY=86400000,MAX_ROWS=10000;
const date=v=>{
 const match=typeof v==='string'&&v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
 M.check(match,'Timestamp requires ISO date and timezone');
 const [,year,month,day,hour,minute,second]=match;
 M.check(+month>=1&&+month<=12&&+day>=1&&+day<=new Date(Date.UTC(+year,+month,0)).getUTCDate()&&+hour<24&&+minute<60&&+second<60,'Invalid calendar timestamp');
 return M.timestamp(v);
};
function query(raw={},kind='state',now=Date.now()){
 const allowed=new Set(['at','from','to','bbox','domains','limit','cursor']);
 for(const [k,v]of Object.entries(raw))M.check(allowed.has(k)&&typeof v==='string'&&v.length<=600,'Invalid timeline query');
 const at=raw.at?date(raw.at):new Date(now).toISOString(),to=raw.to?date(raw.to):at,from=raw.from?date(raw.from):new Date(Date.parse(to)-21600000).toISOString();
 M.check(Date.parse(from)<=Date.parse(to)&&Date.parse(to)-Date.parse(from)<=31*DAY,'Timeline range must be <=31 days');
 M.check(Date.parse(to)<=now+60000&&Date.parse(at)<=now+60000,'Future replay is unavailable');
 if(kind==='chunk')M.check(Date.parse(to)-Date.parse(from)<=21600000,'Chunk must be <=6 hours');
 if(kind==='state')M.check(Date.parse(at)>=Date.parse(from)&&Date.parse(at)<=Date.parse(to),'Replay time outside range');
 const domains=raw.domains?raw.domains.split(','):P.DOMAINS;M.check(domains.length>0&&domains.length<=P.DOMAINS.length&&domains.every(d=>P.DOMAINS.includes(d)),'Invalid domains');
 let bbox=null;if(raw.bbox){bbox=raw.bbox.split(',').map(Number);M.check(bbox.length===4&&bbox.every(Number.isFinite)&&Math.abs(bbox[0])<=180&&Math.abs(bbox[2])<=180&&Math.abs(bbox[1])<=90&&Math.abs(bbox[3])<=90&&bbox[1]<=bbox[3],'Invalid viewport');}
 const limit=integer(raw.limit,kind==='events'?100:kind==='chunk'?5000:1000,1,kind==='events'?200:kind==='chunk'?10000:2000);
 let cursor=null;if(raw.cursor){try{cursor=JSON.parse(Buffer.from(raw.cursor,'base64url').toString());date(cursor.at);M.uuid(cursor.id);M.check(cursor.filter===hash([from,to,domains,bbox]),'Cursor filters changed');}catch{throw new M.InputError('Invalid timeline cursor');}}
 M.check(!raw.cursor||kind==='events','Cursor only applies to events');
 return {at,to,from,domains,bbox,limit,cursor};
}
const DOMAIN_SQL="CASE WHEN s.event_type='POSITION' THEN o.type WHEN s.event_type='FIRE' THEN 'fire' WHEN s.event_type='EARTHQUAKE' THEN 'earthquake' WHEN s.event_type IN ('SEVERE_WEATHER','WEATHER') THEN 'weather' WHEN s.event_type IN ('CONFLICT_REPORT','HEARD_EXPLOSION','OFFICIAL_ALERT') THEN 'conflict' WHEN s.event_type='NEWS_EVENT' THEN 'news' WHEN s.event_type='CYBER_INDICATOR' THEN 'cyber' WHEN s.event_type='REFERENCE_LOCATION' THEN 'infrastructure' END";
class TimelineService{
 constructor(store){this.store=store;this.cache=new Map();}
 async read(fn){const db=await this.store.pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='4000ms'");const value=await fn(db);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 async rows(db,q,from,to,cap=MAX_ROWS+1,cursor=null,ascending=false,spatial=false){
  const b=q.bbox;
  const result=(await db.query(`WITH candidates AS (SELECT s.*,o.type object_type,o.canonical_name FROM intelligence_observations s JOIN ontology_objects o ON o.id=s.object_id
   WHERE s.lat IS NOT NULL AND (s.timeline_at BETWEEN $1 AND $2 OR ($13 AND s.event_type IN ('SEVERE_WEATHER','WEATHER') AND s.timeline_at<=$2 AND s.valid_to>$1)) AND s.retained_until>now() AND (${DOMAIN_SQL})=ANY($3::text[])
   AND ($4::timestamptz IS NULL OR (s.timeline_at,s.id)>($4,$5::uuid))
   AND (NOT $7 OR (s.geo <@ box(point($8,$9),point($10,$11))) OR (s.event_type IN ('POSITION','REFERENCE_LOCATION') AND $12 AND EXISTS
    (SELECT 1 FROM intelligence_observations p WHERE p.object_id=s.object_id AND p.event_type=s.event_type AND p.timeline_at BETWEEN $1 AND $2 AND p.geo <@ box(point($8,$9),point($10,$11)))))
   ORDER BY s.timeline_at ${ascending?'ASC':'DESC'},s.id ${ascending?'ASC':'DESC'} LIMIT $6), sized AS (SELECT candidates.*,sum(octet_length(to_jsonb(candidates)::text)) OVER(ORDER BY timeline_at ${ascending?'ASC':'DESC'},id ${ascending?'ASC':'DESC'}) byte_budget FROM candidates) SELECT CASE WHEN byte_budget<=8388608 THEN to_jsonb(sized)-'byte_budget' ELSE NULL END payload FROM sized ORDER BY timeline_at ${ascending?'ASC':'DESC'},id ${ascending?'ASC':'DESC'}`,[from,to,q.domains,cursor?.at||null,cursor?.id||null,cap,spatial&&!!b&&b[0]<=b[2],b?.[0]||0,b?.[1]||0,b?.[2]||0,b?.[3]||0,!ascending,!ascending&&q.domains.includes('weather')])).rows;
  const rows=result.filter(r=>r.payload).map(r=>r.payload);rows.truncated=result.some(r=>!r.payload);return rows;
 }
 async correlations(db,q,from,to){
  if(!q.domains.includes('correlations'))return {items:[],truncated:false};
  const rows=(await db.query(`SELECT id,correlation_type,created_at FROM intelligence_correlations WHERE created_at<=$2 AND last_confirmed_at>=$1 ORDER BY created_at DESC,id DESC LIMIT 201`,[new Date(Date.parse(from)-31*DAY),to])).rows;
  const ids=rows.slice(0,200).map(r=>r.id);
  const versions=(await db.query(`WITH candidates AS (SELECT v.* FROM intelligence_correlation_versions v WHERE correlation_id=ANY($1::uuid[]) AND recorded_at<=$3 AND (recorded_at>=$2 OR id IN (SELECT old.id FROM unnest($1::uuid[]) cid CROSS JOIN LATERAL (SELECT id FROM intelligence_correlation_versions WHERE correlation_id=cid AND recorded_at<$2 ORDER BY recorded_at DESC,id DESC LIMIT 1) old)) ORDER BY recorded_at DESC,id DESC LIMIT 1001), sized AS (SELECT candidates.*,sum(octet_length(snapshot::text)) OVER(ORDER BY recorded_at DESC,id DESC) byte_budget FROM candidates) SELECT correlation_id,recorded_at,id,CASE WHEN byte_budget<=4194304 THEN snapshot ELSE NULL END snapshot FROM sized ORDER BY recorded_at,id`,[ids,from,to])).rows;
  const events=(await db.query(`SELECT id,correlation_id,status,changed_at FROM intelligence_correlation_events WHERE correlation_id=ANY($1::uuid[]) AND changed_at<=$2 ORDER BY changed_at DESC,id DESC LIMIT 2001`,[ids,to])).rows;
  const items=[];let truncated=rows.length>200||versions.length>1000||events.length>2000||versions.some(v=>!v.snapshot);
  for(const c of rows){c.versions=versions.filter(v=>v.correlation_id===c.id&&v.snapshot).map(v=>({...v,recorded_at:v.recorded_at.toISOString()}));c.lifecycle=events.filter(e=>e.correlation_id===c.id);}
  for(const c of rows.slice(0,200)){
   const times=[...new Set([c.created_at.toISOString(),...c.versions.map(v=>v.recorded_at),...c.lifecycle.map(e=>e.changed_at.toISOString()),...c.versions.map(v=>v.snapshot.expires_at)].filter(Boolean))].sort((a,b)=>Date.parse(a)-Date.parse(b));
   for(let i=0;i<times.length;i++){
    const t=times[i],end=times[i+1]||new Date(Date.parse(to)+1).toISOString();if(Date.parse(end)<=Date.parse(from)||Date.parse(t)>Date.parse(to))continue;
    const version=c.versions.filter(v=>Date.parse(v.recorded_at)<=Date.parse(t)).at(-1),snapshot=version?.snapshot;
    let status=P.correlationAt(c.lifecycle,t);if(status==='ACTIVE'&&snapshot?.expires_at&&Date.parse(snapshot.expires_at)<=Date.parse(t))status='EXPIRED';
    const p=snapshot?.geographic_context?.center;
    if(p&&!P.inBounds(p.lat,p.lon,q.bbox))continue;
    items.push({id:`${c.id}:${t}`,correlation_id:c.id,name:c.correlation_type,domain:'correlations',from:t,to:end,lat:p?.lat??null,lon:p?.lon??null,correlation:{...(snapshot||{id:c.id,correlation_type:c.correlation_type}),status,last_confirmed_at:version?.recorded_at||null,evidence_available:!!snapshot},status});
   }
  }return {items,truncated};
 }
 async chunk(raw,kind='chunk'){
  const q=query(raw,kind),from=kind==='state'?q.at:q.from,to=kind==='state'?q.at:q.to;
  return this.read(async db=>{
   const lookback=Math.max(...q.domains.map(d=>P.WINDOWS[d]||0));
   const rows=await this.rows(db,q,new Date(Date.parse(from)-lookback*1000),to,MAX_ROWS+1,null,false,true);
   const cs=await this.correlations(db,q,from,to);
   let items=P.intervals(rows.slice(0,MAX_ROWS)).filter(r=>Date.parse(r.to)>Date.parse(from)&&Date.parse(r.from)<=Date.parse(to)&&P.inBounds(r.lat,r.lon,q.bbox));
   items.push(...cs.items);items.sort((a,b)=>Date.parse(a.from)-Date.parse(b.from)||a.id.localeCompare(b.id));
   const cap=q.limit,truncated=rows.truncated||rows.length>MAX_ROWS||cs.truncated||items.length>cap;
   items=items.slice(0,cap);let bytes=0;items=items.filter(r=>{bytes+=Buffer.byteLength(JSON.stringify(r));return bytes<=8*1024*1024;});
   return {items:items.map(r=>({...r,freshness:P.relativeFreshness(r,q.at)})),from,to,truncated:truncated||bytes>8*1024*1024,limits:{rows:MAX_ROWS,bytes:8388608},semantics:'Retained observation time; late imports keep received timestamps. Positions are stepped, never interpolated.',policies:POLICIES};
  });
 }
 async state(raw){return this.chunk(raw,'state');}
 async events(raw){const q=query(raw,'events');return this.read(async db=>{
  const rows=await this.rows(db,q,q.from,q.to,q.limit+1,q.cursor,true,true);if(rows.truncated)throw new M.InputError('Event page exceeds byte budget; lower limit',413);const items=rows.slice(0,q.limit).filter(r=>P.inBounds(r.lat,r.lon,q.bbox)),last=rows.slice(0,q.limit).at(-1);
  return {items,next_cursor:rows.length>q.limit?Buffer.from(JSON.stringify({at:last.timeline_at,id:last.id,filter:hash([q.from,q.to,q.domains,q.bbox])})).toString('base64url'):null};
 });}
 async coverage(raw){const q=query(raw,'coverage'),key=JSON.stringify([q.from,q.to,q.domains,q.bbox]),old=this.cache.get(key);if(old&&old.until>Date.now())return old.value;
  const value=await this.read(async db=>{
   const rows=await this.rows(db,q,q.from,q.to,20001,null,true,true),earliest=(await db.query('SELECT timeline_at FROM intelligence_observations WHERE lat IS NOT NULL AND retained_until>now() ORDER BY timeline_at,id LIMIT 1')).rows[0],latest=(await db.query('SELECT timeline_at FROM intelligence_observations WHERE lat IS NOT NULL AND retained_until>now() ORDER BY timeline_at DESC,id DESC LIMIT 1')).rows[0];
   const step=Math.max(1000,(Date.parse(q.to)-Date.parse(q.from))/96),bins=new Map();
   for(const r of rows.slice(0,20000)){if(!P.inBounds(r.lat,r.lon,q.bbox))continue;const i=Math.min(95,Math.floor((new Date(r.timeline_at)-Date.parse(q.from))/step));let b=bins.get(i);if(!b){b={index:i,at:r.timeline_at,count:0,lat:r.lat,lon:r.lon,object_id:r.object_id,name:r.canonical_name,domains:{}};bins.set(i,b);}b.count++;const d=P.domain(r);b.domains[d]=(b.domains[d]||0)+1;}
   let correlationLimited=false;
   if(q.domains.includes('correlations')){
    const versions=(await db.query("SELECT v.recorded_at,v.correlation_id,v.snapshot->'geographic_context'->'center' center,v.snapshot->>'correlation_type' correlation_type FROM intelligence_correlation_versions v WHERE recorded_at BETWEEN $1 AND $2 ORDER BY recorded_at,id LIMIT 2001",[q.from,q.to])).rows;correlationLimited=versions.length>2000;
    for(const v of versions.slice(0,2000)){const p=v.center;if(!p||!P.inBounds(p.lat,p.lon,q.bbox))continue;const i=Math.min(95,Math.floor((new Date(v.recorded_at)-Date.parse(q.from))/step));let b=bins.get(i);if(!b){b={index:i,at:v.recorded_at,count:0,lat:p.lat,lon:p.lon,object_id:v.correlation_id,name:v.correlation_type,domains:{}};bins.set(i,b);}b.count++;b.domains.correlations=(b.domains.correlations||0)+1;}
   }
   return {earliest:earliest?.timeline_at||null,latest:latest?.timeline_at||null,buckets:[...bins.values()].sort((a,b)=>a.index-b.index),truncated:rows.truncated||rows.length>20000||correlationLimited,domains:P.DOMAINS,windows:P.WINDOWS,policies:POLICIES,range:{from:q.from,to:q.to},retention:{telemetry_days:Number(process.env.HISTORY_TELEMETRY_DAYS||14),events_days:Number(process.env.HISTORY_RETENTION_DAYS||90)}};
  });if(this.cache.size>=16)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{value,until:Date.now()+15000});return value;
 }
}
module.exports={TimelineService,query};
