import {alertsInUA,providerCapabilities} from '@/lib/air-threat/providers';
export {alertsInUA} from '@/lib/air-threat/providers';
import {fetchGdeltEvents,type GdeltEvent} from '@/lib/gdeltEvents';
import {ProviderCache} from './server-cache';
import {ReportClockBuffer} from './report-clock';
import {warTrackerJSON} from './war-tracker-client';
import {array,record,str,num,timestamp,CONFLICT_TYPES,type WorldRecord,type ProviderResult,type Precision} from './types';
const gdeltCache=new ProviderCache('gdelt-conflict',900000,15000,1);
const warCache=new ProviderCache('war-tracker',180000,180000,1);
let warState='NOT_CHECKED';
const reportClock=new ReportClockBuffer();
export const warTrackerCapability=()=>({id:'war-tracker',name:'War-Tracker · civil alerts',coverage:[],credential_state:warState==='ACCESS_REQUIRED'?'ACCESS_REQUIRED':process.env.WAR_TRACKER_API_KEY?'CONFIGURED':'NOT_REQUIRED',status:warState,connected:warState==='AVAILABLE',documentation:'https://war-tracker.com/api/v1/openapi.json',cadence_seconds:180,attribution:'War-Tracker; civil alert query only'});

export const retainedReportsAt=(records:WorldRecord[],now=Date.now())=>records.filter(r=>r.observed_at!=null&&Number.isFinite(Date.parse(r.observed_at))&&Date.parse(r.observed_at)<=now);
export function reported(input:Partial<WorldRecord>&Pick<WorldRecord,'id'|'provider'|'name'|'subtype'>):WorldRecord {
 const point=typeof input.lat==='number'&&Number.isFinite(input.lat)&&Math.abs(input.lat)<=90&&typeof input.lon==='number'&&Number.isFinite(input.lon)&&Math.abs(input.lon)<=180;
 let url='';try{const parsed=new URL(input.url||'');if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)url=parsed.href;}catch{/* Missing source links remain unavailable. */}
 return {domain:'conflict',observed_at:null,fetched_at:new Date().toISOString(),evidence_state:'REPORTED',confidence:null,extraction_method:'Imported source report; not independently confirmed',geometry_precision:'representative',location_precision:'UNKNOWN',source_license:'Provider terms apply',source_attribution:input.provider,properties:{},...input,name:input.name.slice(0,300),lat:point?input.lat!:null,lon:point?input.lon!:null,url};
}
export function gdeltRecord(e:GdeltEvent):WorldRecord {
 // CAMEO coding concerns news descriptions, not direct detection of an attack.
 const subtype=e.event_code==='195'?'AIRSTRIKE':e.event_code==='194'?'ARTILLERY':'CONFLICT_EVENT';
 const precision:Precision=[1,2,5].includes(e.geo_type||0)?'REGION':[3,4].includes(e.geo_type||0)?'LOCALITY':'UNKNOWN';
 return reported({id:`gdelt:${e.id}`,provider:'GDELT',name:`${subtype.replaceAll('_',' ')} report · ${e.name}`,subtype,lat:e.geo_type===1?null:e.lat,lon:e.geo_type===1?null:e.lng,observed_at:e.date,url:e.url,location_precision:precision,source_license:'GDELT open data; source articles retain copyright',extraction_method:'GDELT CAMEO coding of news; DATEADDED is reporting time',properties:{source_geo_type:e.geo_type??null,country:e.country,country_code_system:'GDELT FIPS',cameo:e.event_code,source_record_id:e.id,reported_at:e.date,event_date:e.event_date||null,time_precision:'report timestamp; event date only',articles:e.articles,sources:e.sources,raw_event_type:e.root_code}});
}
export function warRecord(v:unknown):WorldRecord|null {
 const r=record(v),id=str(r.id);if(!id||!timestamp(r.date||r.timestamp||r.published_at))return null;
 const raw=str(r.event_type),type=raw.toUpperCase().replaceAll(/[ -]/g,'_');
 const precision=str(r.location_precision).toUpperCase();
 return reported({id:`war-tracker:${id}`,provider:'War-Tracker',name:str(r.title||r.headline)||`${raw} · ${str(r.location)||'source report'}`,subtype:CONFLICT_TYPES.includes(type as typeof CONFLICT_TYPES[number])?type:'CONFLICT_EVENT',lat:num(r.lat??r.latitude),lon:num(r.lon??r.lng??r.longitude),observed_at:timestamp(r.date||r.timestamp||r.published_at),url:str(r.url||r.canonical_url)||`https://war-tracker.com/share/${encodeURIComponent(id)}/${encodeURIComponent(str(r.slug)||'event')}`,location_precision:['LOCALITY','DISTRICT','REGION','APPROXIMATE','EXACT_SOURCE_COORDINATE'].includes(precision)?precision as Precision:'UNKNOWN',properties:{original_text:str(r.description||r.title,2500),area_name:str(r.location),provider_raw_type:raw,position_semantics:'REPORT_AREA',country:r.country,region:r.region,reported_at:r.date||r.timestamp||r.published_at,source_post_url:r.source_url||r.telegram_url||null,source_confidence:r.confidence||null,confidence_basis:'Source classifier tier; not OSIRIS probability',raw_event_type:raw,source_classification:'Provider uses automated / LLM classification with selected human review'}});
}
export async function warTracker():Promise<ProviderResult>{
 const key=process.env.WAR_TRACKER_API_KEY;
 try{return await warCache.get('recent',async()=>{let cursor:string|null=null;const records:WorldRecord[]=[];for(let i=0;i<2;i++){
  const q=cursor?new URLSearchParams({cursor}):new URLSearchParams({limit:'100',event_type:'Air raid alert',from:new Date(Date.now()-86400000).toISOString()});
  const r=record(await warTrackerJSON(q,key));if(!Array.isArray(r.events||r.data))throw new Error('INVALID_PROVIDER_JSON');
  records.push(...array(r.events||r.data).map(warRecord).filter((v):v is WorldRecord=>!!v&&['AIR_RAID_ALERT','PRE_ALERT','ALL_CLEAR','DRONE_THREAT','MISSILE_THREAT','ROCKET_ALERT'].includes(v.subtype)));cursor=typeof r.next_cursor==='string'&&r.next_cursor.length<=4096?r.next_cursor:null;if(!cursor)break;
 }warState='AVAILABLE';return {records:records.slice(0,200),status:'AVAILABLE',truncated:!!cursor};});}
 catch(e){const message=e instanceof Error?e.message:'PROVIDER_FAILURE';if(/^HTTP_(401|402|403)$/.test(message))warState='ACCESS_REQUIRED';else if(message!=='PROVIDER_BACKOFF')warState='UNAVAILABLE';return {records:[],status:warState,message};}
}
export async function conflicts(){
 const sources=await Promise.allSettled([gdeltCache.get('recent',async()=>({records:(await fetchGdeltEvents({quads:[4],minArticles:1,limit:300})).events.filter(e=>e.source_time_available!==false&&['18','19','20'].includes(e.root_code)).map(gdeltRecord),status:'AVAILABLE'})),warTracker(),alertsInUA()]);
 // Keep source time intact; a feed's future report must not become a current observation.
 const now=Date.now();
 const buffered=reportClock.collect(sources.flatMap(r=>r.status==='fulfilled'?r.value.records:[]),now);
 const providers=sources.map((r,i)=>({provider:['GDELT','War-Tracker','alerts.in.ua'][i],...(r.status==='fulfilled'?{status:r.value.status,message:'message' in r.value?r.value.message:undefined,count:retainedReportsAt(r.value.records,now).length,future_records_omitted:r.value.records.filter(v=>v.observed_at&&Date.parse(v.observed_at)>now).length}:{status:'UNAVAILABLE',message:r.reason instanceof Error?r.reason.message:'PROVIDER_FAILURE',count:0})}));
 const records=buffered.records.sort((a,b)=>Number(b.provider==='alerts.in.ua')-Number(a.provider==='alerts.in.ua')||String(b.observed_at).localeCompare(String(a.observed_at))).slice(0,600).sort((a,b)=>String(b.observed_at).localeCompare(String(a.observed_at)));
 return {records,providers,clock:{pending:buffered.pending,rejected:buffered.rejected,policy:'Source timestamps unchanged; pending reports mature at source time'},official_providers:[...providerCapabilities(),warTrackerCapability()],status:providers.some(p=>p.status==='AVAILABLE')?'AVAILABLE':'UNAVAILABLE',truncated:records.length>=600};
}
