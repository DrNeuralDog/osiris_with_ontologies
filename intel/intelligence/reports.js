const M=require('../ontology/model');
const {SourceHealth}=require('./health');
const TYPES=['CONFLICT_REPORT','HEARD_EXPLOSION','OFFICIAL_ALERT'];
const SOURCES=['feed:news','feed:world-conflicts','world:gdelt-conflict','world:war-tracker','world:alerts-in-ua','world:ukrainealarm','world:israel-hfc','world:detector-aero','world:acled','world:ucdp'];
function reportQuery(raw={},now=Date.now()){
 for(const [k,v]of Object.entries(raw))M.check(['bbox','hours','limit','cursor'].includes(k)&&typeof v==='string'&&v.length<=600,'Invalid report query');
 const hours=Number(raw.hours||1),limit=Number(raw.limit||300);
 M.check([1,6,24].includes(hours)&&Number.isInteger(limit)&&limit>=1&&limit<=500,'Invalid report limits');
 const bbox=raw.bbox?raw.bbox.split(',').map(Number):null;
 M.check(!bbox||bbox.length===4&&bbox.every(Number.isFinite)&&bbox[0]>=-180&&bbox[2]<=180&&bbox[1]>=-85&&bbox[3]<=85&&bbox[0]<bbox[2]&&bbox[1]<bbox[3],'Invalid bounds');
 let cursor=null,to=new Date(now).toISOString();
 if(raw.cursor){try{cursor=JSON.parse(Buffer.from(raw.cursor,'base64url').toString());}catch{throw new M.InputError('Invalid report cursor');}
  M.check(cursor&&Object.keys(cursor).sort().join(',')==='at,id,query,to','Invalid report cursor');M.uuid(cursor.id);M.timestamp(cursor.at);M.timestamp(cursor.to);
  M.check(cursor.query===JSON.stringify([bbox,hours])&&Date.parse(cursor.to)<=now+1000&&Date.parse(cursor.to)>now-86400000&&Date.parse(cursor.at)<=Date.parse(cursor.to),'Expired or mismatched cursor');to=cursor.to;
 }
 return {bbox,hours,limit,cursor,to,from:new Date(Date.parse(to)-hours*3600000).toISOString()};
}
function dto(row){
 const d=row.data||{},p=row.provenance?.[0]||{};
 return {id:row.id,object_id:row.object_id,domain:'conflict',provider:p.provider||row.source_id,name:row.canonical_name,subtype:d.subtype||row.event_type,lat:row.lat,lon:row.lon,observed_at:row.timeline_at,fetched_at:row.fetched_at,url:p.url||'',evidence_state:'REPORTED',confidence:row.confidence,geometry_precision:'representative',location_precision:d.location_precision||'UNKNOWN',extraction_method:p.extraction_method||'Retained source report',source_license:d.source_license||'Original source terms apply',source_attribution:d.source_attribution||p.provider,properties:{...d,source_class:d.source_class||'STRUCTURED_OSINT',observation_id:row.id,original_provenance:row.provenance}};
}
class RetainedReports{
 constructor(store){this.store=store;this.health=new SourceHealth(store);}
 async list(raw){
  const q=reportQuery(raw),b=q.bbox||[-180,-85,180,85];
  const result=await this.store.transaction(async db=>{
   await db.query("SET LOCAL statement_timeout='4000ms'");
   // Time and GiST bounds precede the result cap. No network request in this read path.
   const rows=(await db.query(`WITH latest AS (
    SELECT DISTINCT ON(s.object_id) s.id,s.object_id,s.event_type,s.timeline_at,s.fetched_at,s.lat,s.lon,s.data,s.source_id,s.confidence,s.provenance,o.canonical_name
    FROM intelligence_observations s JOIN ontology_objects o ON o.id=s.object_id
    WHERE s.event_type=ANY($1::text[]) AND s.timeline_at BETWEEN $2 AND $3
    AND s.geo <@ box(point($4,$5),point($6,$7))
    ORDER BY s.object_id,s.timeline_at DESC,s.id DESC)
    SELECT * FROM latest WHERE ($8::timestamptz IS NULL OR (timeline_at,id)<($8::timestamptz,$9::uuid))
    ORDER BY timeline_at DESC,id DESC LIMIT $10`,[TYPES,q.from,q.to,...b,q.cursor?.at||null,q.cursor?.id||null,q.limit+1])).rows;
   const records=[];let bytes=0;for(const row of rows.slice(0,q.limit)){const r=dto(row),size=Buffer.byteLength(JSON.stringify(r));if(bytes+size>2*1024*1024)break;records.push(r);bytes+=size;}
   const last=records.at(-1),more=rows.length>records.length;
   // Unknown locations belong to a separate global feed, never to an inferred viewport.
   const unlocated=(await db.query(`SELECT s.*,o.canonical_name FROM intelligence_observations s JOIN ontology_objects o ON o.id=s.object_id
    WHERE s.event_type=ANY($1::text[]) AND s.timeline_at BETWEEN $2 AND $3 AND s.geo IS NULL
    ORDER BY s.timeline_at DESC,s.id DESC LIMIT 21`,[TYPES,q.from,q.to])).rows;
   return {records,truncated:more,next_cursor:more&&last?Buffer.from(JSON.stringify({at:last.observed_at,id:last.id,to:q.to,query:JSON.stringify([q.bbox,q.hours])})).toString('base64url'):null,bytes,range:{from:q.from,to:q.to},basis:'RETAINED_SOURCE_REPORTS',unlocated:Math.min(unlocated.length,20),unlocated_records:unlocated.slice(0,20).map(dto),unlocated_truncated:unlocated.length>20,unlocated_scope:'GLOBAL_WINDOW_NOT_AOI_MATCHED'};
  });
  const health=await this.health.list({scope:'all',limit:'30',ids:SOURCES});
  return {...result,status:'AVAILABLE',providers:health.items.filter(p=>p.id.startsWith('world:')||p.id==='feed:news'||p.id==='feed:world-conflicts').map(p=>({id:p.id,provider:p.name,status:p.status,credential_state:p.credential_state,count:p.record_count,last_checked_at:p.last_checked_at,data_at:p.data_at,diagnostics:p.coverage_metadata?.ingestion||null})),message:result.records.length?'Reports are source claims; markers represent reported areas.':'No retained reports in the selected area/time. This is not an all-clear.'};
 }
}
module.exports={RetainedReports,reportQuery,dto};
