const {SourceHealth}=require('./health');
const {FeedIngestor,normalizeFeed,proof,iso}=require('./feeds');
const {HistoryService,writeObservation}=require('./history');
const {CorrelationEngine}=require('./correlations');
const {retryDelay}=require('./policy');
const FEEDS=[
 ['world-conflicts','news',120,'/api/world/conflicts'],
 ['catalog','static',21600,'/api/intelligence/catalog'],['earthquakes','earthquake',120,'/api/earthquakes'],
 ['fires','fire',600,'/api/fires'],['weather','weather',300,'/api/weather'],['flights','aircraft',120,'/api/flights'],
 ['maritime','maritime',120,'/api/maritime'],['cyber-attacks','cyber',600,'/api/cyber-attacks'],
 ['satellites','satellite',600,'/api/satellites'],['news','news',300,'/api/news'],['cctv','cctv',1800,'/api/cctv?region=all'],
];
async function limitedJson(response,max=24*1024*1024){
 const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder();
 try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>max){await reader.cancel();throw new Error('PAYLOAD_LIMIT');}text+=decoder.decode(r.value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}
}
class IntelligenceWorker{
 constructor(store){this.store=store;this.health=new SourceHealth(store);this.ingest=new FeedIngestor(store);this.engine=new CorrelationEngine(store);this.history=new HistoryService(store);this.due=new Map();this.failures=new Map();this.running=false;this.frontendReady=false;this.lastPrune=0;this.lastWind=0;this.cursor=0;this.lastResult=null;}
 async start(){
  await this.store.pool.query("INSERT INTO intelligence_worker_state(id,enabled) VALUES('main',true) ON CONFLICT(id) DO UPDATE SET enabled=true,heartbeat_at=now(),last_error=NULL");
  for(const [id,category,,endpoint] of FEEDS)await this.health.register({id:`feed:${id}`,name:`OSIRIS ${id} ${id==='catalog'?'reference catalog':'feed'}`,category,endpoint,scope:'service',policy:id==='cctv'?{live:1800,fresh:7200,historical:86400}:{}});
  await this.health.register({id:'weather:open-meteo',name:'Open-Meteo wind / visibility model',category:'weather',endpoint:'https://api.open-meteo.com/v1/forecast'});
  for(const [id,category,enabled]of [['overpass','static',true],['open-meteo','weather',true],['rainviewer','weather',true],['gdelt-conflict','news',true],['war-tracker','news',process.env.WORLD_WAR_TRACKER_ENABLED==='1'],['alerts-in-ua','news',process.env.WORLD_ALERTS_ENABLED==='1'],['acled','news',process.env.WORLD_ACLED_ENABLED==='1'],['ucdp','news',process.env.WORLD_UCDP_ENABLED==='1'],['ukrainealarm','news',false],['goes','weather',false],['detector-aero','news',false]]){
   await this.health.register({id:`world:${id}`,name:`${id} · World Data`,category,endpoint:id,enabled});
   // These flags describe configured adapter capability, not a fabricated health check.
   await this.store.pool.query('UPDATE intelligence_sources SET enabled=$2 WHERE id=$1',[`world:${id}`,enabled]);
  }
  for(const [id] of FEEDS){const previous=await this.health.get(`feed:${id}`);this.failures.set(id,previous.consecutive_failures);if(previous.consecutive_failures&&previous.next_check_at)this.due.set(id,new Date(previous.next_check_at).getTime());}
  this.timer=setInterval(()=>void this.tick(),15000);this.timer.unref();void this.tick();
 }
 stop(){clearInterval(this.timer);return this.store.pool.query("UPDATE intelligence_worker_state SET enabled=false,heartbeat_at=now() WHERE id='main'").catch(()=>{});}
 async poll(feed){
  const [id,,interval,path]=feed,start=Date.now();
  try{
   const base=process.env.OSIRIS_INTERNAL_URL||'http://osiris:3000';
   // Configured internal service only, never a user-provided URL or path.
   const response=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(id==='flights'?60000:30000)});
   if(!response.ok)throw Object.assign(new Error(`HTTP_${response.status}`),{status:response.status});
   const body=await limitedJson(response);if(body.error)throw new Error('UPSTREAM_UNAVAILABLE');
   const records=body.total??body.total_ships??body.airports?.length??body.indicators?.length??body.events?.length??body.records?.length??0;
   if(id==='flights'&&(!body.total||String(body.source).includes('stale')))throw new Error('EMPTY_OR_STALE');
   if(id==='fires'&&body.source==='Unknown')throw new Error('UPSTREAM_UNAVAILABLE');
   let imported=0;
   if(id==='world-conflicts'){if(body.official_providers)await require('./air-registry').updateCapabilities(this.store,body.official_providers);if(body.status==='UNAVAILABLE')throw new Error('UPSTREAM_UNAVAILABLE');imported=await require('./world').ingestWorld(this.store,body);}
   if(id==='catalog')imported=await this.ingest.assets(body);
   else if(['flights','maritime'].includes(id)){imported=await this.ingest.telemetry(id,body);if(id==='maritime')await this.ingest.assets({ports:body.ports});}
   else if(['earthquakes','fires','weather','cyber-attacks','news'].includes(id))imported=await this.ingest.events(id,body);
   const observed=id==='flights'?['commercial_flights','private_flights','private_jets','military_flights'].flatMap(k=>body[k]||[]):id==='maritime'?body.ships||[]:[];
   const dataAt=[...observed.map(r=>iso(r.observed_at)),...normalizeFeed(id,body).map(r=>r.observed_at)].filter(Boolean).sort().at(-1)||null;
   await this.health.record(`feed:${id}`,{ok:true,latency_ms:Date.now()-start,record_count:records,http_status:response.status,data_at:dataAt});
   if(id==='news'||id==='world-conflicts'){
    const normalized=id==='news'?normalizeFeed('news',body).filter(r=>r.data.civilian_warning):body.records||[];
    const diagnostics={fetched:records,classified:normalized.length,geolocated:normalized.filter(r=>r.lat!=null).length,observation_upserts:imported,checked_at:new Date().toISOString(),providers:id==='world-conflicts'?body.providers:undefined,clock:id==='world-conflicts'?body.clock:undefined,scope:id==='news'?'Explicit civil warning and auditory wording only':'Existing world adapters'};
    await this.store.pool.query("UPDATE intelligence_sources SET coverage_metadata=coverage_metadata || jsonb_build_object('ingestion',$2::jsonb) WHERE id=$1",[`feed:${id}`,JSON.stringify(diagnostics)]);
   }
   this.failures.set(id,0);this.lastResult={source:id,imported,at:new Date().toISOString()};this.due.set(id,Date.now()+interval*1000);
   if(imported>0)await this.store.pool.query("UPDATE intelligence_worker_state SET last_ingestion_at=now() WHERE id='main'");
  }catch(error){
   console.warn('[intelligence] feed',id,error.name,error.code||error.message);
   const failures=(this.failures.get(id)||0)+1;this.failures.set(id,failures);this.due.set(id,Date.now()+retryDelay(failures,Math.min(interval,120))*1000);
   await this.health.record(`feed:${id}`,{ok:false,latency_ms:Math.min(300000,Date.now()-start),error_category:error.name==='TimeoutError'?'TIMEOUT':/^HTTP_|EMPTY|PAYLOAD|UPSTREAM/.test(error.message)?error.message:'NETWORK_OR_PARSE',http_status:error.status||null});
  }
 }
 async wind(){
  if(Date.now()-this.lastWind<600000)return;this.lastWind=Date.now();
  const source=await this.health.get('weather:open-meteo');
  if(!source.enabled||source.consecutive_failures&&new Date(source.next_check_at).getTime()>Date.now())return;
  const targets=(await this.store.pool.query(`SELECT DISTINCT ON(s.object_id) s.object_id,s.lat,s.lon FROM intelligence_observations s JOIN intelligence_object_locations l
   ON l.geo <@ box(point(s.lon-0.4,s.lat-0.4),point(s.lon+0.4,s.lat+0.4)) WHERE s.event_type='FIRE' AND s.observed_at>now()-interval '6 hours' AND l.kind IN ('airport','infrastructure','port') ORDER BY s.object_id,s.observed_at DESC LIMIT 8`)).rows;
  if(!targets.length)return;const start=Date.now();
  try{
   const params=new URLSearchParams({latitude:targets.map(t=>t.lat).join(','),longitude:targets.map(t=>t.lon).join(','),current:'wind_speed_10m,wind_direction_10m,visibility',wind_speed_unit:'ms',timezone:'UTC'});
   const response=await fetch(`https://api.open-meteo.com/v1/forecast?${params}`,{redirect:'error',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Object.assign(new Error('HTTP'),{status:response.status});
   const body=await limitedJson(response,1024*1024),items=Array.isArray(body)?body:[body];let count=0;
   for(const [index,r]of items.entries()){
    const target=targets[index],at=iso(r.current?.time?`${r.current.time}Z`:null);if(!target||!at||r.current_units?.wind_speed_10m!=='m/s')continue;
    const provenance=[proof('Open-Meteo',`${target.lat},${target.lon}`,at,'https://open-meteo.com/en/docs','derived',{method:'Weather model current conditions; not an in-situ wind measurement',units:r.current_units})];
    await this.store.transaction(async db=>{
     const id=await this.store.putObject(db,{type:'location',canonical_name:`Weather ${target.lat}, ${target.lon}`,external_ids:[{namespace:'source:open-meteo',value:`${target.lat},${target.lon}`}],properties:{lat:target.lat,lon:target.lon},provenance});
     await writeObservation(db,id,{event_type:'WEATHER',observed_at:at,lat:target.lat,lon:target.lon,data:{wind_speed_ms:r.current.wind_speed_10m,wind_from_deg:r.current.wind_direction_10m,visibility_m:r.current.visibility},source_id:'weather:open-meteo',provenance});
    });count++;
   }
   await this.health.record('weather:open-meteo',{ok:count>0,record_count:count,latency_ms:Date.now()-start,error_category:count?'':'MALFORMED_DATA'});
  }catch(error){await this.health.record('weather:open-meteo',{ok:false,latency_ms:Date.now()-start,error_category:'NETWORK_OR_UPSTREAM',http_status:error.status||null});}
 }
 async tick(){
  if(this.running)return;this.running=true;
  try{
   await this.store.pool.query("UPDATE intelligence_worker_state SET heartbeat_at=now() WHERE id='main'");
   // Compose starts intel before Next. Waiting for process readiness is not an upstream failure.
   if(!this.frontendReady){try{const response=await fetch((process.env.OSIRIS_INTERNAL_URL||'http://osiris:3000')+'/api/health',{redirect:'error',signal:AbortSignal.timeout(2000)});await response.body?.cancel();if(!response.ok)return;this.frontendReady=true;}catch{return;}}
   // Rotate source order so a long-running flight request cannot starve later feeds.
   const enabled=new Set((await this.store.pool.query('SELECT id FROM intelligence_sources WHERE enabled AND id=ANY($1::text[])',[FEEDS.map(f=>`feed:${f[0]}`)])).rows.map(s=>s.id));
   const due=FEEDS.map((_,i)=>FEEDS[(i+this.cursor)%FEEDS.length]).filter(f=>enabled.has(`feed:${f[0]}`)&&Date.now()>=(this.due.get(f[0])||0)).slice(0,2);this.cursor=(this.cursor+2)%FEEDS.length;
   const results=await Promise.allSettled(due.map(f=>this.poll(f)));
   for(const r of results)if(r.status==='rejected')console.warn('[intelligence] health persistence:',r.reason?.message);
   await this.wind();await this.engine.run();
   await this.store.pool.query("UPDATE intelligence_worker_state SET last_cycle_at=now(),heartbeat_at=now(),last_error=$1 WHERE id='main'",[results.some(r=>r.status==='rejected')?'INGESTION_FAILED':null]);
   if(Date.now()-this.lastPrune>3600000){await this.history.prune();this.lastPrune=Date.now();}
  }catch(error){console.warn('[intelligence] worker:',error.message);await this.store.pool.query("UPDATE intelligence_worker_state SET last_error='CYCLE_FAILED',heartbeat_at=now() WHERE id='main'").catch(()=>{});}finally{this.running=false;}
 }
}
module.exports={IntelligenceWorker,FEEDS,limitedJson};
