const M=require('../ontology/model');
const {normalizeFeed,proof,iso}=require('./feeds');
const {hash,writeObservation,putLocation}=require('./history');
const TYPES=['aircraft','vessel','country','company','person','ip','fire','earthquake','weather','infrastructure','airport','port','satellite','camera','news','event'];
function investigationInput(input){
 if(input?.type==='world')return require('./world').worldInput(input);
 M.check(input&&typeof input==='object'&&TYPES.includes(input.type),'Unsupported investigation type');
 const r=M.jsonObject(input.record),type=input.type,id=M.text(input.id,'stable ID',500);
 const provider=M.text(input.provider||'OSIRIS map','provider',100),name=M.text(input.name||id,'name',300);
 const at=iso(r.observed_at),lat=r.lat,lon=r.lng??r.lon;
 let objectType=type,ids=[],event=null;
 const add=(ns,value)=>{if(value)ids.push(M.identifier(ns,String(value)));};
 if(type==='fire'){
  M.check(/^NASA-FIRMS \((VIIRS|MODIS)\)$/.test(provider),'FIRMS provider required');
  event=normalizeFeed('fires',{fires:[{...r,type:'fire'}],source:provider})[0];M.check(event,'FIRMS source date/time/coordinates required');
  objectType='event';add('source:fires',event.key);
 }else if(type==='earthquake'){
  M.check(/^[a-z]{2}[a-z\d]+$/i.test(id),'USGS event ID required');
  objectType='event';add('source:earthquakes',id);event=normalizeFeed('earthquakes',{earthquakes:[{...r,id}]})[0];
 }else if(type==='weather'){
  M.check(/^(nws-|eonet-|gdacs-).+/.test(id),'Weather source record ID required');objectType='event';add('source:weather',id);
  event=normalizeFeed('weather',{events:[{...r,id,provider}]})[0];
 }else if(type==='news'||type==='event'){
  let url;try{url=new URL(id);}catch{throw new M.InputError('Canonical source URL required');}
  M.check(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password,'Invalid source URL');
  url.hash='';objectType='event';add('source:news',hash(url.href));
  // Retain the existing feed key when its URL differs only by canonical URL
  // serialization or a fragment. This reuses already ingested news objects.
  const original=r.link||r.url;
  if(typeof original==='string'){try{const prior=new URL(original);prior.hash='';if(prior.href===url.href)add('source:news',hash(original));}catch{/* No URL alias for an invalid source record. */}}
  event=normalizeFeed('news',{news:[{...r,link:url.href,title:name,source_name:provider,place:r.place||{lat,lon,precision:'reported_place'},coords:[lat,lon]}]})[0];
 }else if(type==='satellite'){add('norad',id);}
 else if(type==='camera'){M.check(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(id),'Invalid catalog camera ID');add('source:osiris-cctv',id);}
 else if(type==='airport'){add('icao_airport',r.icao);add('iata',r.iata);if(!ids.length)add(id.length===4?'icao_airport':'iata',id);}
 else if(type==='infrastructure'){add('source:osiris-infrastructure',id);}
 else if(type==='port'){M.check(typeof lat==='number'&&typeof lon==='number','Catalog port coordinates required');add('source:osiris-ports',r.catalog_id||r.id||hash([name,lat,lon]));}
 else if(type==='aircraft'){add('icao24',input.icao24||r.icao24);add('registration',input.registration||r.registration);}
 else if(type==='vessel'){add('imo',input.imo||r.imo);add('mmsi',input.mmsi||r.mmsi);}
 else if(type==='country'){add('wikidata',input.wikidata||r.wikidata);add('iso3166',input.iso3166||r.iso3166||(/^[a-z]{2}$/i.test(id)?id:null));}
 else if(type==='ip'){add('ip',id);}
 else {add('wikidata',input.wikidata||r.wikidata||(/^Q[1-9]\d*$/.test(id)?id:null));if(!ids.length&&input.source_id&&provider!=='OSIRIS map')add(`source:${provider.toLowerCase().replace(/[^a-z\d.-]/g,'-')}`,input.source_id);}
 M.check(ids.length>0,'Stable source identifier required; names alone are not identity');
 const sourceUrl=[r.url,r.sourceUrl,r.source,r.external_url,r.feed_url,r.link].find(value=>typeof value==='string'&&/^https?:/.test(value))||null;
 const evidence=event?.provenance||[proof(provider,id,at,sourceUrl,'imported')];
 // Browser-selected records are imported assertions, never independently verified measurements.
 for(const p of evidence){p.kind='imported';if(type==='satellite'){p.extraction_method='OSIRIS SGP4 propagation from TLE';p.metadata={...p.metadata,position_state:'derived',position_method:'Calculated orbital position; not measured telemetry'};}p.metadata={...p.metadata,selection:'User-selected OSIRIS map record; not independently re-fetched',client_supplied:true};}
 if(!event&&at&&['aircraft','vessel'].includes(type)&&typeof lat==='number'&&typeof lon==='number')event={event_type:'POSITION',observed_at:at,lat,lon,data:{altitude_m:r.alt,heading:r.heading},provenance:evidence};
 if(type==='satellite'&&at&&typeof lat==='number'&&typeof lon==='number')event={event_type:'POSITION',observed_at:at,lat,lon,data:{altitude_km:r.alt,method:'SGP4 / TLE propagated position'},provenance:evidence.map(p=>({...p,kind:'derived',extraction_method:'Existing OSIRIS satellite propagation'}))};
 return {object:{type:objectType,canonical_name:name,external_ids:ids,properties:{...r,investigation_kind:type},provenance:evidence},event:event?{...event,provenance:event.provenance||evidence}:null,lat,lon};
}
async function objectContext(store,id){
 const object=await store.get(M.uuid(id));const counts=(await store.pool.query(`SELECT (SELECT count(*)::int FROM ontology_links WHERE source_object_id=$1 OR target_object_id=$1) relationships,(SELECT count(*)::int FROM intelligence_observations WHERE object_id=$1) observations`,[object.id])).rows[0];
 return {object,...counts};
}
async function investigate(store,input){
 const parsed=investigationInput(input);
 const id=await store.transaction(async db=>{
  if(input.type==='world')return require('./world').saveWorld(store,db,parsed);
  const id=await store.putObject(db,parsed.object);
  if(parsed.event)await writeObservation(db,id,parsed.event);
  if(typeof parsed.lat==='number'&&typeof parsed.lon==='number')await putLocation(db,id,parsed.object.type,parsed.object.canonical_name,{lat:parsed.lat,lon:parsed.lon,provenance:parsed.object.provenance,observed_at:parsed.event?.observed_at});
  return id;
 });return objectContext(store,id);
}
module.exports={investigate,investigationInput,objectContext};
