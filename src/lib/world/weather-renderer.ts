import type {Map,GeoJSONSource,MapLayerMouseEvent} from 'maplibre-gl';
import {FIELD_COLORS,type WeatherField} from './weather-field';
export interface WeatherDrawing {field:WeatherField|null;scalar:GeoJSON.FeatureCollection;wind:GeoJSON.FeatureCollection;windEnabled:boolean}
const ids=['world-weather-field','world-weather-wind','world-weather-calm'];
const sourceIds=['world-weather-field','world-weather-wind'];
/** Raster sprite only sets screen dimensions; geography stays at the model sample. */
function arrowImage(){
 const width=48,height=48,data=new Uint8Array(width*height*4);
 for(let y=3;y<45;y++)for(let x=2;x<46;x++){
  const shaft=Math.abs(x-24)<=3&&y>=6,head=y>=5&&y<=21&&Math.abs(Math.abs(x-24)-(y-5))<=3;
  if(!shaft&&!head)continue;const i=(y*width+x)*4,edge=shaft?Math.abs(x-24)>1:Math.abs(Math.abs(x-24)-(y-5))>1;
  data.set(edge?[12,27,44,255]:[200,250,255,255],i);
 }
 return {width,height,data};
}
export function drawWeather(map:Map,d:WeatherDrawing){
 if(!map.getStyle())return;
 for(const id of sourceIds)if(!map.getSource(id))map.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
 const before=map.getLayer('world-assets')?'world-assets':undefined;
 if(!map.getLayer(ids[0]))map.addLayer({id:ids[0],type:'fill',source:sourceIds[0],paint:{'fill-opacity':.47,'fill-antialias':false}},before);
 if(!map.hasImage('weather-wind-arrow'))map.addImage('weather-wind-arrow',arrowImage());
 if(!map.getLayer(ids[1]))map.addLayer({id:ids[1],type:'symbol',source:sourceIds[1],filter:['==',['get','calm'],false],layout:{'icon-image':'weather-wind-arrow','icon-size':['get','size'],'icon-rotate':['get','bearing'],'icon-rotation-alignment':'map','icon-pitch-alignment':'viewport','icon-allow-overlap':true,'icon-ignore-placement':true}},before);
 if(!map.getLayer(ids[2]))map.addLayer({id:ids[2],type:'circle',source:sourceIds[1],filter:['==',['get','calm'],true],paint:{'circle-radius':4,'circle-color':'#d1faff','circle-stroke-color':'#122030','circle-stroke-width':2}},before);
 (map.getSource(sourceIds[0]) as GeoJSONSource).setData(d.scalar);
 (map.getSource(sourceIds[1]) as GeoJSONSource).setData(d.wind);
 map.setLayoutProperty(ids[0],'visibility',d.field?'visible':'none');
 for(const id of ids.slice(1))map.setLayoutProperty(id,'visibility',d.windEnabled?'visible':'none');
 if(d.field){const f=d.field;map.setPaintProperty(ids[0],'fill-color',['interpolate',['linear'],['get','value'],...FIELD_COLORS.flatMap((color,i)=>[f.min+(f.max-f.min)*i/4,color])]);}
 const dataset=map.getContainer().dataset;
 dataset.weatherField=d.field?.property||'none';dataset.weatherFieldCells=String(d.field?d.scalar.features.length:0);dataset.weatherWindArrows=String(d.windEnabled?d.wind.features.length:0);
}
/** Replays the same cached drawing after style replacement, without a new network request. */
export function bindWeather(map:Map,d:WeatherDrawing,onSelect:(id:string)=>void,onDraw:(error:string|null)=>void){
 const draw=()=>{try{drawWeather(map,d);onDraw(null);}catch(e){onDraw(e instanceof Error?e.message:'WEATHER_RENDER_ERROR');}};
 const click=(e:MapLayerMouseEvent)=>{const id=e.features?.[0]?.properties?.id;if(typeof id==='string')onSelect(id);};
 map.on('style.load',draw);for(const id of ids)map.on('click',id,click);draw();
 return()=>{map.off('style.load',draw);for(const id of ids)map.off('click',id,click);};
}
export function removeWeather(map:Map){if(!map.getStyle())return;for(const id of ids)if(map.getLayer(id))map.removeLayer(id);for(const id of sourceIds)if(map.getSource(id))map.removeSource(id);if(map.hasImage('weather-wind-arrow'))map.removeImage('weather-wind-arrow');const d=map.getContainer().dataset;d.weatherField='none';d.weatherFieldCells='0';d.weatherWindArrows='0';}
