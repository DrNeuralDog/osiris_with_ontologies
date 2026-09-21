const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {OntologyStore}=require('../store');
const {writeObservation}=require('../../intelligence/history');
const {TimelineService,query}=require('../../intelligence/timeline');
const {correlationAt,relativeFreshness}=require('../../intelligence/timeline-policy');
const {CorrelationEngine}=require('../../intelligence/correlations');
const {createApp}=require('../../server');
const schema=`replay_${randomUUID().replaceAll('-','')}`,t=Date.now()-3600000,iso=n=>new Date(t+n*60000).toISOString();
let admin,store,api,server,base,plane;
async function object(type,name){return store.transaction(db=>store.putObject(db,{type,canonical_name:name,external_ids:[{namespace:'source:replay-test',value:name}],properties:{},provenance:[{provider:'Fixture',kind:'imported'}]}));}
async function obs(id,type,min,lat=10,lon=20,extra={}){return store.transaction(db=>writeObservation(db,id,{event_type:type,observed_at:iso(min),lat,lon,data:{},provenance:[{provider:'Fixture',kind:'observed',observed_at:iso(min),confidence:null}],...extra}));}
before(async()=>{admin=new Pool();await admin.query(`CREATE SCHEMA ${schema}`);store=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));await store.migrate();api=new TimelineService(store);server=createApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;plane=await object('aircraft','replay aircraft');await obs(plane,'POSITION',0);await obs(plane,'POSITION',4,11,21);await obs(plane,'POSITION',8,50,80);});
after(async()=>{if(server)await new Promise(r=>server.close(r));await store?.pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
const state=(at,rest={})=>api.state({at:iso(at),...rest});
test('latest observation <= T, stepped positions, stale/future exclusion',async()=>{
 assert.equal((await state(3,{domains:'aircraft'})).items[0].lat,10);
 assert.equal((await state(6,{domains:'aircraft'})).items[0].lat,11);
 assert.equal((await state(14,{domains:'aircraft'})).items.length,0);
 assert.equal((await state(-1,{domains:'aircraft'})).items.length,0);
});
test('viewport filtering does not resurrect an earlier position after leaving the viewport',async()=>{
 assert.equal((await state(6,{bbox:'19,9,22,12',domains:'aircraft'})).items.length,1);
 assert.equal((await state(9,{bbox:'19,9,22,12',domains:'aircraft'})).items.length,0);
});
test('vessel and satellite have independent freshness thresholds',async()=>{
 const v=await object('vessel','vessel'),s=await object('satellite','satellite');await obs(v,'POSITION',0);await obs(s,'POSITION',0);
 assert.equal((await state(10,{domains:'vessel'})).items.length,1);assert.equal((await state(10,{domains:'satellite'})).items.length,0);
});
test('event windows, interval bounds, domain filters and original provenance',async()=>{
 const e=await object('event','weather');await obs(e,'SEVERE_WEATHER',0,10,20,{valid_from:iso(2),valid_to:iso(10)});
 assert.equal((await state(1,{domains:'weather'})).items.length,0);assert.equal((await state(3,{domains:'weather'})).items.length,1);assert.equal((await state(10,{domains:'weather'})).items.length,0);
 const f=await object('event','fire'),q=await object('event','quake'),n=await object('event','news');await obs(f,'FIRE',-400);await obs(q,'EARTHQUAKE',-400);await obs(n,'NEWS_EVENT',0);
 assert.equal((await state(1,{domains:'fire'})).items.length,0);assert.equal((await state(1,{domains:'earthquake'})).items.length,1);
 const r=(await state(1,{domains:'news'})).items[0];assert.equal(r.observation.provenance[0].provider,'Fixture');assert.equal(r.observation.confidence,null);
});
test('historical freshness uses selected time and never today',()=>{assert.equal(relativeFreshness({domain:'aircraft',observation:{observed_at:iso(0)}},iso(1)),'LIVE');assert.equal(relativeFreshness({domain:'aircraft',observation:{observed_at:iso(0)}},iso(4)),'FRESH');});
test('coverage is bounded, cached and supports empty ranges',async()=>{
 const raw={from:iso(-10),to:iso(30)},r=await api.coverage(raw);assert.ok(r.earliest);assert.ok(r.buckets.length<=96);assert.equal(await api.coverage(raw),r);
 assert.equal((await api.coverage({from:iso(-5000),to:iso(-4900)})).buckets.length,0);
});
test('event keyset pages are chronological and deterministic for timestamp ties',async()=>{
 for(let i=0;i<3;i++)await obs(await object('event',`tie ${i}`),'NEWS_EVENT',0);
 let cursor,ids=[],times=[];do{const p=await api.events({from:iso(-1),to:iso(1),domains:'news',limit:'2',...(cursor?{cursor}:{})});ids.push(...p.items.map(i=>i.id));times.push(...p.items.map(i=>Date.parse(i.timeline_at)));cursor=p.next_cursor;}while(cursor);
 assert.ok(times.every(Number.isFinite));assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);assert.deepEqual(times,[...times].sort((a,b)=>a-b));
 await assert.rejects(api.events({cursor:'bad'}),/cursor/i);
});
test('6-hour chunk contains bounded explicit intervals without interpolated paths',async()=>{
 const r=await api.chunk({from:iso(-300),to:iso(60),domains:'aircraft',limit:'1'});assert.ok(r.truncated);assert.equal(r.items.length,1);assert.ok(r.items[0].from);assert.ok(r.items[0].to);assert.equal(r.items[0].path,undefined);
});
test('lifecycle reconstruction respects ACTIVE, EXPIRED, DISMISSED and equal-time sequence',()=>{
 const es=[{id:1,status:'ACTIVE',changed_at:iso(0)},{id:2,status:'EXPIRED',changed_at:iso(20)},{id:3,status:'ACTIVE',changed_at:iso(20)},{id:4,status:'DISMISSED',changed_at:iso(30)}];
 assert.equal(correlationAt(es,iso(-1)),'UNKNOWN');assert.equal(correlationAt(es,iso(10)),'ACTIVE');assert.equal(correlationAt(es,iso(20)),'ACTIVE');assert.equal(correlationAt(es,iso(31)),'DISMISSED');
});
test('persisted correlation snapshots retain historical evidence and do not version identical polls',async()=>{
 const engine=new CorrelationEngine(store),id=await object('event','correlation fixture');
 const c={fingerprint:'timeline-test',type:'EARTHQUAKE_INFRA_RISK',rule_id:'fixture',rule_version:1,strength:'MODERATE',related_object_ids:[id],expires_at:iso(20),window_start:iso(0),window_end:iso(1),geographic_context:{center:{lat:10,lon:20},points:[]},explanation:'Original evidence',rationale:{facts:[]},evidence:[]};
 await engine.persist([c],t);await engine.persist([c],t+1000);
 assert.equal(Number((await store.pool.query('SELECT count(*) FROM intelligence_correlation_versions')).rows[0].count),1);
 c.explanation='Later evidence';await engine.persist([c],t+10*60000);await engine.persist([],t+21*60000);
 const first=(await state(5,{domains:'correlations'})).items[0],last=(await state(22,{domains:'correlations'})).items[0];
 assert.equal(first.correlation.status,'ACTIVE');assert.equal(first.correlation.explanation,'Original evidence');assert.equal(last.correlation.status,'EXPIRED');assert.equal(last.correlation.explanation,'Later evidence');
});
test('malformed timestamps, excessive ranges, bounds, limits and domains are rejected by HTTP',async()=>{
 for(const qs of ['at=bad','at=2026-02-31T12:00:00Z','at=2026-09-21T24:00:00Z','at=2026-09-21T12:00:00','bbox=1,2,3,100','domains=alien','limit=100000','from=2020-01-01T00:00:00Z','depth=10000'])assert.equal((await fetch(`${base}/intelligence/timeline/state?${qs}`)).status,400,qs);
 assert.throws(()=>query({from:iso(-500),to:iso(0)},'chunk'),/6 hours/);
});

test('an explicit long-lived weather interval is not lost to the default visibility window',async()=>{
 const e=await object('event','long-lived alert');await obs(e,'SEVERE_WEATHER',-60*24*60,10,20,{valid_from:iso(-60*24*60),valid_to:iso(50)});
 assert.ok((await state(40,{domains:'weather'})).items.some(i=>i.object_id===e));
 assert.ok(!(await state(51,{domains:'weather'})).items.some(i=>i.object_id===e));
});


test('dateline viewport and retained history boundaries are respected',async()=>{
 const a=await object('satellite','dateline sat');await obs(a,'POSITION',0,10,179);await obs(a,'POSITION',4,10,-179);
 assert.equal((await state(5,{domains:'satellite',bbox:'170,0,-170,20'})).items.filter(i=>i.object_id===a).length,1);
 assert.equal((await state(5,{domains:'satellite',bbox:'-20,0,20,20'})).items.filter(i=>i.object_id===a).length,0);
 await store.pool.query("UPDATE intelligence_observations SET retained_until=now()-interval '1 second' WHERE object_id=$1",[a]);
 assert.equal((await state(5,{domains:'satellite'})).items.filter(i=>i.object_id===a).length,0);
});
