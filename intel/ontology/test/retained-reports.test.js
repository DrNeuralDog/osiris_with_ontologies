const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {OntologyStore}=require('../store');
const {FeedIngestor}=require('../../intelligence/feeds');
const {RetainedReports,reportQuery}=require('../../intelligence/reports');
const {TimelineService}=require('../../intelligence/timeline');
const {AirThreatService}=require('../../intelligence/air-service');
const {investigate}=require('../../intelligence/investigate');
const schema=`reports_test_${randomUUID().replaceAll('-','')}`;
let admin,store,ingest,reports;
const now=Date.now()-60000,iso=n=>new Date(n).toISOString();
function news(id,lat=50,at=now){return {id,title:'Residents report hearing explosions',description:'Residents report hearing explosions in Example.',published:iso(at),source_name:'Fixture news',link:`https://example.org/news/${id}`,coords:[lat,30],location_precision:'settlement',place:{name:'Example',label:'Example district',precision:'settlement'}};}
before(async()=>{admin=new Pool();await admin.query(`CREATE SCHEMA ${schema}`);store=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));await store.migrate();ingest=new FeedIngestor(store);reports=new RetainedReports(store);});
after(async()=>{await store.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
test('news bridge persists a warning on the same canonical news object, repeated polling deduplicates',async()=>{
 const body={news:[news('one')]};await ingest.events('news',body);await ingest.events('news',body);
 const objects=(await store.pool.query('SELECT id FROM ontology_objects')).rows;assert.equal(objects.length,1);
 const observations=(await store.pool.query('SELECT event_type FROM intelligence_observations')).rows;assert.deepEqual(observations.map(r=>r.event_type).sort(),['HEARD_EXPLOSION','NEWS_EVENT','OBJECT_CREATED']);
 const result=await reports.list({bbox:'29,49,31,51'});assert.equal(result.records.length,1);assert.equal(result.records[0].subtype,'HEARD_EXPLOSION');assert.equal(result.records[0].object_id,objects[0].id);assert.equal(result.records[0].properties.original_provenance[0].confidence,null);
 assert.equal((await investigate(store,{type:'existing',id:objects[0].id})).object.id,objects[0].id);
 assert.equal((await store.pool.query('SELECT count(*)::int n FROM ontology_objects')).rows[0].n,1);
 const state=await new TimelineService(store).state({at:iso(now+1000),domains:'conflict'});assert.ok(state.items.some(r=>r.object_id===objects[0].id));
 const air=await new AirThreatService(store).state({bbox:'29,49,31,51',at:iso(now+1000)});assert.equal(air.reports[0].source_class,'PUBLIC_REPORT');
});
test('spatial/time bounds precede result cap, stable pagination handles identical timestamps',async()=>{
 await ingest.events('news',{news:[news('two'),news('three'),news('elsewhere',10),news('old',50,now-7200000)]});
 const ids=[];let cursor;
 do{const page=await reports.list({bbox:'29,49,31,51',limit:'1',...(cursor?{cursor}:{})});ids.push(...page.records.map(r=>r.id));cursor=page.next_cursor;}while(cursor);
 assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);
 assert.deepEqual(ids,[...ids].sort().reverse());
 const six=await reports.list({bbox:'29,49,31,51',hours:'6'});assert.equal(six.records.length,4);
});
test('future observation remains excluded, unknown place retained without invented point',async()=>{
 await ingest.events('news',{news:[news('future',50,Date.now()+120000),{...news('unlocated'),coords:[0,0],location_precision:'country-anchor',place:null}]});
 const result=await reports.list({bbox:'29,49,31,51'});
 assert.equal(result.records.some(r=>r.url.endsWith('/future')),false);
 const unknown=result.unlocated_records.find(r=>r.url.endsWith('/unlocated'));assert.equal(unknown.lat,null);assert.equal(unknown.location_precision,'UNKNOWN');
});
test('strict limits and cursors fail closed',async()=>{
 for(const q of [{hours:'1000'},{limit:'500000'},{bbox:'NaN,1,2,3'},{bbox:'30,50,20,40'},{cursor:'broken'},{sql:'SELECT 1'}])assert.throws(()=>reportQuery(q));
 const first=await reports.list({bbox:'29,49,31,51',limit:'1'});await assert.rejects(reports.list({bbox:'1,1,2,2',cursor:first.next_cursor}),/cursor/);
 const empty=await reports.list({bbox:'-50,-50,-49,-49'});assert.equal(empty.records.length,0);assert.equal(empty.unlocated_scope,'GLOBAL_WINDOW_NOT_AOI_MATCHED');assert.ok(empty.unlocated_records.length);
});
