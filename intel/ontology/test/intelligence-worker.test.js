const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {CorrelationEngine}=require('../../intelligence/correlations');
const {IntelligenceWorker}=require('../../intelligence/worker');

test('capped correlation output cannot expire pairs omitted by the result budget',async()=>{
 const now=Date.now(),provenance=[{provider:'fixture',kind:'observed'}];
 const signal={id:randomUUID(),object_id:randomUUID(),event_type:'EARTHQUAKE',observed_at:new Date(now-60000),lat:1,lon:2,data:{magnitude:6},provenance};
 const assets=Array.from({length:501},()=>({object_id:randomUUID(),kind:'airport',lat:1,lon:2.01,provenance}));
 const responses=[[signal],assets,[],[]];
 const engine=new CorrelationEngine({pool:{query:async()=>({rows:responses.shift()})}});
 engine.persist=async(candidates,at,evaluated)=>{assert.equal(candidates.length,500);assert.deepEqual(evaluated,[]);return {matched:candidates.length};};
 const result=await engine.run(now);assert.equal(result.bounded,true);
});

test('worker skips disabled feeds without recording false health failures',async()=>{
 const worker=new IntelligenceWorker({pool:{query:async()=>({rows:[]})}});
 worker.frontendReady=true;worker.lastPrune=Date.now();let polled=0;
 worker.poll=async()=>{polled++;};worker.wind=async()=>{};worker.engine.run=async()=>{};
 await worker.tick();assert.equal(polled,0);
});

test('weather enrichment respects disabled source and persistent retry deadline',async()=>{
 const worker=new IntelligenceWorker({pool:{query:async()=>{throw new Error('Should not probe');}}});
 worker.health.get=async()=>({enabled:false});await worker.wind();
 worker.lastWind=0;worker.health.get=async()=>({enabled:true,consecutive_failures:3,next_check_at:new Date(Date.now()+60000)});await worker.wind();
});
