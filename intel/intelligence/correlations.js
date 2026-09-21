const {randomUUID}=require('node:crypto');
const M=require('../ontology/model');
const {integer}=require('./policy');
const {evaluate}=require('./rules');
const {CorrelationPages}=require('./correlation-pages');
class CorrelationEngine{
 constructor(store){this.store=store;this.running=false;this.lastRun=0;this.pages=new CorrelationPages();}
 async persist(candidates,now=Date.now(),evaluated=[]){
  M.check(candidates.length<=500,'Too many correlations');
  return this.store.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(782341004)');
   const expired=(await db.query("UPDATE intelligence_correlations SET status='EXPIRED',resolved_at=$1 WHERE status='ACTIVE' AND expires_at<=$1 RETURNING id",[new Date(now)])).rows;
   for(const row of expired)await db.query("INSERT INTO intelligence_correlation_events(correlation_id,status,changed_at,reason) VALUES($1,'EXPIRED',$2,'Supporting observations aged out; not evidence of safety')",[row.id,new Date(now)]);
   if(evaluated.length){
    const ended=(await db.query("UPDATE intelligence_correlations SET status='EXPIRED',resolved_at=$1 WHERE status='ACTIVE' AND related_object_ids[1]=ANY($2::uuid[]) AND NOT (fingerprint=ANY($3::text[])) RETURNING id",[new Date(now),evaluated,candidates.map(c=>c.fingerprint)])).rows;
    for(const row of ended)await db.query("INSERT INTO intelligence_correlation_events(correlation_id,status,changed_at,reason) VALUES($1,'EXPIRED',$2,'Current evidence no longer meets the rule; not evidence of safety')",[row.id,new Date(now)]);
    expired.push(...ended);
   }
   for(const c of candidates){
    const old=(await db.query('SELECT id,status FROM intelligence_correlations WHERE fingerprint=$1',[c.fingerprint])).rows[0];
    if(old?.status==='DISMISSED')continue;
    const id=old?.id||randomUUID(),at=new Date(now);
    await db.query(`INSERT INTO intelligence_correlations(id,fingerprint,correlation_type,rule_id,rule_version,status,strength,confidence,related_object_ids,detected_at,created_at,last_confirmed_at,resolved_at,expires_at,window_start,window_end,geographic_context,explanation,rationale,evidence_state)
     VALUES($1,$2,$3,$4,$5,'ACTIVE',$6,NULL,$7,$8,$8,$8,NULL,$9,$10,$11,$12,$13,$14,'derived')
     ON CONFLICT(fingerprint) DO UPDATE SET strength=excluded.strength,status='ACTIVE',last_confirmed_at=excluded.last_confirmed_at,resolved_at=NULL,expires_at=excluded.expires_at,window_end=excluded.window_end,geographic_context=excluded.geographic_context,explanation=excluded.explanation,rationale=excluded.rationale,related_object_ids=excluded.related_object_ids,evaluation_count=intelligence_correlations.evaluation_count+1`,
    [id,c.fingerprint,c.type,c.rule_id,c.rule_version,c.strength,c.related_object_ids,at,c.expires_at,c.window_start,c.window_end,c.geographic_context,c.explanation,c.rationale]);
    await db.query('DELETE FROM intelligence_correlation_evidence WHERE correlation_id=$1',[id]);
    for(const [ordinal,e]of c.evidence.entries())await db.query('INSERT INTO intelligence_correlation_evidence VALUES($1,$2,$3,$4)',[id,ordinal,e.observation_id,e]);
    if(!old||old.status!=='ACTIVE')await db.query("INSERT INTO intelligence_correlation_events(correlation_id,status,changed_at,reason) VALUES($1,'ACTIVE',$2,'Rule conditions supported by timestamped evidence')",[id,at]);
   }
   return {matched:candidates.length,expired:expired.length};
  });
 }
 async run(now=Date.now()){
  if(this.running||now-this.lastRun<60000)return {skipped:true,reason:'one evaluation per minute'};
  this.running=true;
  try{
   const signals=(await this.store.pool.query(`SELECT * FROM (SELECT DISTINCT ON(object_id,event_type) * FROM intelligence_observations
    WHERE event_type=ANY($1::text[]) AND observed_at>$2 ORDER BY object_id,event_type,observed_at DESC,id DESC) recent ORDER BY observed_at DESC LIMIT 250`,[['EARTHQUAKE','FIRE','SEVERE_WEATHER','CYBER_INDICATOR'],new Date(now-86400000)])).rows;
   // One indexed spatial join for all seeds. Native point GiST avoids a PostGIS dependency.
   const assets=(await this.store.pool.query(`SELECT DISTINCT ON(l.object_id) l.* FROM intelligence_object_locations l JOIN intelligence_observations s
    ON s.id=ANY($1::uuid[]) AND s.geo IS NOT NULL AND (l.geo <@ box(point(s.lon-LEAST(180,5/GREATEST(0.01,cos(radians(s.lat)))),s.lat-5),point(s.lon+LEAST(180,5/GREATEST(0.01,cos(radians(s.lat)))),s.lat+5))
      OR abs(s.lon)>180-LEAST(180,5/GREATEST(0.01,cos(radians(s.lat)))) AND l.geo <@ box(point(-180,s.lat-5),point(180,s.lat+5)))
    WHERE l.kind=ANY($2::text[]) ORDER BY l.object_id LIMIT 5000`,[signals.map(s=>s.id),['infrastructure','airport','port','aircraft']])).rows;
   const weather=(await this.store.pool.query("SELECT * FROM (SELECT DISTINCT ON(object_id) * FROM intelligence_observations WHERE event_type='WEATHER' AND observed_at>$1 ORDER BY object_id,observed_at DESC,id DESC) latest ORDER BY observed_at DESC LIMIT 250",[new Date(now-3600000)])).rows;
   const cyberLinks=(await this.store.pool.query(`SELECT l.*,COALESCE((SELECT jsonb_agg(p) FROM ontology_provenance p WHERE p.link_id=l.id),'[]') provenance FROM ontology_links l
    WHERE source_object_id=ANY($1::uuid[]) AND link_type=ANY($2::text[]) LIMIT 1000`,[signals.filter(s=>s.event_type==='CYBER_INDICATOR').map(s=>s.object_id),['ANNOUNCED_BY','HOSTED_BY','AFFECTS']])).rows;
   const candidates=evaluate({signals,assets,weather,cyberLinks},now);
   // A capped result is not evidence that an omitted pair stopped matching.
   const incomplete=assets.length>=5000||weather.length>=250||cyberLinks.length>=1000||candidates.length>=500;
   const result=await this.persist(candidates,now,incomplete?[]:signals.map(s=>s.object_id));this.lastRun=now;
   return {...result,signals_considered:signals.length,assets_considered:assets.length,bounded:signals.length===250||incomplete};
  }finally{this.running=false;}
 }
 async list(raw={}){
  const limit=integer(raw.limit,40,1,100),status=raw.status||'ACTIVE';M.check(['ACTIVE','EXPIRED','DISMISSED','all'].includes(status),'Invalid correlation status');
  if(raw.type)M.check(/^[A-Z_]{3,64}$/.test(raw.type),'Invalid correlation type');
  if(raw.object_id)M.uuid(raw.object_id);
  const filters=JSON.stringify([status,raw.type||null,raw.object_id||null]);
  if(raw.cursor!==undefined){M.check(typeof raw.cursor==='string'&&raw.cursor.length>0,'Invalid correlation cursor');return this.pages.page(null,filters,limit,raw.cursor);}
  const rows=(await this.store.pool.query(`SELECT c.* FROM intelligence_correlations c WHERE ($1='all' OR status=$1) AND ($2::text IS NULL OR correlation_type=$2)
    AND ($3::uuid IS NULL OR $3=ANY(related_object_ids)) ORDER BY last_confirmed_at DESC,id DESC LIMIT 2001`,[status,raw.type||null,raw.object_id||null])).rows;
  return this.pages.page(rows.slice(0,2000),filters,limit,null,rows.length>2000);
 }
 async get(id){
  const row=(await this.store.pool.query('SELECT * FROM intelligence_correlations WHERE id=$1',[M.uuid(id)])).rows[0];if(!row)throw new M.InputError('Correlation not found',404);
  const [evidence,events,objects]=await Promise.all([this.store.pool.query('SELECT snapshot FROM intelligence_correlation_evidence WHERE correlation_id=$1 ORDER BY ordinal',[id]),this.store.pool.query('SELECT status,changed_at,reason FROM intelligence_correlation_events WHERE correlation_id=$1 ORDER BY changed_at DESC LIMIT 100',[id]),this.store.objects(row.related_object_ids)]);
  return {...row,evidence:evidence.rows.map(e=>e.snapshot),lifecycle:events.rows,objects};
 }
 async dismiss(id){await this.get(id);return this.store.transaction(async db=>{
  const r=await db.query("UPDATE intelligence_correlations SET status='DISMISSED',resolved_at=now() WHERE id=$1 AND status<>'DISMISSED' RETURNING id",[id]);
  if(r.rowCount)await db.query("INSERT INTO intelligence_correlation_events(correlation_id,status,changed_at,reason) VALUES($1,'DISMISSED',now(),'Dismissed by local user; evidence retained')",[id]);
  return {id,status:'DISMISSED'};
 });}
}
module.exports={CorrelationEngine};
