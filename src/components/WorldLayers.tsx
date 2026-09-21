'use client';
import {useEffect,useState,useMemo,type RefObject} from 'react';
import type {Map,GeoJSONSource,MapLayerMouseEvent,RasterTileSource} from 'maplibre-gl';
import {conflictLayer,worldSeed,type WorldRecord,type ProviderResult,type Bounds} from '@/lib/world/types';
import {mapFeatures,geometryFeatures,windFeatures,WEATHER_FIELDS,radarFrameAt,type RadarFrame} from '@/lib/world/map';
import type {InvestigationSeed} from '@/lib/ontology';
import type {InvestigationIntent} from '@/lib/investigation';
import InvestigationActions from './InvestigationActions';
interface Props {mapRef:RefObject<Map|null>;ready:boolean;layers:Record<string,boolean>;replayAt:number|null;onInvestigate:(seed:InvestigationSeed,intent:InvestigationIntent)=>void}
interface Result extends ProviderResult {providers?:{provider:string;status:string;count:number;future_records_omitted?:number}[]}
const EMPTY:WorldRecord[]=[];
export default function WorldLayers({mapRef,ready,layers,replayAt,onInvestigate}:Props){
 const [viewport,setViewport]=useState<{b:Bounds;zoom:number}|null>(null),[infra,setInfra]=useState<Result>(),[wx,setWx]=useState<Result>(),[reports,setReports]=useState<Result>(),[frames,setFrames]=useState<RadarFrame[]>([]),[selected,setSelected]=useState<WorldRecord|null>(null),[errors,setErrors]=useState<Record<string,string>>({}),[providers,setProviders]=useState<{id:string;status:string;message?:string}[]>([]),[expanded,setExpanded]=useState(false);
 const infraKey=Object.keys(layers).filter(k=>k.startsWith('infra_')&&layers[k]).map(k=>k.slice(6)).sort().join(','),wxEnabled=Object.keys(layers).some(k=>k.startsWith('wx_')&&k!=='wx_radar'&&layers[k]),conflictEnabled=Object.keys(layers).some(k=>k.startsWith('conflict_')&&layers[k]),radarEnabled=!!layers.wx_radar;
 const active=!!infraKey||wxEnabled||conflictEnabled||radarEnabled;
 useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;const update=()=>{const b=map.getBounds();const west=Math.max(-180,b.getWest()),east=Math.min(180,b.getEast()),south=Math.max(-85,b.getSouth()),north=Math.min(85,b.getNorth());setViewport({b:[west,south,east,north],zoom:map.getZoom()});};update();map.on('moveend',update);return()=>{map.off('moveend',update);};},[ready,mapRef]);
 const bbox=viewport?.b.map(n=>n.toFixed(3)).join(',')||'';
 useEffect(()=>{
  if(!active)return;const c=new AbortController();void fetch('/api/world/providers',{signal:c.signal}).then(r=>r.json()).then(r=>setProviders(r.providers||[])).catch(()=>{});return()=>c.abort();
 },[active]);
 useEffect(()=>{
  if(!bbox||!active)return;const c=new AbortController(),retries:ReturnType<typeof setTimeout>[]=[];
  const load=async(kind:string,q:string,save:(r:Result)=>void,retried=false)=>{try{const r=await fetch(`/api/world/${kind}?${q}`,{signal:c.signal});const body=await r.json();if(!r.ok){if(r.status===429&&!retried&&!c.signal.aborted)retries.push(setTimeout(()=>void load(kind,q,save,true),30000));throw new Error(body.error==='PROVIDER_BACKOFF'?'Provider cooling down; retrying automatically':body.error||'Unavailable');}if(!c.signal.aborted){save(body);setErrors(e=>({...e,[kind]:body.truncated?'Partial coverage: result limit reached':''}));}}catch(e){if(!c.signal.aborted){save({records:[],status:'UNAVAILABLE'});setErrors(v=>({...v,[kind]:e instanceof Error?e.message:'Unavailable'}));}}};
  const tick=()=>{if(replayAt!==null)return;if(infraKey)void load('infrastructure',`bbox=${bbox}&categories=${infraKey}`,setInfra);if(wxEnabled)void load('weather',`bbox=${bbox}`,setWx);if(conflictEnabled)void load('conflicts',`bbox=${bbox}`,setReports);};
  const delay=setTimeout(tick,800),timer=setInterval(tick,120000);return()=>{clearTimeout(delay);clearInterval(timer);retries.forEach(clearTimeout);c.abort();};
 },[bbox,infraKey,wxEnabled,conflictEnabled,active,replayAt]);
 useEffect(()=>{if(!radarEnabled)return;const c=new AbortController();const load=()=>void fetch('/api/world/radar',{signal:c.signal}).then(r=>r.json()).then(r=>{if(!c.signal.aborted){setFrames(r.frames||[]);setErrors(e=>({...e,radar:r.error||''}));}}).catch(()=>{});load();const t=setInterval(load,120000);return()=>{clearInterval(t);c.abort();};},[radarEnabled]);
 const objects=useMemo(()=>replayAt!==null?EMPTY:[...(infraKey?infra?.records||[]:[]),...(conflictEnabled?reports?.records.filter(r=>layers[conflictLayer(r.subtype)])||[]:[])],[infra,infraKey,reports,conflictEnabled,layers,replayAt]);
 const weather=useMemo(()=>wxEnabled&&replayAt===null?wx?.records||EMPTY:EMPTY,[wx,wxEnabled,replayAt]);
 const fieldKey=Object.keys(WEATHER_FIELDS).find(k=>layers[k]) as keyof typeof WEATHER_FIELDS|undefined,field=fieldKey?WEATHER_FIELDS[fieldKey]:null;
 const frame=radarEnabled?radarFrameAt(frames,replayAt??frames.at(-1)?.time??0):null;
 useEffect(()=>{
  const map=mapRef.current;if(!ready||!map)return;
  for(const id of ['world-assets','world-geometry','world-weather','world-wind'])if(!map.getSource(id))map.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features:[]},...(id==='world-assets'?{cluster:true,clusterMaxZoom:8,clusterRadius:40}:{})});
  if(!map.getLayer('world-geometry'))map.addLayer({id:'world-geometry',type:'line',source:'world-geometry',paint:{'line-color':'#d4af37','line-width':2,'line-opacity':.65}});
  if(!map.getLayer('world-clusters')){map.addLayer({id:'world-clusters',type:'circle',source:'world-assets',filter:['has','point_count'],paint:{'circle-color':'#b69a48','circle-radius':15}});map.addLayer({id:'world-cluster-labels',type:'symbol',source:'world-assets',filter:['has','point_count'],layout:{'text-field':['get','point_count_abbreviated'],'text-font':['Noto Sans Regular'],'text-size':11}});}
  if(!map.getLayer('world-assets'))map.addLayer({id:'world-assets',type:'circle',source:'world-assets',filter:['!',['has','point_count']],paint:{'circle-color':['get','color'],'circle-radius':6,'circle-stroke-color':'#fff','circle-stroke-width':1}});
  if(!map.getLayer('world-weather'))map.addLayer({id:'world-weather',type:'circle',source:'world-weather',paint:{'circle-color':'#7dd3fc','circle-radius':18,'circle-opacity':.35}});
  if(!map.getLayer('world-wind')){map.addLayer({id:'world-wind',type:'line',source:'world-wind',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':'#a5f3fc','line-width':2}});map.addLayer({id:'world-wind-labels',type:'symbol',source:'world-wind',filter:['==',['geometry-type'],'Point'],layout:{'text-field':['get','label'],'text-font':['Noto Sans Regular'],'text-size':12,'text-rotate':['get','bearing'],'text-rotation-alignment':'map'},paint:{'text-color':'#a5f3fc'}});}
  (map.getSource('world-assets') as GeoJSONSource).setData(mapFeatures(objects));(map.getSource('world-geometry') as GeoJSONSource).setData(geometryFeatures(objects));(map.getSource('world-weather') as GeoJSONSource).setData(mapFeatures(weather));(map.getSource('world-wind') as GeoJSONSource).setData(windFeatures(layers.wx_wind?weather:EMPTY));
  map.getContainer().dataset.worldAssetPoints=String(mapFeatures(objects).features.length);map.getContainer().dataset.worldWeatherPoints=String(weather.length);
  if(field){map.setPaintProperty('world-weather','circle-color',['interpolate',['linear'],['coalesce',['get',field.property],field.min],field.min,'#60a5fa',field.max,'#f97316']);}
  const click=(e:MapLayerMouseEvent)=>{const id=e.features?.[0]?.properties?.id;const r=[...objects,...weather].find(r=>r.id===id);if(r)setSelected(r);};
  for(const id of ['world-assets','world-geometry','world-weather'])map.on('click',id,click);
  return()=>{for(const id of ['world-assets','world-geometry','world-weather'])map.off('click',id,click);};
 },[ready,mapRef,objects,weather,layers.wx_wind,field]);
 useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;if(!frame){if(map.getLayer('world-radar'))map.removeLayer('world-radar');if(map.getSource('world-radar'))map.removeSource('world-radar');return;}
  const tiles=[`${window.location.origin}/api/world-radar/${frame.time}/{z}/{x}/{y}`];
  if(map.getSource('world-radar'))(map.getSource('world-radar') as RasterTileSource).setTiles(tiles);else {map.addSource('world-radar',{type:'raster',tiles,tileSize:256,maxzoom:7,attribution:'<a href="https://www.rainviewer.com/">RainViewer</a>'});map.addLayer({id:'world-radar',type:'raster',source:'world-radar',paint:{'raster-opacity':.55,'raster-fade-duration':0}},map.getLayer('world-assets')?'world-assets':undefined);}
 },[ready,mapRef,frame]);
 if(!active&&!selected)return null;
 return <aside aria-label="World data layers" className="absolute left-16 bottom-28 z-[230] w-72 max-w-[calc(100vw-120px)] max-h-[55vh] overflow-auto rounded border border-amber-300/30 bg-slate-950/95 p-3 text-[11px] font-mono text-slate-200 shadow-xl">
  <button className="text-amber-300 tracking-widest w-full text-left" onClick={()=>setExpanded(v=>!v)}>WORLD DATA {expanded?'−':'+'}</button>
  {replayAt!==null&&<p className="my-2 text-cyan-300">REPLAY · retained observations only; current model grid hidden.</p>}
  {infraKey&&<p>Infrastructure: {replayAt===null?infra?.records.length||0:'retained'} · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OSM contributors</a></p>}
  {wxEnabled&&<><p><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · DERIVED · model samples</p>{field&&<p>{field.label}: <span className="text-blue-300">{field.min}</span> → <span className="text-orange-300">{field.max} {field.unit}</span></p>}{layers.wx_wind&&<p>Arrows: wind toward · m/s; gusts in details</p>}</>}
  {radarEnabled&&<p className="my-2"><a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a> · {frame?new Date(frame.time).toUTCString():'Radar imagery unavailable for selected replay time'} · Blue: weak → intense reflectivity (dBZ), not ground rain measurement</p>}
  {Object.entries(errors).filter(([k,v])=>v&&(k==='infrastructure'?infraKey:k==='weather'?wxEnabled:k==='radar'?radarEnabled:conflictEnabled)).map(([k,v])=><p key={k} className="text-orange-300">{k}: {v}</p>)}
  {expanded&&<div className="border-t border-slate-700 mt-2 pt-2">{providers.map(p=><p key={p.id} title={p.message}>{p.id}: {p.status}</p>)}{reports?.providers?.map(p=><p key={p.provider}>{p.provider}: {p.status} · {p.count}{!!p.future_records_omitted && ` · ${p.future_records_omitted} future timestamps omitted`}</p>)}{replayAt===null&&[...objects.slice(0,6),...weather.slice(0,2),...(conflictEnabled?reports?.records.filter(r=>r.lat===null).slice(0,4)||[]:[])].map(r=><button key={r.id} className="block text-left py-1 underline" onClick={()=>{setSelected(r);if(r.lat!==null&&r.lon!==null)mapRef.current?.flyTo({center:[r.lon,r.lat],zoom:Math.max(8,mapRef.current.getZoom())});}}>{r.name}{r.lat===null?' · no source coordinates':''}</button>)}</div>}
  {selected&&<div className="mt-3 border-t border-slate-600 pt-2"><button className="float-right p-1" aria-label="Close world object" onClick={()=>setSelected(null)}>×</button><strong>{selected.name}</strong><p className="text-amber-200">{selected.domain==='conflict'?'REPORTED SIGNAL · not confirmed causation':selected.evidence_state}</p><p>{selected.provider} · {selected.location_precision}</p><p>Source time: {selected.observed_at||'Not provided'}</p><p>Fetched: {selected.fetched_at}</p><p>Confidence: {selected.confidence??'Not provided'}</p><p>{selected.extraction_method}</p><p>{selected.geometry_precision==='representative'?'Representative location; no exact proximity claim':''}</p><a className="underline" href={selected.url} target="_blank" rel="noreferrer">Source record</a><dl className="my-2">{Object.entries(selected.properties).filter(([,v])=>v!==null&&typeof v!=='object').slice(0,20).map(([k,v])=><div key={k}>{k}: {String(v).slice(0,150)}</div>)}</dl><InvestigationActions entity={{}} seed={worldSeed(selected)} onInvestigate={onInvestigate}/></div>}
 </aside>;
}
