import {ProviderCache,boundedJSON} from './server-cache';
import {reported} from './conflict';
import {array,record,str,num,timestamp,type Bounds,type ProviderResult} from './types';
const acledCache=new ProviderCache('acled',86400000,60000,8),ucdpCache=new ProviderCache('ucdp',86400000,60000,8);
let oauth:{token:string;until:number}|null=null;
/** Explicit bounded historical request only. Never part of minute polling. */
export async function enrichment(provider:'acled'|'ucdp',from:string,to:string,b:Bounds):Promise<ProviderResult>{
 const a=timestamp(from),z=timestamp(to);if(!a||!z||a>z||Date.parse(z)-Date.parse(a)>31*86400000)throw new Error('INVALID_RANGE');
 if(provider==='ucdp'){
  if(!process.env.UCDP_API_TOKEN)return {records:[],status:'KEY_REQUIRED'};
  return ucdpCache.get(JSON.stringify([a,z,b]),async()=>{const q=new URLSearchParams({StartDate:a.slice(0,10),EndDate:z.slice(0,10),Geography:`${b[1]} ${b[0]},${b[3]} ${b[2]}`,pagesize:'200',page:'1'});const body=record(await boundedJSON(`https://ucdpapi.pcr.uu.se/api/gedevents/26.1?${q}`,{headers:{'x-ucdp-access-token':process.env.UCDP_API_TOKEN!}}));return {status:'AVAILABLE',truncated:Number(body.TotalCount)>200,records:array(body.Result).filter(v=>/^\d+$/.test(str(record(v).id))).slice(0,200).map(v=>{const r=record(v);return reported({id:`ucdp:${r.id}`,provider:'UCDP',name:str(r.conflict_name)||'Historical conflict event',subtype:'CONFLICT_EVENT',lat:num(r.latitude),lon:num(r.longitude),observed_at:timestamp(r.date_start),url:'https://ucdp.uu.se/',location_precision:Number(r.where_prec)===1?'LOCALITY':'APPROXIMATE',properties:{dataset_version:'26.1',country:r.country,raw_event_type:r.type_of_violence,date_precision:r.date_prec,source_text:r.source_article,valid_to:timestamp(r.date_end)?new Date(Date.parse(String(r.date_end))+86400000).toISOString():null,historical:true}});})};});
 }
 if(!process.env.ACLED_USERNAME||!process.env.ACLED_PASSWORD)return {records:[],status:'KEY_REQUIRED'};
 return acledCache.get(JSON.stringify([a,z,b]),async()=>{
  if(!oauth||oauth.until<Date.now()){const t=record(await boundedJSON('https://acleddata.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:process.env.ACLED_USERNAME!,password:process.env.ACLED_PASSWORD!,grant_type:'password',client_id:'acled',scope:'authenticated'}).toString()},100000));if(!t.access_token)throw new Error('AUTH_FAILED');oauth={token:str(t.access_token,10000),until:Date.now()+Math.min(86400,Number(t.expires_in)||3600)*1000-60000};}
  const q=new URLSearchParams({_format:'json',limit:'200',page:'1',event_date:`${a.slice(0,10)}|${z.slice(0,10)}`,event_date_where:'BETWEEN',latitude:`${b[1]}|${b[3]}`,latitude_where:'BETWEEN',longitude:`${b[0]}|${b[2]}`,longitude_where:'BETWEEN'});
  const body=record(await boundedJSON(`https://acleddata.com/api/acled/read?${q}`,{headers:{Authorization:`Bearer ${oauth.token}`}}));return {status:'AVAILABLE',truncated:array(body.data).length>=200,records:array(body.data).filter(v=>/^[a-zA-Z0-9_-]{1,100}$/.test(str(record(v).event_id_cnty))).slice(0,200).map(v=>{const r=record(v);return reported({id:`acled:${r.event_id_cnty}`,provider:'ACLED',name:str(r.sub_event_type||r.event_type),subtype:'CONFLICT_EVENT',lat:num(r.latitude),lon:num(r.longitude),observed_at:timestamp(r.event_date),url:'https://acleddata.com/',location_precision:Number(r.geo_precision)===1?'LOCALITY':'APPROXIMATE',properties:{country:r.country,admin1:r.admin1,source:r.source,raw_event_type:r.event_type,date_precision:r.time_precision,historical:true}});})};
 });
}
