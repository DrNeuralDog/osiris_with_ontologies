import type {WorldRecord} from './types';
import type {WeatherGrid} from './weather-grid';
import {mercatorY,inverseMercatorY} from './weather-grid';
export const WEATHER_FIELDS={
 wx_temperature:{property:'temperature_c',label:'Temperature',unit:'°C',min:-20,max:45},
 wx_pressure:{property:'pressure_hpa',label:'Sea-level pressure',unit:'hPa',min:980,max:1040},
 wx_precipitation:{property:'precipitation_mm',label:'Precipitation / model interval',unit:'mm',min:0,max:10},
 wx_cloud:{property:'cloud_percent',label:'Cloud cover',unit:'%',min:0,max:100},
 wx_visibility:{property:'visibility_m',label:'Visibility',unit:'m',min:0,max:50000},
};
export type WeatherField=typeof WEATHER_FIELDS[keyof typeof WEATHER_FIELDS];
export const FIELD_COLORS=['#334e9b','#269cbe','#72c9a2','#efcb60','#ed7045'] as const;
export function selectedWeatherField(layers:Record<string,boolean>):WeatherField|null {const k=(Object.keys(WEATHER_FIELDS) as (keyof typeof WEATHER_FIELDS)[]).find(k=>layers[k]);return k?WEATHER_FIELDS[k]:null;}
/** Fixed visual pixels, never interpreted as a displacement or forecast trajectory. */
export function windPixelSize(speed:number,zoom:number){return Math.max(18,Math.min(42,20+Math.min(20,Math.max(0,speed))*.65+Math.min(12,Math.max(0,zoom))*.6));}
export function windFeatures(records:WorldRecord[],zoom=5):GeoJSON.FeatureCollection {
 return {type:'FeatureCollection',features:records.slice(0,81).flatMap(r=>{
  const speed=r.properties.wind_speed_ms,from=r.properties.wind_from_deg;
  if(r.lat===null||r.lon===null||typeof speed!=='number'||!Number.isFinite(speed)||speed<0||typeof from!=='number'||!Number.isFinite(from))return [];
  return [{type:'Feature',geometry:{type:'Point',coordinates:[r.lon,r.lat]},properties:{id:r.id,bearing:((from+180)%360+360)%360,size:windPixelSize(speed,zoom)/48,speed,calm:speed<.1,label:`${speed.toFixed(1)} m/s`,gust:r.properties.wind_gust_ms}}];
 })};
}
/** Display-only bilinear interpolation. Missing corners remain holes, not invented zeroes.
 * Grid sampling is geographic; rendered cells are spaced in Mercator for an even visual field.
 * No rendered cells are persisted or supplied to intelligence/correlation rules.
 */
export function scalarFeatures(records:WorldRecord[],grid:WeatherGrid,property:string):GeoJSON.FeatureCollection {
 const features:GeoJSON.Feature[]=[],lookup=new Map(records.map(r=>[r.id,r]));
 const samples=grid.points.map(p=>lookup.get(`open-meteo:${p.join(',')}`)),b=grid.bounds;
 const width=64,height=48,ys=Array.from({length:height+1},(_,i)=>inverseMercatorY(mercatorY(b[1])+(mercatorY(b[3])-mercatorY(b[1]))*i/height));
 if(grid.columns<2||grid.rows<2||grid.points.length>81)return {type:'FeatureCollection',features};
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const west=b[0]+(b[2]-b[0])*x/width,east=b[0]+(b[2]-b[0])*(x+1)/width,lat=(ys[y]+ys[y+1])/2;
  const gx=(x+.5)/width*(grid.columns-1),gy=(lat-b[1])/(b[3]-b[1])*(grid.rows-1),ix=Math.min(grid.columns-2,Math.floor(gx)),iy=Math.min(grid.rows-2,Math.floor(gy)),tx=gx-ix,ty=gy-iy;
  const corners=[samples[iy*grid.columns+ix],samples[iy*grid.columns+ix+1],samples[(iy+1)*grid.columns+ix],samples[(iy+1)*grid.columns+ix+1]],v=corners.map(r=>r?.properties[property]);
  if(!v.every(n=>typeof n==='number'&&Number.isFinite(n)))continue;
  const n=v as number[],value=n[0]*(1-tx)*(1-ty)+n[1]*tx*(1-ty)+n[2]*(1-tx)*ty+n[3]*tx*ty;
  const nearest=corners[(ty>=.5?2:0)+(tx>=.5?1:0)];
  features.push({type:'Feature',geometry:{type:'Polygon',coordinates:[[[west,ys[y]],[east,ys[y]],[east,ys[y+1]],[west,ys[y+1]],[west,ys[y]]]]},properties:{id:nearest?.id,value,interpolated:true}});
 }
 return {type:'FeatureCollection',features};
}
