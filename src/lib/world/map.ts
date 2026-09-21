import type {WorldRecord} from './types';
export const WEATHER_FIELDS={wx_temperature:{property:'temperature_c',label:'Temperature',unit:'°C',min:-20,max:45},wx_pressure:{property:'pressure_hpa',label:'Sea-level pressure',unit:'hPa',min:980,max:1040},wx_precipitation:{property:'precipitation_mm',label:'Precipitation / model interval',unit:'mm',min:0,max:10},wx_cloud:{property:'cloud_percent',label:'Cloud cover',unit:'%',min:0,max:100},wx_visibility:{property:'visibility_m',label:'Visibility',unit:'m',min:0,max:50000}};
export function mapFeatures(records:WorldRecord[]):GeoJSON.FeatureCollection {
 return {type:'FeatureCollection',features:records.filter(r=>r.lat!==null&&r.lon!==null).slice(0,1200).map(r=>({type:'Feature',id:r.id,geometry:{type:'Point',coordinates:[r.lon!,r.lat!]},properties:{id:r.id,label:r.name,color:r.domain==='infrastructure'?'#d4af37':r.domain==='conflict'?'#fb7185':'#7dd3fc',domain:r.domain,...r.properties}}))};
}
export function geometryFeatures(records:WorldRecord[]):GeoJSON.FeatureCollection{return {type:'FeatureCollection',features:records.filter(r=>r.geometry).slice(0,500).map(r=>({type:'Feature',geometry:r.geometry!,properties:{id:r.id}}))};}
/** A vector is a model wind direction/speed indicator, not a tracked path. */
export function windFeatures(records:WorldRecord[]):GeoJSON.FeatureCollection{return {type:'FeatureCollection',features:records.flatMap(r=>{
 const speed=r.properties.wind_speed_ms,from=r.properties.wind_from_deg;if(r.lat===null||r.lon===null||typeof speed!=='number'||typeof from!=='number')return [];const rad=(from+180)*Math.PI/180,scale=Math.min(20,speed)*.002;
 const tip=[r.lon+Math.sin(rad)*scale/Math.max(.1,Math.cos(r.lat*Math.PI/180)),r.lat+Math.cos(rad)*scale];
 return [{type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[r.lon,r.lat],tip]},properties:{id:r.id,label:`${speed.toFixed(1)} m/s`,bearing:(from+180)%360}},{type:'Feature' as const,geometry:{type:'Point' as const,coordinates:tip},properties:{id:r.id,label:'▲',bearing:(from+180)%360}}];
 })};}
export interface RadarFrame {time:number;path:string}
export function radarFrameAt(frames:RadarFrame[],at:number){if(!frames.length||at<frames[0].time||at>frames.at(-1)!.time+600000)return null;return frames.filter(f=>f.time<=at).at(-1)||null;}
