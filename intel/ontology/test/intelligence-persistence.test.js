const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {OntologyStore}=require('../store');
const {HistoryService,putLocation}=require('../../intelligence/history');
const {SourceHealth}=require('../../intelligence/health');
const {CorrelationEngine}=require('../../intelligence/correlations');
const {evaluate}=require('../../intelligence/rules');
const {FeedIngestor,normalizeFeed}=require('../../intelligence/feeds');
const {createApp}=require('../../server');
const schema=`intelligence_test_${randomUUID().replaceAll('-','')}`;
let admin,store,history,health,engine,server,base;
const now=Date.now(),ago=m=>new Date(now-m*60000).toISOString();
const provenance=[{provider:'fixture-source',source_record_id:'row-1',kind:'observed',observed_at:ago(5),confidence:null,extraction_method:'fixture parser',metadata:{fixture:true}}];
const object=(key,type='aircraft')=>({type,canonical_name:key,external_ids:[{namespace:'test',value:key}],properties:{},provenance});
before(async()=>{admin=new Pool();await admin.query(`CREATE SCHEMA ${schema}`);store=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));await store.migrate();history=new HistoryService(store);health=new SourceHealth(store);engine=new CorrelationEngine(store);server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{if(server)await new Promise(r=>server.close(r));await store?.pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
test('time series persist independently of graph identity, preserve state/source and deduplicate',async()=>{
 const [id]=await store.ingest([object('history-plane')]);const input={object_id:id,event_type:'POSITION',observed_at:ago(5),lat:1,lon:2,data:{altitude_m:1000},source_id:'feed:fixture',provenance};
 const first=await history.record(input),again=await history.record(input);assert.equal(first.id,again.id);
 const another=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));
 try{await another.migrate();const result=await new HistoryService(another).query(id,{location_only:'true'});assert.equal(result.items.length,1);assert.equal(result.items[0].confidence,null);assert.equal(result.items[0].evidence_state,'observed');assert.equal(result.items[0].provenance[0].source_record_id,'row-1');assert.equal(result.items[0].provenance[0].extraction_method,'fixture parser');}finally{await another.pool.end();}
 assert.equal((await store.graph(id)).nodes.length,1);
});
test('history time filters and keyset pagination include equal timestamps without duplicates',async()=>{
 const [id]=await store.ingest([object('pages')]);
 for(let i=0;i<6;i++)await history.record({object_id:id,event_type:'POSITION',observed_at:ago(i<3?10:20),lat:i,lon:2,provenance});
 const first=await history.query(id,{location_only:'true',limit:2,order:'asc'}),second=await history.query(id,{location_only:'true',limit:2,order:'asc',cursor:first.next_cursor});
 assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,4);
 const filtered=await history.query(id,{from:ago(15),to:ago(5),location_only:'true'});assert.equal(filtered.items.length,3);
});
test('property and relationship changes are recorded with evidence; identical polls add no audit duplicates',async()=>{
 const [a,b]=await store.ingest([object('audit-A','company'),object('audit-B','person')]);
 await store.ingest([{...object('audit-A','company'),properties:{example:1}}]);
 const link={source:0,target:1,link_type:'CEO',provenance:[{...provenance[0],kind:'imported'}]};
 await store.ingest([object('audit-A','company'),object('audit-B','person')],[link]);
 await store.ingest([object('audit-A','company'),object('audit-B','person')],[link]);
 const result=await history.query(a);assert.equal(result.items.filter(r=>r.event_type==='RELATIONSHIP_CREATED').length,1);assert.ok(result.items.some(r=>r.event_type==='PROPERTIES_CHANGED'));
 assert.ok((await history.query(b)).items.some(r=>r.data.link_type==='CEO'));
 assert.equal((await history.evidence(a,'example')).evidence[0].metadata.properties.example,1);
});
test('history follows merged object UUIDs',async()=>{
 const [a,b]=await store.ingest([object('merge-a'),object('merge-b')]);await history.record({object_id:b,event_type:'POSITION',observed_at:ago(1),lat:2,lon:3,provenance});
 await store.ingest([{...object('merged'),external_ids:[{namespace:'test',value:'merge-a'},{namespace:'test',value:'merge-b'}]}]);
 assert.equal((await history.query(a,{location_only:'true'})).items.length,1);
});
test('source health aggregation, bounded samples, failures and recovery',async()=>{
 await assert.rejects(health.register({id:'fixture:bad-policy',name:'Bad',category:'aircraft',policy:{live:600}}),/freshness order/);
 await health.register({id:'fixture:health',name:'Fixture',category:'api',endpoint:'fixture'});
 for(let i=0;i<105;i++)await health.record('fixture:health',{ok:true,latency_ms:100+i,checked_at:new Date(now-(110-i)*1100).toISOString(),data_at:ago(1)},now);
 assert.equal((await health.samples('fixture:health',100)).items.length,100);
 for(let i=0;i<5;i++)await health.record('fixture:health',{ok:false,error_category:'HTTP_403',http_status:403,checked_at:new Date(now+i*1100).toISOString()},now+i*1100);
 let state=(await health.list()).items.find(s=>s.id==='fixture:health');assert.equal(state.status,'OFFLINE');assert.equal(state.last_error_category,'HTTP_403');assert.ok(state.success_rate<1);assert.ok(state.median_latency_ms>=100);
 await health.record('fixture:health',{ok:true,latency_ms:90,checked_at:new Date(now+6600).toISOString()},now+6600);state=(await health.list()).items.find(s=>s.id==='fixture:health');assert.equal(state.status,'HEALTHY');assert.equal(state.consecutive_failures,0);
});
test('correlations persist, deduplicate, retain evidence, expire and remain dismissed',async()=>{
 const [event,asset]=await store.ingest([object('quake','event'),object('airport','airport')]);
 const seed={id:randomUUID(),object_id:event,event_type:'EARTHQUAKE',observed_at:ago(5),lat:1,lon:2,data:{magnitude:6},provenance};
 const target={object_id:asset,kind:'airport',lat:1,lon:2.05,provenance:[{provider:'catalog',kind:'imported'}]};
 const candidates=evaluate({signals:[seed],assets:[target]},now);
 await engine.persist(candidates,now);await engine.persist(candidates,now+1000);
 let list=await engine.list();assert.equal(list.items.length,1);assert.equal(list.items[0].evaluation_count,2);
 const id=list.items[0].id,detail=await engine.get(id);assert.equal(detail.evidence.length,2);assert.equal(detail.evidence_state,'derived');assert.equal(detail.confidence,null);assert.equal(detail.lifecycle.length,1);
 await engine.persist([],now+2*86400000);assert.equal((await engine.list({status:'EXPIRED'})).items.length,1);
 await engine.persist(candidates,now+2000);await engine.dismiss(id);await engine.persist(candidates,now+3000);
 assert.equal((await engine.get(id)).status,'DISMISSED');assert.ok((await engine.get(id)).lifecycle.length>=3);
});
test('engine reads persisted observations and locations through bounded database queries',async()=>{
 const [event,asset]=await store.ingest([object('db-quake','event'),object('db-port','port')]);
 await history.record({object_id:event,event_type:'EARTHQUAKE',observed_at:ago(3),lat:15,lon:30,data:{magnitude:6,tsunami:1},provenance});
 await store.transaction(db=>putLocation(db,asset,'port','Fixture port',{lat:15,lon:30.05,provenance}));
 const result=await engine.run();assert.ok(result.matched>=2);assert.equal((await engine.run()).skipped,true);
});
test('malformed API input, unknown objects, excessive limits and ranges are rejected',async()=>{
 const [id]=await store.ingest([object('api-check')]);
 for(const path of [`/ontology/objects/${id}/history?limit=10000`,`/ontology/objects/${id}/history?from=1900-01-01T00:00:00Z`,`/ontology/objects/${id}/history?cursor=no`,`/intelligence/sources?limit=9999`,`/intelligence/correlations?limit=9999`,`/intelligence/correlations?status=BOGUS`])assert.equal((await fetch(base+path)).status,400,path);
 assert.equal((await fetch(`${base}/ontology/objects/${randomUUID()}/history`)).status,404);
 assert.equal((await fetch(`${base}/intelligence/correlations/${randomUUID()}`)).status,404);
 assert.equal((await fetch(base+'/intelligence/source-reports',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"reports":[]}'})).status,403);
});
test('feed adapters do not treat volcano placeholders or unlocated news as fire/correlation evidence',()=>{
 assert.equal(normalizeFeed('fires',{fires:[{type:'volcano',lat:1,lng:2,frp:100,confidence:'high'}]}).length,0);
 assert.equal(normalizeFeed('news',{news:[{title:'Unlocated',published:ago(1),link:'https://example.com'}]}).length,0);
});
test('telemetry only records existing stable identities with source time; raw source remains unknown confidence',async()=>{
 const [id]=await store.ingest([{...object('tracked'),external_ids:[{namespace:'icao24',value:'abc123'}]}]);
 const ingestor=new FeedIngestor(store),body={commercial_flights:[{icao24:'abc123',lat:1,lng:2,observed_at:ago(1),provider:'OpenSky',alt:1000},{icao24:'ffff11',lat:1,lng:2,observed_at:ago(1)}]};
 assert.equal(await ingestor.telemetry('flights',body),1);assert.equal(await ingestor.telemetry('flights',body),0);
 const result=await history.query(id,{location_only:'true'});assert.equal(result.items[0].evidence_state,'observed');assert.equal(result.items[0].confidence,null);
 assert.equal((await store.find({namespace:'icao24',value:'ffff11'})).length,0);
});
test('property transitions A to B to A to B remain distinct history entries',async()=>{
 const input=object('repeated-transition','company');const [id]=await store.ingest([{...input,properties:{value:'A'}}]);
 for(const value of ['B','A','B'])await store.ingest([{...input,properties:{value}}]);
 assert.equal((await history.query(id)).items.filter(o=>o.event_type==='PROPERTIES_CHANGED').length,3);
});
test('expired raw observations are pruned while correlation evidence survives',async()=>{
 const [id]=await store.ingest([object('prune')]); const result=await history.record({object_id:id,event_type:'POSITION',observed_at:ago(1),lat:1,lon:1,provenance});
 await store.pool.query("UPDATE intelligence_observations SET retained_until=now()-interval '1 day' WHERE id=$1",[result.id]);await history.prune();assert.equal((await history.query(id,{location_only:'true'})).items.length,0);
 assert.ok((await engine.list({status:'all'})).items.length>0);
});
test('no-match evaluation expires only the explicitly evaluated seeds',async()=>{
 const [event,asset]=await store.ingest([object('expire-seed','event'),object('expire-asset','airport')]);
 const candidates=evaluate({signals:[{object_id:event,event_type:'EARTHQUAKE',observed_at:ago(2),lat:0,lon:0,data:{magnitude:6},provenance}],assets:[{object_id:asset,kind:'airport',lat:0,lon:0.1,provenance}]},now);
 await engine.persist(candidates,now);await engine.persist([],now+1,[]);assert.equal((await engine.list({object_id:event})).items.length,1);
 await engine.persist([],now+2,[event]);assert.equal((await engine.list({object_id:event})).items.length,0);assert.equal((await engine.list({status:'EXPIRED',object_id:event})).items.length,1);
});
test('canonical merge retains history deduplication and correlation fingerprints',async()=>{
 const [event,a,b]=await store.ingest([object('merge-signal','event'),object('asset-a','airport'),object('asset-b','airport')]);
 const raw={event_type:'POSITION',observed_at:ago(1),lat:1,lon:1,provenance};await history.record({object_id:b,...raw});
 const signal={object_id:event,event_type:'EARTHQUAKE',observed_at:ago(1),lat:1,lon:1,data:{magnitude:6},provenance};
 await engine.persist(evaluate({signals:[signal],assets:[{object_id:b,kind:'airport',lat:1,lon:1.1,provenance}]},now),now);
 const [merged]=await store.ingest([{...object('merged-asset','airport'),external_ids:[{namespace:'test',value:'asset-a'},{namespace:'test',value:'asset-b'}]}]);
 await history.record({object_id:merged,...raw});assert.equal((await history.query(merged,{location_only:'true'})).items.length,1);
 await engine.persist(evaluate({signals:[signal],assets:[{object_id:merged,kind:'airport',lat:1,lon:1.1,provenance}]},now),now);
 assert.equal((await engine.list({object_id:event})).items.length,1);assert.ok([a,b].includes(merged));
});
test('camera snapshot health persists independently and cannot certify video playback',async()=>{
 const id='camera:media-fixture';await health.register({id,name:'Fixture camera',category:'cctv',scope:'camera',endpoint:'fixture camera ID'});
 await health.record(id,{ok:true,camera_media:{snapshot_status:'SNAPSHOT_AVAILABLE',stream_status:'UNKNOWN'}});
 const detail=await health.detail(id);assert.equal(detail.camera_media.snapshot_status,'SNAPSHOT_AVAILABLE');assert.equal(detail.camera_media.stream_status,'UNKNOWN');
 await store.migrate();assert.equal((await health.detail(id)).camera_media.snapshot_status,'SNAPSHOT_AVAILABLE');
 await assert.rejects(()=>health.record(id,{ok:true,camera_media:{snapshot_status:'SNAPSHOT_AVAILABLE',stream_status:'STREAM_AVAILABLE'}}),/cannot certify video/);
 await assert.rejects(()=>health.record(id,{ok:true,camera_media:{snapshot_status:'SNAPSHOT_AVAILABLE',stream_status:'UNKNOWN',secret:'not allowed'}}),/Invalid camera media/);
});
