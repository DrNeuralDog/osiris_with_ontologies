// Изолированная UI fixture: никогда не пишет в production schema.
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {OntologyStore}=require('../store');
const {HistoryService,putLocation}=require('../../intelligence/history');
const {SourceHealth}=require('../../intelligence/health');
const {CorrelationEngine}=require('../../intelligence/correlations');
const {createApp}=require('../../server');
if(process.env.INTELLIGENCE_UI_FIXTURE!=='1')throw new Error('Explicit INTELLIGENCE_UI_FIXTURE=1 required');
const schema=`intelligence_ui_${randomUUID().replaceAll('-','')}`;
let admin,store,server;
async function cleanup(){if(server)await new Promise(r=>server.close(r));await store?.pool.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}}
async function main(){
 admin=new Pool();await admin.query(`CREATE SCHEMA ${schema}`);store=new OntologyStore(new Pool({options:`-c search_path=${schema},public`}));await store.migrate();
 const now=Date.now(),at=m=>new Date(now-m*60000).toISOString(),proof=provider=>[{provider,kind:'imported',confidence:null,source_record_id:'explicit-ui-fixture',metadata:{fixture:true,warning:'Synthetic test scenario in isolated schema; not a real event'}}];
 const obj=(key,type)=>({type,canonical_name:`UI FIXTURE ${key}`,external_ids:[{namespace:'test:ui',value:key}],provenance:proof('UI fixture catalog')});
 const [aircraft,airport,quake]=await store.ingest([obj('Aircraft','aircraft'),obj('Airport','airport'),obj('Earthquake','event')]);
 const history=new HistoryService(store);
 for(let i=0;i<3;i++)await history.record({object_id:aircraft,event_type:'POSITION',observed_at:at(4-i),lat:48+i*.02,lon:2+i*.02,data:{fixture:true,altitude_m:2000+i*100},provenance:proof('UI fixture telemetry')});
 await history.record({object_id:quake,event_type:'EARTHQUAKE',observed_at:at(3),lat:48,lon:2,data:{magnitude:6,fixture:true},provenance:proof('UI fixture earthquake')});
 await store.transaction(db=>putLocation(db,airport,'airport','UI FIXTURE Airport',{lat:48.05,lon:2.1,provenance:proof('UI fixture catalog')}));
 await new CorrelationEngine(store).run();
 const health=new SourceHealth(store);await health.register({id:'fixture:source',name:'UI FIXTURE source',category:'api',endpoint:'synthetic isolated UI test'});await health.record('fixture:source',{ok:true,latency_ms:42});
 server=createApp(store).listen(4000,'0.0.0.0',()=>console.log(JSON.stringify({fixture:true,schema,aircraft,airport,quake})));
 for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>void cleanup().then(()=>process.exit(0)));
}
main().catch(async e=>{console.error(e);await cleanup();process.exit(1);});
