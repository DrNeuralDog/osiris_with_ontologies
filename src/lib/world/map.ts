import type {WorldRecord} from './types';
import {reportSymbol} from '@/lib/air-threat/symbols';
export {WEATHER_FIELDS,windFeatures} from './weather-field';
export function mapFeatures(records:WorldRecord[]):GeoJSON.FeatureCollection {
 return {type:'FeatureCollection',features:records.filter(r=>r.lat!==null&&r.lon!==null).slice(0,1200).map(r=>({type:'Feature',id:r.id,geometry:{type:'Point',coordinates:[r.lon!,r.lat!]},properties:{...r.properties,id:r.id,label:r.name,color:r.domain==='infrastructure'?'#d4af37':r.domain==='conflict'?(r.properties.source_class==='OFFICIAL'?'#fbbf24':r.subtype.startsWith('HEARD_')?'#67e8f9':r.subtype==='ALL_CLEAR'?'#34d399':'#fb7185'):'#7dd3fc',domain:r.domain,icon:`report-${reportSymbol(r.subtype)}`,acoustic:r.subtype.startsWith('HEARD_'),opacity:r.domain==='conflict'&&r.observed_at?Math.max(.35,1-Math.max(0,Date.now()-Date.parse(r.observed_at))/21600000):1}}))};
}
export function geometryFeatures(records:WorldRecord[]):GeoJSON.FeatureCollection{return {type:'FeatureCollection',features:records.filter(r=>r.geometry).slice(0,500).map(r=>({type:'Feature',geometry:r.geometry!,properties:{id:r.id}}))};}
export interface RadarFrame {time:number;path:string}
export function radarFrameAt(frames:RadarFrame[],at:number){if(!frames.length||at<frames[0].time||at>frames.at(-1)!.time+600000)return null;return frames.filter(f=>f.time<=at).at(-1)||null;}
