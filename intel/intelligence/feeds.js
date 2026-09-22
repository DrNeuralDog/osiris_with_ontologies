const M=require('../ontology/model');
const {hash,writeObservation,putLocation}=require('./history');
const iso=value=>{if(value==null||value==='')return null;const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;};
const point=row=>typeof row.lat==='number'&&Number.isFinite(row.lat)&&Math.abs(row.lat)<=90&&typeof(row.lon??row.lng)==='number'&&Number.isFinite(row.lon??row.lng)&&Math.abs(row.lon??row.lng)<=180;
const proof=(provider,record,at,url,kind='imported',metadata={})=>({provider,source_id:String(record),source_record_id:String(record),url:url||null,observed_at:at,kind,confidence:null,extraction_method:'Structured OSIRIS source adapter',metadata});
function normalizeFeed(feed,body){
 const rows=[];
 if(feed==='earthquakes')for(const r of body.earthquakes||[]){const at=iso(r.time);if(!point(r)||!at||!r.id)continue;rows.push({key:String(r.id),name:r.place||r.id,type:'event',event_type:'EARTHQUAKE',observed_at:at,lat:r.lat,lon:r.lng,data:{magnitude:r.magnitude,depth_km:r.depth,tsunami:r.tsunami},provenance:[proof('USGS',r.id,at,r.url)]});}
 if(feed==='fires')for(const r of body.fires||[]){if(r.type!=='fire'||!point(r)||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!/^\d{1,4}$/.test(String(r.time)))continue;const time=String(r.time).padStart(4,'0'),at=iso(`${r.date}T${time.slice(0,2)}:${time.slice(2)}:00Z`);if(!at)continue;const key=hash([r.lat,r.lng,at,body.source]);rows.push({key,name:`FIRMS hotspot ${r.lat}, ${r.lng}`,type:'event',event_type:'FIRE',observed_at:at,lat:r.lat,lon:r.lng,data:{frp_mw:r.frp,source_confidence:r.confidence,brightness:r.brightness},provenance:[proof(body.source||'NASA FIRMS',key,at,'https://firms.modaps.eosdis.nasa.gov/', 'imported',{confidence_raw:r.confidence,warning:'Hotspot detection; not fire perimeter or predicted spread'})]});}
 if(feed==='weather')for(const r of body.events||[]){const at=iso(r.date);if(!r.id||!point(r)||!at||!['weatherAlerts','severeStorms','gdacs'].includes(r.category))continue;rows.push({key:r.id,name:r.title,type:'event',event_type:'SEVERE_WEATHER',observed_at:at,valid_to:iso(r.expires),lat:r.lat,lon:r.lng,data:{severity:r.severity,category:r.category,location_precision:'representative_point'},provenance:[proof(r.provider||'OSIRIS weather',r.id,at,/^https:\/\//.test(r.source)?r.source:null)]});}
 if(feed==='cyber-attacks')for(const r of body.indicators||[]){const at=iso(r.last_online||r.first_seen);if(!at||!r.ip)continue;try{M.identifier('ip',r.ip);}catch{continue;}rows.push({key:r.ip,name:r.ip,type:'ip',identifiers:[{namespace:'ip',value:r.ip}],event_type:'CYBER_INDICATOR',observed_at:at,data:{status:r.status,malware:r.malware,port:r.port,as_number:r.as_number,source_record_id:r.id,location_precision:r.location_precision},provenance:[proof('abuse.ch Feodo Tracker',r.id,at,body.source_url)]});}
 if(feed==='news')for(const r of body.news||[]){const at=iso(r.published),place=r.place,p=Array.isArray(r.coords)?{lat:r.coords[0],lon:r.coords[1]}:place;if(!at||!place||!point(p)||!r.link||['country','country-anchor','region'].includes(r.location_precision))continue;rows.push({key:hash(r.link),name:r.title||r.headline||r.link,type:'event',event_type:'NEWS_EVENT',observed_at:at,lat:p.lat,lon:p.lng??p.lon,data:{title:r.title,location_precision:place.precision||'reported_place'},provenance:[proof(r.source_name||r.source||'OSIRIS news',r.link,at,r.link,'imported',{location_method:'Existing OSIRIS place-name resolver; derived coordinates, not a measured event position',location_state:'derived',place:place.name})]});}
 if(feed==='news')for(const item of (body.news||[]).slice(0,200)){const warning=require('./civilian-reports').newsWarning(item);if(warning)rows.push(warning);}
 return rows.filter(r=>Date.parse(r.observed_at)<=Date.now()+300000).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at));
}
class FeedIngestor{
 constructor(store){this.store=store;}
 async events(feed,body){
  const rows=normalizeFeed(feed,body).slice(0,200);let imported=0;
  // Small transactions with no network operations under the ontology lock.
  for(let offset=0;offset<rows.length;offset+=25)await this.store.transaction(async db=>{
   for(const r of rows.slice(offset,offset+25)){
    // A warning is an interpretation of the same news record, not a change of its identity.
    const object=await this.store.putObject(db,{type:r.type,canonical_name:String(r.name).slice(0,300),external_ids:r.identifiers||[{namespace:`source:${feed}`,value:r.key}],properties:{event_type:feed==='news'?'NEWS_EVENT':r.event_type},provenance:r.provenance});
    await writeObservation(db,object,{...r,source_id:`feed:${feed}`});imported++;
    if(r.event_type==='CYBER_INDICATOR'&&r.data.as_number){
     let asn;try{asn=M.identifier('asn',String(r.data.as_number));}catch{continue;}
     const target=await this.store.putObject(db,{type:'infrastructure',canonical_name:asn.value,external_ids:[asn],properties:{network_type:'ASN'},provenance:r.provenance});
     await this.store.putLink(db,{source_object_id:object,target_object_id:target,link_type:'ANNOUNCED_BY',properties:{identity_match:'exact',asn:asn.value,method:'IP and ASN in same source record'},provenance:r.provenance});
    }
   }
  });
  return imported;
 }
 async assets(body){
  const rows=[...(body.airports||[]).map(r=>({...r,kind:'airport',key:r.icao,namespace:'icao_airport'})),...(body.infrastructure||[]).map(r=>({...r,kind:'infrastructure',key:r.id,namespace:'source:osiris-infrastructure'})),...(body.ports||[]).map(r=>({...r,kind:'port',key:r.id||hash([r.name,r.lat,r.lng]),namespace:'source:osiris-ports'}))].filter(r=>r.key&&point(r)).slice(0,1200);
  for(let offset=0;offset<rows.length;offset+=25)await this.store.transaction(async db=>{
   for(const r of rows.slice(offset,offset+25)){
    const provenance=[proof('OSIRIS reference catalog',r.key,null,r.sourceUrl||null,'imported',{coverage:'Existing static catalog; position is reference data, not a live measurement'})];
    const id=await this.store.putObject(db,{type:r.kind,canonical_name:r.name,external_ids:[{namespace:r.namespace,value:r.key}],properties:{country:r.country||null,city:r.city||null},provenance});
    await putLocation(db,id,r.kind,r.name,{lat:r.lat,lon:r.lng,provenance});
   }
  });return rows.length;
 }
 async telemetry(feed,body){
  const aircraft=feed==='flights',type=aircraft?'aircraft':'vessel',namespace=aircraft?'icao24':'mmsi';
  const rows=aircraft?['commercial_flights','private_flights','private_jets','military_flights'].flatMap(k=>body[k]||[]):body.ships||[];
  const indexed=new Map(rows.filter(r=>point(r)&&r.observed_at).map(r=>[String(aircraft?r.icao24:r.mmsi).toLowerCase(),r]));
  // Only already registered ontology objects are tracked; a global feed is not an instruction to create 20,000 entities.
  const tracked=(await this.store.pool.query('SELECT o.id,o.canonical_name,i.value FROM ontology_objects o JOIN ontology_identifiers i ON i.object_id=o.id WHERE o.type=$1 AND i.namespace=$2 ORDER BY o.updated_at DESC LIMIT 300',[type,namespace])).rows;
  const previousRows=(await this.store.pool.query("SELECT DISTINCT ON(object_id) object_id,observed_at,data FROM intelligence_observations WHERE object_id=ANY($1::uuid[]) AND event_type='POSITION' ORDER BY object_id,observed_at DESC",[tracked.map(o=>o.id)])).rows;
  const previous=new Map(previousRows.map(r=>[r.object_id,r]));
  let count=0;
  for(let offset=0;offset<tracked.length;offset+=25)await this.store.transaction(async db=>{
   for(const object of tracked.slice(offset,offset+25)){
    const r=indexed.get(object.value),at=iso(r?.observed_at);if(!r||!at||Date.now()-Date.parse(at)>3600000||Date.parse(at)>Date.now()+300000)continue;
    const provenance=[proof(r.provider||(aircraft?'ADS-B source':'AISStream'),object.value,at,null,'observed',{timestamp_origin:'source position timestamp',sampled:true})];
    const data=aircraft?{altitude_m:r.alt,speed_knots:r.speed_knots,heading:r.heading,on_ground:r.on_ground??null,callsign:r.callsign}:{speed_knots:r.speed,heading:r.heading,name:r.name};
    // Minute buckets cap storage. They do not replace the original source timestamp.
    const before=previous.get(object.id);
    if(before&&Math.floor(new Date(before.observed_at).getTime()/60000)>=Math.floor(Date.parse(at)/60000))continue;
    await writeObservation(db,object.id,{event_type:'POSITION',observed_at:at,lat:r.lat,lon:r.lng,data,source_id:`feed:${feed}`,provenance});
    if(aircraft&&typeof data.on_ground==='boolean'&&typeof before?.data?.on_ground==='boolean'&&data.on_ground!==before.data.on_ground)await writeObservation(db,object.id,{event_type:data.on_ground?'ON_GROUND':'AIRBORNE',observed_at:at,lat:r.lat,lon:r.lng,data:{on_ground:data.on_ground,previous_observed_at:before.observed_at,method:'Change in source-reported ground state; not a confirmed landing or departure'},source_id:`feed:${feed}`,provenance:provenance.map(p=>({...p,kind:'derived'}))});
    await putLocation(db,object.id,type,object.canonical_name,{observed_at:at,lat:r.lat,lon:r.lng,provenance});count++;
   }
  });return count;
 }
}
module.exports={FeedIngestor,normalizeFeed,iso,proof};
