const {hash}=require('./history');
const M=require('../ontology/model');
const RAD=Math.PI/180;
const THRESHOLDS=Object.freeze({quakeMagnitude:5,quakeKm:150,quakeHours:24,tsunamiPortKm:500,fireKm:30,fireHours:6,windAgeMinutes:60,windMinMs:5,windSectorDegrees:45,weatherKm:100,weatherHours:6,visibilityMetres:5000,fireRadiativePowerMW:50,cyberHours:24});
const coordinates=p=>p&&typeof p.lat==='number'&&typeof p.lon==='number'&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180;
function distanceKm(a,b){if(!coordinates(a)||!coordinates(b))return Infinity;const dLat=(b.lat-a.lat)*RAD,dLon=(b.lon-a.lon)*RAD;const h=Math.sin(dLat/2)**2+Math.cos(a.lat*RAD)*Math.cos(b.lat*RAD)*Math.sin(dLon/2)**2;return 6371*2*Math.asin(Math.min(1,Math.sqrt(h)));}
function bearing(a,b){const dl=(b.lon-a.lon)*RAD;return (Math.atan2(Math.sin(dl)*Math.cos(b.lat*RAD),Math.cos(a.lat*RAD)*Math.sin(b.lat*RAD)-Math.sin(a.lat*RAD)*Math.cos(b.lat*RAD)*Math.cos(dl))*180/Math.PI+360)%360;}
const age=(s,now)=>s.observed_at?(now-new Date(s.observed_at).getTime())/60000:Infinity;
const fresh=(s,minutes,now)=>age(s,now)>=-5&&age(s,now)<=minutes&&(!s.valid_to||new Date(s.valid_to).getTime()>now);
const precise=p=>!['country','region','district','approximate','unknown'].includes(String(p.data?.location_precision||p.location_precision||'').toLowerCase())&&(p.data?.geometry_precision||p.geometry_precision)!=='representative';
const snapshot=(s,role)=>({observation_id:s.id||null,object_id:s.object_id,role,observed_at:s.observed_at||null,fetched_at:s.fetched_at||null,lat:s.lat??null,lon:s.lon??null,data:s.data||{},provenance:s.provenance||[]});
function make(type,seed,target,support,now,radius,details,ttlMinutes){
 const distance=distanceKm(seed,target),providers=[...new Set([seed,target,...support].flatMap(s=>(s.provenance||[]).map(p=>p.provider)).filter(Boolean))];
 const verified=[seed,target,...support].every(s=>(s.provenance||[]).length&&(s.provenance||[]).every(p=>p.kind!=='inferred'));
 const strength=verified&&providers.length>=2&&distance<=radius/2?'HIGH':'MODERATE';
 const facts=[...details,Number.isFinite(distance)?`${distance.toFixed(1)} km between signals`:null,`Signal age ${Math.max(0,Math.round(age(seed,now)))} min`].filter(Boolean);
 const eventAt=new Date(seed.observed_at).toISOString();
 const deadlines=[now+ttlMinutes*60000,new Date(seed.observed_at).getTime()+ttlMinutes*60000];
 for(const evidence of [seed,target,...support]) {
  if(evidence.valid_to)deadlines.push(new Date(evidence.valid_to).getTime());
  if(evidence.event_type==='WEATHER'&&evidence.observed_at)deadlines.push(new Date(evidence.observed_at).getTime()+3600000);
  if(['aircraft','vessel'].includes(evidence.kind)&&evidence.observed_at)deadlines.push(new Date(evidence.observed_at).getTime()+300000);
 }
 return {type,rule_id:type,rule_version:1,fingerprint:hash([type,1,seed.object_id,target.object_id]),related_object_ids:[...new Set([seed.object_id,target.object_id,...support.map(s=>s.object_id)])],
  detected_at:new Date(now).toISOString(),window_start:eventAt,window_end:new Date(now).toISOString(),expires_at:new Date(Math.min(...deadlines)).toISOString(),
  strength,confidence:null,state:'derived',explanation:`RELATED SIGNALS / POTENTIAL RISK — ${facts.join('; ')}. Correlation does not establish causation or confirmed impact.`,
  rationale:{facts,independent_providers:providers,method:'Deterministic threshold screening v1; strength measures rule support, not probability of harm',thresholds:THRESHOLDS},
  geographic_context:{center:coordinates(target)?{lat:target.lat,lon:target.lon}:coordinates(seed)?{lat:seed.lat,lon:seed.lon}:null,distance_km:Number.isFinite(distance)?Math.round(distance*10)/10:null,points:[seed,target].filter(coordinates).map(p=>({lat:p.lat,lon:p.lon,object_id:p.object_id}))},
  evidence:[snapshot(seed,'trigger'),snapshot(target,'related object'),...support.map(s=>snapshot(s,'support'))]};
}
function evaluate({signals=[],assets=[],weather=[],cyberLinks=[]},now=Date.now()){
 M.check(signals.length<=250&&assets.length<=5000&&weather.length<=250&&cyberLinks.length<=1000,'Correlation input exceeds bounds');
 const results=new Map(),add=c=>{if(results.size<500)results.set(c.fingerprint,c);};
 for(const signal of signals){
  if(!signal.observed_at||!Array.isArray(signal.provenance)||!signal.provenance.length)continue;
  if(signal.event_type==='CYBER_INDICATOR'&&fresh(signal,THRESHOLDS.cyberHours*60,now)&&signal.data.status==='online'){
   for(const link of cyberLinks.filter(l=>l.source_object_id===signal.object_id&&['ANNOUNCED_BY','HOSTED_BY','AFFECTS'].includes(l.link_type)&&l.properties?.identity_match==='exact'&&l.provenance?.length&&l.provenance.every(p=>!['inferred','derived'].includes(p.kind))&&(!l.valid_to||new Date(l.valid_to).getTime()>now)&&(!l.valid_from||new Date(l.valid_from).getTime()<=now))){
    if(link.link_type==='ANNOUNCED_BY'&&signal.data.as_number&&link.properties.asn!==`AS${String(signal.data.as_number).replace(/^AS/i,'')}`)continue;
    const target={object_id:link.target_object_id,provenance:link.provenance,data:{link_type:link.link_type,identity_match:'exact'}};
    const c=make('CYBER_INFRA_RELATED_SIGNAL',signal,target,[],now,0,['Exact IP / asset identity and reported ontology relationship; no attribution of attacker or compromise'],1440);
    c.strength='HIGH';add(c);
   }
   continue;
  }
  if(!coordinates(signal)||!precise(signal))continue;
  for(const asset of assets){
   if(!coordinates(asset)||!precise(asset)||asset.object_id===signal.object_id)continue;
   const mobile=['aircraft','vessel'].includes(asset.kind);
   if(mobile&&!fresh(asset,5,now))continue;
   if(!mobile&&asset.fetched_at&&now-new Date(asset.fetched_at).getTime()>30*86400000)continue;
   const d=distanceKm(signal,asset);
   if(signal.event_type==='EARTHQUAKE'&&fresh(signal,1440,now)&&typeof signal.data.magnitude==='number'&&signal.data.magnitude>=THRESHOLDS.quakeMagnitude&&!mobile){
    if(d<=THRESHOLDS.quakeKm)add(make('EARTHQUAKE_INFRA_RISK',signal,asset,[],now,THRESHOLDS.quakeKm,[`Reported earthquake M${signal.data.magnitude}; nearby ${asset.kind}; damage not assessed`],1440));
    if(signal.data.tsunami===1&&asset.kind==='port'&&d<=THRESHOLDS.tsunamiPortKm)add(make('EARTHQUAKE_TSUNAMI_PORT_REVIEW',signal,asset,[],now,THRESHOLDS.tsunamiPortKm,['USGS tsunami-information flag is present; it is NOT a tsunami prediction or warning. Consult NOAA / local authorities'],1440));
   }
   if(signal.event_type==='SEVERE_WEATHER'&&fresh(signal,360,now)&&signal.data.severity==='high'&&['airport','aircraft'].includes(asset.kind)&&d<=THRESHOLDS.weatherKm){
    add(make('SEVERE_WEATHER_AVIATION_RISK',signal,asset,[],now,THRESHOLDS.weatherKm,[`Severe weather report near ${asset.kind}; representative point, not a confirmed impact footprint`],360));
   }
   if(signal.event_type==='FIRE'&&fresh(signal,360,now)&&d<=THRESHOLDS.fireKm){
    const wind=weather.filter(w=>w.event_type==='WEATHER'&&fresh(w,60,now)&&distanceKm(w,signal)<=20&&typeof w.data.wind_from_deg==='number'&&Number.isFinite(w.data.wind_from_deg)&&w.data.wind_from_deg>=0&&w.data.wind_from_deg<=360&&typeof w.data.wind_speed_ms==='number'&&w.data.wind_speed_ms>=THRESHOLDS.windMinMs).sort((a,b)=>distanceKm(a,signal)-distanceKm(b,signal))[0];
    if(!wind)continue;
    const toward=(wind.data.wind_from_deg+180)%360,heading=bearing(signal,asset),delta=Math.abs(((toward-heading+540)%360)-180);if(delta>THRESHOLDS.windSectorDegrees)continue;
    const facts=[`Fire reported; wind ${wind.data.wind_speed_ms} m/s toward ${Math.round(toward)}°; target bearing ${Math.round(heading)}°`, `Weather age ${Math.round(age(wind,now))} min; weather values may be model-derived`];
    if(!mobile)add(make('FIRE_WEATHER_INFRA_RISK',signal,asset,[wind],now,THRESHOLDS.fireKm,facts,360));
    if(['airport','aircraft'].includes(asset.kind)&&typeof signal.data.frp_mw==='number'&&signal.data.frp_mw>=THRESHOLDS.fireRadiativePowerMW&&typeof wind.data.visibility_m==='number'&&wind.data.visibility_m>=0&&wind.data.visibility_m<THRESHOLDS.visibilityMetres){
     add(make('FIRE_FLIGHT_OPERATIONS_RISK',signal,asset,[wind],now,THRESHOLDS.fireKm,[...facts,`FRP ${signal.data.frp_mw} MW; visibility ${wind.data.visibility_m} m. Smoke causation / operational disruption not established`],360));
    }
   }
  }
 }
 return [...results.values()];
}
module.exports={evaluate,distanceKm,bearing,THRESHOLDS};
