const {test} = require('node:test');
const assert = require('node:assert/strict');
const {freshness, healthState, retryDelay, historyQuery} = require('../../intelligence/policy');
const {evaluate, distanceKm} = require('../../intelligence/rules');
const now = Date.parse('2026-09-21T10:00:00Z');
const ago = minutes => new Date(now - minutes*60000).toISOString();
const evidence = provider => [{provider,kind:'imported',confidence:null,source_record_id:'record',fetched_at:ago(1)}];
const signal = (event_type, extra={}) => ({id:'obs-1',object_id:'event-1',event_type,observed_at:ago(10),lat:0,lon:0,data:{},provenance:evidence('USGS'),...extra});
const asset = (kind='airport', extra={}) => ({object_id:'asset-1',kind,lat:0,lon:0.05,name:'Asset',provenance:evidence('OSIRIS catalog'),...extra});
test('freshness is source-specific and absent time is unknown',()=>{
  assert.equal(freshness(ago(1),'aircraft',now),'LIVE');
  assert.equal(freshness(ago(10),'aircraft',now),'STALE');
  assert.equal(freshness(ago(10),'static',now),'LIVE');
  assert.equal(freshness(ago(1500),'aircraft',now),'HISTORICAL');
  assert.equal(freshness(null,'aircraft',now),'UNKNOWN');
});
test('health transitions, recovery and capped exponential backoff',()=>{
  const source={enabled:true,category:'aircraft',last_success_at:ago(1),last_checked_at:ago(1),consecutive_failures:0};
  assert.equal(healthState(source,[{ok:true}],now),'HEALTHY');
  assert.equal(healthState({...source,consecutive_failures:1},[{ok:false}],now),'DEGRADED');
  assert.equal(healthState({...source,consecutive_failures:5},[{ok:false}],now),'OFFLINE');
  assert.equal(healthState({...source,last_success_at:ago(30),last_checked_at:ago(30)},[{ok:true}],now),'STALE');
  assert.equal(healthState({...source,last_success_at:null,last_checked_at:null},[],now),'UNKNOWN');
  assert.equal(healthState(source,[{ok:true},{ok:false},{ok:true},{ok:true},{ok:true}],now),'HEALTHY');
  assert.ok(retryDelay(5,60)>retryDelay(1,60)); assert.ok(retryDelay(100,60)<=3600);
});
test('history rejects excessive ranges, bad cursors, invalid dates and limits',()=>{
  for(const q of [{limit:10000},{from:'1900-01-01T00:00:00Z'},{from:'invalid'},{cursor:'junk'},{order:'drop table'},{location_only:'maybe'}]) assert.throws(()=>historyQuery(q,now));
  assert.equal(historyQuery({limit:12,order:'asc'},now).limit,12);
});
test('earthquake positive, distance/time/magnitude rejection and dateline distance',()=>{
  const quake=signal('EARTHQUAKE',{data:{magnitude:5.5}});
  assert.equal(evaluate({signals:[quake],assets:[asset()],weather:[]},now)[0].type,'EARTHQUAKE_INFRA_RISK');
  for(const invalid of [{observed_at:ago(1500)},{lat:30},{data:{magnitude:2}},{observed_at:null}]) assert.equal(evaluate({signals:[{...quake,...invalid}],assets:[asset()],weather:[]},now).length,0);
  assert.ok(distanceKm({lat:0,lon:179.9},{lat:0,lon:-179.9})<23);
});
test('tsunami information is only flagged when source supplies flag, never predicted',()=>{
  const q=signal('EARTHQUAKE',{data:{magnitude:6,tsunami:1}});
  assert.ok(evaluate({signals:[q],assets:[asset('port')],weather:[]},now).some(c=>c.type==='EARTHQUAKE_TSUNAMI_PORT_REVIEW'));
  assert.ok(!evaluate({signals:[{...q,data:{magnitude:8}}],assets:[asset('port')],weather:[]},now).some(c=>c.type.includes('TSUNAMI')));
});
test('fire wind rule uses wind FROM direction, requires weather and preserves evidence',()=>{
  const fire=signal('FIRE',{data:{frp_mw:70},provenance:evidence('NASA FIRMS')});
  const wind=signal('WEATHER',{id:'wind',object_id:'weather',data:{wind_from_deg:270,wind_speed_ms:10,visibility_m:2000},provenance:evidence('Open-Meteo')});
  const result=evaluate({signals:[fire],assets:[asset('infrastructure')],weather:[wind]},now);
  assert.equal(result[0].type,'FIRE_WEATHER_INFRA_RISK'); assert.equal(result[0].confidence,null); assert.equal(result[0].state,'derived'); assert.ok(result[0].evidence.length>=3);
  assert.equal(evaluate({signals:[fire],assets:[asset()],weather:[]},now).length,0);
  assert.equal(evaluate({signals:[fire],assets:[asset()],weather:[{...wind,data:{...wind.data,wind_from_deg:90}}]},now).length,0);
  assert.equal(evaluate({signals:[fire],assets:[asset()],weather:[{...wind,observed_at:ago(90)}]},now).length,0);
  const aviation=evaluate({signals:[fire],assets:[asset()],weather:[wind]},now);
  assert.ok(aviation.some(c=>c.type==='FIRE_FLIGHT_OPERATIONS_RISK'));
  assert.ok(!evaluate({signals:[fire],assets:[asset()],weather:[{...wind,data:{wind_from_deg:270,wind_speed_ms:10}}]},now).some(c=>c.type==='FIRE_FLIGHT_OPERATIONS_RISK'));
});
test('severe weather needs current severe signal and airport or fresh aircraft',()=>{
  const s=signal('SEVERE_WEATHER',{data:{severity:'high'}});
  assert.ok(evaluate({signals:[s],assets:[asset()],weather:[]},now).length);
  assert.equal(evaluate({signals:[s],assets:[asset('port')],weather:[]},now).length,0);
  assert.equal(evaluate({signals:[{...s,valid_to:ago(1)}],assets:[asset()],weather:[]},now).length,0);
});
test('cyber correlation requires verified exact ontology link and active indicator',()=>{
  const s=signal('CYBER_INDICATOR',{data:{status:'online'},lat:null,lon:null});
  const link={source_object_id:s.object_id,target_object_id:'asn-object',link_type:'ANNOUNCED_BY',provenance:evidence('abuse.ch'),properties:{identity_match:'exact'}};
  assert.equal(evaluate({signals:[s],assets:[],weather:[],cyberLinks:[link]},now)[0].type,'CYBER_INFRA_RELATED_SIGNAL');
  assert.equal(evaluate({signals:[s],assets:[],weather:[],cyberLinks:[{...link,provenance:[{kind:'inferred'}]}]},now).length,0);
  assert.equal(evaluate({signals:[s],assets:[],weather:[],cyberLinks:[]},now).length,0);
});
test('fingerprints, evidence and categorical strength are deterministic',()=>{
  const input={signals:[signal('EARTHQUAKE',{data:{magnitude:6}})],assets:[asset()],weather:[]};
  const [a]=evaluate(input,now),[b]=evaluate(input,now+1000);
  assert.equal(a.fingerprint,b.fingerprint); assert.ok(['HIGH','MODERATE','LOW'].includes(a.strength)); assert.ok(a.explanation.includes('km')); assert.equal(a.confidence,null);
});
test('mobile and weather support expire at their own freshness deadline',()=>{
 const fire=signal('FIRE',{data:{frp_mw:70},provenance:evidence('NASA FIRMS')}),wind=signal('WEATHER',{object_id:'wind',observed_at:ago(55),data:{wind_from_deg:270,wind_speed_ms:10,visibility_m:1000},provenance:evidence('Open-Meteo')});
 const [result]=evaluate({signals:[fire],assets:[asset('aircraft',{observed_at:ago(4)})],weather:[wind]},now);
 assert.equal(Date.parse(result.expires_at),now+60000);
 assert.throws(()=>evaluate({signals:Array(251).fill(fire)},now));
});
test('confidence reflects evidence support without fabricated numerical probabilities',()=>{
 const quake=signal('EARTHQUAKE',{data:{magnitude:6}});
 assert.equal(evaluate({signals:[quake],assets:[asset()]},now)[0].strength,'HIGH');
 assert.equal(evaluate({signals:[quake],assets:[asset('airport',{provenance:evidence('USGS')})]},now)[0].strength,'MODERATE');
 assert.equal(evaluate({signals:[quake],assets:[asset('airport',{provenance:[{provider:'catalog',kind:'inferred'}]})]},now)[0].strength,'MODERATE');
});
