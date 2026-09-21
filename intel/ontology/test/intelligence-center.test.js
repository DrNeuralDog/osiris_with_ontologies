const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {OntologyStore}=require('../store');
const {IntelligenceSummary,workerState}=require('../../intelligence/summary');
const {investigate}=require('../../intelligence/investigate');
const {HistoryService}=require('../../intelligence/history');
const {FeedIngestor}=require('../../intelligence/feeds');
const {SourceHealth}=require('../../intelligence/health');
const {CorrelationEngine}=require('../../intelligence/correlations');
const {evaluate}=require('../../intelligence/rules');
const {createApp}=require('../../server');
const schema=`center_test_${randomUUID().replaceAll('-','')}`;
let admin,store,server,base;
const at=new Date(Date.now()-60000).toISOString();
const seed=(type,id,record={},provider='Fixture')=>({type,id,name:`Fixture ${id}`,record,provider});
before(async()=>{
 admin=new Pool();await admin.query(`CREATE SCHEMA ${schema}`);
 store=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));await store.migrate();
 server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));await store?.pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});

test('summary distinguishes an empty healthy DB, unknown worker and unavailable subsystem',async()=>{
 const summary=await new IntelligenceSummary(store).get();
 assert.equal(summary.objects,0);assert.equal(summary.relationships,0);assert.equal(summary.observations,0);assert.equal(summary.active_correlations,0);assert.equal(summary.latest_correlation,null);
 assert.equal(summary.database,'HEALTHY');assert.equal(summary.worker.status,'UNKNOWN');assert.equal(Object.values(summary.sources).reduce((a,b)=>a+b,0),0);
 const unavailable=await new IntelligenceSummary({pool:{query:async()=>{throw Error('offline');}}}).get();
 assert.equal(unavailable.database,'ERROR');assert.equal(unavailable.objects,null);assert.equal(unavailable.worker.status,'UNKNOWN');
});
test('worker status is based on persisted heartbeat and cycle outcome',async()=>{
 assert.equal(workerState({enabled:false}).status,'STOPPED');
 assert.equal(workerState({enabled:true,heartbeat_at:at,last_error:null}).status,'RUNNING');
 assert.equal(workerState({enabled:true,heartbeat_at:new Date(Date.now()-240000)}).status,'DEGRADED');
 assert.equal(workerState({enabled:true,heartbeat_at:at,last_error:'CYCLE_FAILED'}).status,'DEGRADED');
 await store.pool.query("INSERT INTO intelligence_worker_state(id,enabled,heartbeat_at,last_cycle_at) VALUES('main',true,now(),now())");
 assert.equal((await new IntelligenceSummary(store).get()).worker.status,'RUNNING');
});

const fire={lat:10,lng:20,date:at.slice(0,10),time:at.slice(11,16).replace(':',''),frp:40,type:'fire'};
test('USGS, FIRMS, NORAD and camera IDs deduplicate on demand and survive a fresh connection',async()=>{
 const requests=[seed('earthquake','us7000test',{lat:1,lng:2,time:at,magnitude:6},'USGS'),seed('fire','selected-fire',fire,'NASA-FIRMS (VIIRS)'),seed('satellite','25544'),seed('camera','JamCams_1')];
 for(const input of requests){
  const first=await investigate(store,input),again=await investigate(store,input);assert.equal(first.object.id,again.object.id);assert.equal(first.observations,again.observations);
  const another=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));
  try{const saved=await another.get(first.object.id);assert.equal(saved.external_ids[0].value,first.object.external_ids[0].value);assert.equal(saved.provenance[0].confidence,null);assert.equal(saved.provenance[0].kind,'imported');assert.equal(saved.provenance[0].metadata.client_supplied,true);}finally{await another.pool.end();}
 }
 assert.equal((await investigate(store,seed('satellite','025544'))).object.id,(await investigate(store,seed('satellite','25544'))).object.id);
});
test('on-demand event identities match the existing worker ingestion identities',async()=>{
 const ingestor=new FeedIngestor(store);
 await ingestor.events('earthquakes',{earthquakes:[{id:'usworker1',lat:10,lng:20,time:at,place:'Worker earthquake'}]});
 await ingestor.events('fires',{fires:[fire],source:'NASA-FIRMS (VIIRS)'});
 const before=(await new IntelligenceSummary(store).get()).objects;
 await investigate(store,seed('earthquake','usworker1',{lat:10,lng:20,time:at},'USGS'));
 await investigate(store,seed('fire','selected-fire',fire,'NASA-FIRMS (VIIRS)'));
 assert.equal((await new IntelligenceSummary(store).get()).objects,before);
});
test('every added map type registers evidence; a record without source time adds no invented location observation',async()=>{
 for(const input of [seed('weather','nws-fixture',{lat:10,lng:20,date:at,category:'weatherAlerts',severity:'high'}),seed('infrastructure','plant-1',{lat:10,lng:20}),seed('airport','EGLL',{icao:'EGLL'}),seed('port','port-1',{catalog_id:'port-1',lat:10,lng:20}),seed('news','https://example.org/report',{lat:10,lng:20,published:at})]){
  const result=await investigate(store,input);assert.ok(result.object.id);assert.equal(result.object.provenance[0].kind,'imported');
 }
 const camera=await investigate(store,seed('camera','no-history-camera'));
 const history=await new HistoryService(store).query(camera.object.id,{location_only:'true'});assert.deepEqual(history.items,[]);assert.equal(history.next_cursor,null);
 assert.ok((await new HistoryService(store).evidence(camera.object.id)).evidence.length>0);
});
test('news URL aliases reuse worker identity and orbital positions retain their derived basis',async()=>{
 const link='https://example.org/retained-news#section',record={link,published:at,place:{lat:10,lon:20},coords:[10,20],lat:10,lng:20};
 await new FeedIngestor(store).events('news',{news:[record]});
 const before=(await new IntelligenceSummary(store).get()).objects;
 await investigate(store,seed('news','https://example.org/retained-news',record));
 assert.equal((await new IntelligenceSummary(store).get()).objects,before);
 const satellite=await investigate(store,seed('satellite','49044',{lat:10,lng:20,observed_at:at}));
 assert.equal(satellite.object.provenance[0].metadata.position_state,'derived');
 assert.match(satellite.object.provenance[0].extraction_method,/SGP4/);
 const history=await new HistoryService(store).query(satellite.object.id,{location_only:'true'});
 assert.equal(history.items[0].provenance[0].kind,'derived');
 assert.equal(history.items[0].provenance[0].confidence,null);
});
test('summary counts and source statuses agree with persistent tables and detailed health',async()=>{
 const health=new SourceHealth(store);
 for(const id of ['good','bad','unknown'])await health.register({id:`fixture:${id}`,name:id,category:'api',endpoint:'fixture'});
 await health.record('fixture:good',{ok:true,latency_ms:42});
 for(let i=0;i<5;i++)await health.record('fixture:bad',{ok:false,error_category:'HTTP_403',checked_at:new Date(Date.now()+i*1000).toISOString()},Date.now()+i*1000);
 const a=(await investigate(store,seed('company','Q123',{wikidata:'Q123'}))).object,b=(await investigate(store,seed('person','Q124',{wikidata:'Q124'}))).object;
 await store.transaction(db=>store.putLink(db,{source_object_id:a.id,target_object_id:b.id,link_type:'CEO',provenance:[{provider:'Fixture',kind:'imported'}]}));
 const service=new IntelligenceSummary(store),summary=await service.get(),details=await health.list({scope:'all'});
 for(const state of Object.keys(summary.sources))assert.equal(summary.sources[state],details.items.filter(s=>s.status===state).length);
 for(const [key,table]of [['objects','ontology_objects'],['relationships','ontology_links'],['observations','intelligence_observations']])assert.equal(summary[key],Number((await store.pool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n));
 assert.equal(await service.get(),summary); // 15-second single snapshot cache
});
test('chronological correlation pages include equal timestamps, reject forged cursors, and remain stable during worker updates',async()=>{
 const engine=new CorrelationEngine(store),now=Date.now();
 const target=(await investigate(store,seed('airport','KJFK',{icao:'KJFK'}))).object;
 const candidates=[];
 for(let i=0;i<5;i++){
  const event=(await investigate(store,seed('earthquake',`uspage${i}`))).object;
  const candidate=evaluate({signals:[{id:randomUUID(),object_id:event.id,event_type:'EARTHQUAKE',observed_at:at,lat:10,lon:20,data:{magnitude:6},provenance:[{provider:'USGS',kind:'imported'}]}],assets:[{object_id:target.id,kind:'airport',lat:10,lon:20.01,provenance:[{provider:'catalog',kind:'imported'}]}]},now)[0];
  assert.ok(candidate);candidates.push(candidate);await engine.persist([candidate],now-(i<3?1000:3000));
 }
 const expected=(await store.pool.query('SELECT id FROM intelligence_correlations ORDER BY last_confirmed_at DESC,id DESC')).rows.map(r=>r.id);
 let page=await engine.list({limit:2}),ids=page.items.map(r=>r.id);assert.deepEqual(ids,expected.slice(0,2));
 const key=JSON.parse(Buffer.from(page.next_cursor,'base64url').toString());assert.ok(key.at);assert.ok(key.id);
 await engine.persist([candidates[4]],now+1000); // An unread row moves to the front in the live list.
 while(page.next_cursor){page=await engine.list({limit:2,cursor:page.next_cursor});ids.push(...page.items.map(r=>r.id));}
 assert.deepEqual(ids,expected);assert.equal(new Set(ids).size,5);
 assert.equal((await engine.list()).items[0].fingerprint,candidates[4].fingerprint);
 for(const cursor of ['', 'garbage', Buffer.from(JSON.stringify({...key,id:randomUUID()})).toString('base64url')])await assert.rejects(engine.list({cursor}),/cursor/i);
 await assert.rejects(engine.list({cursor:Buffer.from(JSON.stringify(key)).toString('base64url'),status:'all'}),/filters/);
 const summary=await new IntelligenceSummary(store).get();assert.equal(summary.active_correlations,5);assert.equal(summary.latest_correlation.id,(await engine.list()).items[0].id);
});
test('API validates missing objects, registration, query bounds and cursors',async()=>{
 for(const path of ['/intelligence/summary?depth=100000','/intelligence/correlations?limit=101','/intelligence/correlations?cursor=bad','/intelligence/objects/not-uuid/context'])assert.equal((await fetch(base+path)).status,400,path);
 assert.equal((await fetch(`${base}/intelligence/objects/${randomUUID()}/context`)).status,404);
 for(const input of [seed('alien','x'),seed('aircraft','callsign-only'),seed('satellite','evil'),seed('fire','f',fire,'Unverified')])assert.equal((await fetch(base+'/intelligence/investigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,400);
 assert.equal((await fetch(base+'/intelligence/investigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(seed('satellite','99999'))})).status,200);
});
