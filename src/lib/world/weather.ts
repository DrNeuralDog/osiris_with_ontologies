import {ProviderCache,boundedJSON} from './server-cache';
import {array,record,num,str,type Bounds,type WorldRecord} from './types';
import {createHash} from 'node:crypto';
import {weatherGridSpec,type WeatherOptions} from './weather-grid';
import type {WeatherResult,WeatherDiagnostics} from './weather-types';
const caches={free:new ProviderCache('open-meteo',600000,5000,24,100),customer:new ProviderCache('open-meteo',600000,5000,24,100)};
export function weatherGrid(b:Bounds,options:WeatherOptions={}){return weatherGridSpec(b,options).points;}
export function normalizeWeather(body:unknown,points:number[][],now=new Date().toISOString()):WorldRecord[]{return (Array.isArray(body)?body:[body]).slice(0,81).flatMap((v,i)=>{
 const r=record(v),c=record(r.current),h=record(r.hourly),p=points[i];if(!p||!c.time)return [];const at=`${str(c.time)}Z`;if(!Number.isFinite(Date.parse(at)))return [];
 const hi=array(h.time).findIndex(t=>`${t}`.slice(0,13)===str(c.time).slice(0,13));
 return [{id:`open-meteo:${p.join(',')}`,provider:'Open-Meteo',name:`Weather model ${p.join(', ')}`,domain:'weather',subtype:'WEATHER',lat:p[0],lon:p[1],observed_at:at,fetched_at:now,url:'https://open-meteo.com/en/docs',evidence_state:'DERIVED',confidence:null,extraction_method:'best_match model current conditions; hourly visibility',geometry_precision:'representative',location_precision:'APPROXIMATE',source_license:'CC BY 4.0; free API non-commercial',source_attribution:'Weather data by Open-Meteo',properties:{temperature_c:num(c.temperature_2m),humidity_percent:num(c.relative_humidity_2m),precipitation_mm:num(c.precipitation),cloud_percent:num(c.cloud_cover),pressure_hpa:num(c.pressure_msl),wind_speed_ms:num(c.wind_speed_10m),wind_from_deg:num(c.wind_direction_10m),wind_gust_ms:num(c.wind_gusts_10m),visibility_m:hi<0?null:num(array(h.visibility)[hi]),visibility_valid_at:hi<0?null:`${array(h.time)[hi]}Z`,model:'best_match',model_run_at:null,valid_at:at,interval_seconds:c.interval,units:r.current_units,hourly_units:r.hourly_units,requested_lat:p[0],requested_lon:p[1],model_lat:r.latitude,model_lon:r.longitude}} satisfies WorldRecord];
 });}
export function weatherRequest(points:number[][]):URL {
 const mode=process.env.OPEN_METEO_API_MODE||'free',key=process.env.OPEN_METEO_API_KEY?.trim();
 if(!['free','customer'].includes(mode))throw new Error('INVALID_OPEN_METEO_API_MODE');
 if(mode==='customer'&&(!key||/^(replace|your[-_ ]|example|changeme)/i.test(key)))throw new Error('CUSTOMER_KEY_REQUIRED');
 const q=new URLSearchParams({latitude:points.map(p=>p[0]).join(','),longitude:points.map(p=>p[1]).join(','),current:'temperature_2m,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m',hourly:'visibility',forecast_hours:'2',wind_speed_unit:'ms',timezone:'UTC',cell_selection:'nearest'});
 if(mode==='customer')q.set('apikey',key!);
 return new URL(`https://${mode==='customer'?'customer-api':'api'}.open-meteo.com/v1/forecast?${q}`);
}
async function weatherJSON(url:URL){
 for(let attempt=0;attempt<2;attempt++){
  try{return await boundedJSON(url.href,{},1024*1024);}catch(error){
   // Idempotent fixed-provider read. Never retry an HTTP credential/quota error.
   if(attempt===0&&error instanceof TypeError&&error.message==='fetch failed')continue;
   if(error instanceof TypeError){const cause=record(error.cause),code=str(cause.code);console.warn('[Open-Meteo] transport failed',/^[A-Z0-9_]{1,50}$/.test(code)?code:'UNKNOWN');throw new Error('NETWORK_CONNECTION_FAILED');}
   if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))throw new Error('UPSTREAM_TIMEOUT');
   throw error;
  }
 }
 throw new Error('NETWORK_CONNECTION_FAILED');
}
export async function weather(b:Bounds,options:WeatherOptions={}):Promise<WeatherResult>{
 const grid=weatherGridSpec(b,options),start=Date.now(),mode=process.env.OPEN_METEO_API_MODE||'free';
 const base:WeatherDiagnostics={provider:'Open-Meteo',mode,status:'UNAVAILABLE',cache:'MISS',requested:grid.points.length,received:0,normalized:0,fetched_at:null,data_at:null,error:null,http_status:null,retry_after_seconds:0,duration_ms:0};
 let url:URL;try{url=weatherRequest(grid.points);}catch(e){return {records:[],status:'UNAVAILABLE',grid,diagnostics:{...base,status:mode==='customer'?'KEY_REQUIRED':'UNAVAILABLE',error:e instanceof Error?e.message:'CONFIGURATION_ERROR'}};}
 const cache=caches[mode as keyof typeof caches],key=createHash('sha256').update(url.href).digest('hex');
 type Stored={records:WorldRecord[];received:number;fetched_at:string};
 const before=cache.inspect<Stored>(key);let received=0;
 try{
  const result=await cache.get(key,async()=>{
   const body=await weatherJSON(url);received=Array.isArray(body)?body.length:1;
   if(record(body).error)throw new Error('PROVIDER_API_ERROR');
   const fetched_at=new Date().toISOString(),records=normalizeWeather(body,grid.points,fetched_at);
   if(!records.length||!records.some(r=>['temperature_c','precipitation_mm','wind_speed_ms','visibility_m','cloud_percent','pressure_hpa'].some(k=>typeof r.properties[k]==='number')))throw new Error('NO_USABLE_MODEL_DATA');
   return {records,received,fetched_at};
  });
  return {records:result.records,status:result.records.length===grid.points.length?'AVAILABLE':'PARTIAL',grid,diagnostics:{...base,status:result.records.length===grid.points.length?'HEALTHY':'DEGRADED',cache:before.state,received:result.received,normalized:result.records.length,fetched_at:result.fetched_at,data_at:result.records[0]?.observed_at??null,http_status:200,duration_ms:Date.now()-start}};
 }catch(e){
  const current=cache.inspect<Stored>(key),code=e instanceof Error?e.message:'NETWORK_ERROR';
  // Only the same grid and credential may use stale-good data; never a different viewport.
  const stale=before.value&&before.age_ms!==null&&before.age_ms<=1800000?before.value:null;
  const reason=code==='PROVIDER_BACKOFF'&&current.last_error?`${current.last_error} · PROVIDER_BACKOFF`:code;
  return {records:stale?.records||[],status:stale?'STALE':'UNAVAILABLE',grid,diagnostics:{...base,status:stale?'DEGRADED':'UNAVAILABLE',cache:stale?'STALE':'MISS',received,normalized:stale?.records.length||0,fetched_at:stale?.fetched_at||null,data_at:stale?.records[0]?.observed_at||null,error:reason,http_status:reason.match(/HTTP_(\d{3})/)?.[1]?Number(reason.match(/HTTP_(\d{3})/)![1]):null,retry_after_seconds:Math.ceil(current.retry_after_ms/1000),duration_ms:Date.now()-start}};
 }
}
export interface RadarFrame {time:number;path:string}
const radarCache=new ProviderCache('rainviewer',120000,1000,1);
export async function radar(){return radarCache.get('metadata',async()=>{const body=record(await boundedJSON('https://api.rainviewer.com/public/weather-maps.json',{},100000));const frames=array(record(body.radar).past).map(record).filter(r=>typeof r.time==='number'&&/^\/v2\/radar\/[a-zA-Z0-9_-]+$/.test(str(r.path))).map(r=>({time:Number(r.time)*1000,path:str(r.path)})).slice(-18);return {frames,status:'AVAILABLE',attribution:'RainViewer',maxzoom:7};});}
export function radarAt(frames:RadarFrame[],at:number){if(!frames.length||at<frames[0].time||at>frames.at(-1)!.time+600000)return null;return frames.filter(f=>f.time<=at).at(-1)||null;}
