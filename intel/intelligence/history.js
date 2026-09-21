const {randomUUID,createHash}=require('node:crypto');
const M=require('../ontology/model');
const {historyQuery,freshness}=require('./policy');
const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
function observation(raw,now=Date.now()) {
 M.check(raw&&typeof raw==='object','Observation required');
 const event_type=M.text(raw.event_type||'POSITION','event type',64); M.check(/^[A-Z][A-Z_0-9]+$/.test(event_type),'Invalid event type');
 const observed_at=M.timestamp(raw.observed_at), fetched_at=M.timestamp(raw.fetched_at)||new Date(now).toISOString();
 M.check(!observed_at||new Date(observed_at).getTime()<=now+300000,'Observation is in the future');
 const ps=Array.isArray(raw.provenance)?raw.provenance:[raw.provenance]; M.check(ps.length>0&&ps.length<=16,'Provenance required');
 const provenance=ps.map(M.provenance), state=provenance.some(p=>p.kind==='inferred')?'inferred':provenance.some(p=>p.kind==='derived')?'derived':provenance.every(p=>p.kind==='observed')?'observed':'imported';
 M.check(state!=='observed'||observed_at,'Observed evidence requires source timestamp');
 M.check(!['POSITION','FIRE','EARTHQUAKE','SEVERE_WEATHER','WEATHER'].includes(event_type)||observed_at,'Source observation time required');
 const lat=raw.lat??null,lon=raw.lon??raw.lng??null;
 M.check(lat===null&&lon===null||typeof lat==='number'&&Number.isFinite(lat)&&lat>=-90&&lat<=90&&typeof lon==='number'&&Number.isFinite(lon)&&lon>=-180&&lon<=180,'Invalid coordinates');
 const valid_from=M.timestamp(raw.valid_from), valid_to=M.timestamp(raw.valid_to); M.check(!valid_from||!valid_to||new Date(valid_to)>=new Date(valid_from),'Invalid validity interval');
 const data=M.jsonObject(raw.data||raw.properties),source_id=M.text(raw.source_id||provenance[0].provider,'source ID',160);
 const confidence=provenance.length===1?provenance[0].confidence:null;
 return {event_type,observed_at,fetched_at,timeline_at:observed_at||fetched_at,time_basis:observed_at?'observed':'received',lat,lon,data,source_id,confidence,evidence_state:state,provenance,valid_from,valid_to};
}
async function writeObservation(db,objectId,raw,now=Date.now()) {
 const o=observation(raw,now);
 const dedupKey=raw.dedup_key==null?null:M.text(raw.dedup_key,'observation dedup key',200);
 const fingerprint=hash([objectId,o.event_type,o.observed_at,dedupKey,o.lat,o.lon,o.data,o.provenance.map(p=>[p.provider,p.source_id,p.source_record_id,p.kind])]);
 const days=['POSITION','AIRBORNE','ON_GROUND'].includes(o.event_type)?Number(process.env.HISTORY_TELEMETRY_DAYS||14):Number(process.env.HISTORY_RETENTION_DAYS||90);
 const until=new Date(now+Math.min(3650,Math.max(1,Number.isFinite(days)?days:90))*86400000).toISOString();
 const values=[randomUUID(),objectId,o.event_type,o.observed_at,o.fetched_at,o.timeline_at,o.time_basis,o.lat,o.lon,o.data,o.source_id,o.confidence,o.evidence_state,JSON.stringify(o.provenance),o.valid_from,o.valid_to,fingerprint,until,dedupKey];
 return (await db.query(`INSERT INTO intelligence_observations(id,object_id,event_type,observed_at,fetched_at,timeline_at,time_basis,lat,lon,data,source_id,confidence,evidence_state,provenance,valid_from,valid_to,fingerprint,retained_until,dedup_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
 ON CONFLICT(fingerprint) DO UPDATE SET fetched_at=GREATEST(intelligence_observations.fetched_at,excluded.fetched_at)
 RETURNING id,object_id,event_type,timeline_at`,values)).rows[0];
}
async function putLocation(db,objectId,kind,name,raw) {
 const lat=raw.lat,lon=raw.lon??raw.lng;
 M.check(typeof lat==='number'&&Number.isFinite(lat)&&Math.abs(lat)<=90&&typeof lon==='number'&&Number.isFinite(lon)&&Math.abs(lon)<=180,'Invalid coordinates');
 const ps=(Array.isArray(raw.provenance)?raw.provenance:[raw.provenance]).map(M.provenance);
 await db.query(`INSERT INTO intelligence_object_locations(object_id,kind,name,lat,lon,observed_at,fetched_at,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
 ON CONFLICT(object_id) DO UPDATE SET kind=excluded.kind,name=excluded.name,lat=excluded.lat,lon=excluded.lon,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at,provenance=excluded.provenance
 WHERE excluded.observed_at IS NULL OR intelligence_object_locations.observed_at IS NULL OR excluded.observed_at>=intelligence_object_locations.observed_at`,[objectId,kind,name,lat,lon,raw.observed_at||null,raw.fetched_at||new Date().toISOString(),JSON.stringify(ps)]);
}
class HistoryService {
 constructor(store){this.store=store;}
 async record(raw){
  const object=await this.store.get(M.uuid(raw?.object_id));
  return this.store.transaction(async db=>{
   const saved=await writeObservation(db,object.id,raw);
   if(raw.lat!=null) await putLocation(db,object.id,object.type,object.canonical_name,raw);
   return {...saved,observation_id:saved.id,storage:'history'};
  });
 }
 async query(id,raw={}) {
  const object=await this.store.get(id),q=historyQuery(raw),ascending=q.order==='asc';
  // Direction is selected from a validated enum; all user values remain parameters.
  const rows=(await this.store.pool.query(`SELECT id,object_id,event_type,observed_at,fetched_at,timeline_at,time_basis,lat,lon,data,source_id,confidence,evidence_state,provenance,valid_from,valid_to
   FROM intelligence_observations WHERE object_id=$1 AND timeline_at BETWEEN $2 AND $3
   AND (NOT $4 OR lat IS NOT NULL) AND ($5::timestamptz IS NULL OR (timeline_at,id) ${ascending?'>':'<'} ($5,$6::uuid))
   ORDER BY timeline_at ${ascending?'ASC':'DESC'},id ${ascending?'ASC':'DESC'} LIMIT $7`,[object.id,q.from,q.to,q.location_only,q.cursor?.at||null,q.cursor?.id||null,q.limit+1])).rows;
  const categories={EARTHQUAKE:'earthquake',FIRE:'fire',SEVERE_WEATHER:'weather',WEATHER:'weather',CYBER_INDICATOR:'cyber',NEWS_EVENT:'news'};
  const more=rows.length>q.limit,items=rows.slice(0,q.limit).map(o=>({...o,freshness:freshness(o.observed_at,categories[o.event_type]||(object.type==='vessel'?'maritime':object.type==='aircraft'?'aircraft':'ontology'))}));
  const last=items.at(-1);
  return {object_id:object.id,items,next_cursor:more?Buffer.from(JSON.stringify({at:last.timeline_at,id:last.id})).toString('base64url'):null,range:{from:q.from,to:q.to},order:q.order};
 }
 async evidence(id,property){
  const object=await this.store.get(id); if(property!==undefined) M.text(property,'property',200);
  const rows=(await this.store.pool.query(`SELECT provider,source_id,source_record_id,url,observed_at,fetched_at,kind,confidence,confidence_basis,extraction_method,metadata FROM ontology_provenance
   WHERE object_id=$1 AND ($2::text IS NULL OR metadata->'properties' ? $2) ORDER BY fetched_at DESC LIMIT 100`,[object.id,property||null])).rows;
  return {object_id:object.id,property:property||null,evidence:rows};
 }
 async prune(){return this.store.pool.query('DELETE FROM intelligence_observations WHERE id IN (SELECT id FROM intelligence_observations WHERE retained_until<now() ORDER BY retained_until LIMIT 5000)');}
}
module.exports={HistoryService,writeObservation,putLocation,observation,hash,stable};
