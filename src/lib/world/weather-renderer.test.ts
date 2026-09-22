import {it,expect,vi} from 'vitest';
import type {Map} from 'maplibre-gl';
import {bindWeather,removeWeather,type WeatherDrawing} from './weather-renderer';
import {WEATHER_FIELDS} from './weather-field';
function mockMap(){
 const sources=new globalThis.Map(),layers=new globalThis.Map(),images=new Set(),handlers=new globalThis.Map(),dataset:Record<string,string>={};
 const map={getStyle:()=>({}),getSource:(id:string)=>sources.get(id),addSource:(id:string)=>sources.set(id,{setData:vi.fn()}),getLayer:(id:string)=>layers.get(id),addLayer:(layer:{id:string})=>layers.set(layer.id,layer),hasImage:(id:string)=>images.has(id),addImage:(id:string)=>images.add(id),setLayoutProperty:vi.fn(),setPaintProperty:vi.fn(),getContainer:()=>({dataset}),on:vi.fn((event:string,...args:unknown[])=>handlers.set(event,args.at(-1))),off:vi.fn((event:string)=>handlers.delete(event)),removeLayer:(id:string)=>layers.delete(id),removeSource:(id:string)=>sources.delete(id),removeImage:(id:string)=>images.delete(id)};
 return {map:map as unknown as Map,sources,layers,images,handlers,dataset,layout:map.setLayoutProperty};
}
const empty:GeoJSON.FeatureCollection={type:'FeatureCollection',features:[]};
it('reattaches fields and sprites after style.load and removes listeners on disposal',()=>{
 const m=mockMap(),draw=vi.fn(),d:WeatherDrawing={field:WEATHER_FIELDS.wx_temperature,scalar:empty,wind:empty,windEnabled:true};
 const off=bindWeather(m.map,d,vi.fn(),draw);expect(m.layers.size).toBe(3);
 m.sources.clear();m.layers.clear();m.images.clear();m.handlers.get('style.load')();expect(m.layers.size).toBe(3);expect(m.images.has('weather-wind-arrow')).toBe(true);expect(draw).toHaveBeenLastCalledWith(null);
 off();expect(m.handlers.has('style.load')).toBe(false);removeWeather(m.map);expect(m.sources.size).toBe(0);
});
it('scalar and wind visibility is explicit; switching replaces the field',()=>{
 const m=mockMap();bindWeather(m.map,{field:WEATHER_FIELDS.wx_cloud,scalar:empty,wind:empty,windEnabled:false},vi.fn(),vi.fn())();
 expect(m.dataset.weatherField).toBe('cloud_percent');expect(m.layout).toHaveBeenCalledWith('world-weather-wind','visibility','none');
 bindWeather(m.map,{field:WEATHER_FIELDS.wx_pressure,scalar:empty,wind:empty,windEnabled:true},vi.fn(),vi.fn())();expect(m.dataset.weatherField).toBe('pressure_hpa');
 bindWeather(m.map,{field:null,scalar:empty,wind:empty,windEnabled:false},vi.fn(),vi.fn())();expect(m.layout).toHaveBeenCalledWith('world-weather-field','visibility','none');expect(m.dataset.weatherField).toBe('none');
});
it('render errors reach the UI diagnostic callback',()=>{
 const m=mockMap(),error=vi.fn();m.map.addSource=()=>{throw new Error('STYLE_NOT_READY');};
 bindWeather(m.map,{field:null,scalar:empty,wind:empty,windEnabled:false},vi.fn(),error)();expect(error).toHaveBeenCalledWith('STYLE_NOT_READY');
});
