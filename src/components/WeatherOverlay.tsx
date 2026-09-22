'use client';
import {useEffect,useMemo,useState,type RefObject} from 'react';
import type {Map} from 'maplibre-gl';
import {getMaxParallelImageRequests,setMaxParallelImageRequests} from 'maplibre-gl';
import {useLocale} from '@/lib/i18n';
import type {WorldRecord} from '@/lib/world/types';
import type {WeatherResult} from '@/lib/world/weather-types';
import {scalarFeatures,windFeatures,selectedWeatherField,FIELD_COLORS} from '@/lib/world/weather-field';
import {bindWeather,removeWeather} from '@/lib/world/weather-renderer';
const EMPTY:GeoJSON.FeatureCollection={type:'FeatureCollection',features:[]};
interface Props {mapRef:RefObject<Map|null>;ready:boolean;bbox:string;zoom:number;enabled:boolean;layers:Record<string,boolean>;replayAt:number|null;onSelect:(r:WorldRecord)=>void}
export default function WeatherOverlay({mapRef,ready,bbox,zoom,enabled,layers,replayAt,onSelect}:Props){
 const {t}=useLocale(),[result,setResult]=useState<WeatherResult|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[renderError,setRenderError]=useState<string|null>(null);
 const live=enabled&&replayAt===null,level=Math.floor(zoom);
 useEffect(()=>{if(!enabled)return;const previous=getMaxParallelImageRequests();setMaxParallelImageRequests(Math.min(4,previous));return()=>setMaxParallelImageRequests(previous);},[enabled]);
 useEffect(()=>{
  if(!live||!bbox)return;
  const c=new AbortController();let retry:ReturnType<typeof setTimeout>|undefined;
  const low=window.innerWidth<700||navigator.hardwareConcurrency<=4;
  const load=async()=>{
   if(c.signal.aborted)return;
   // Restoring a saved view animates through intermediate world/regional bounds.
   // Wait for the settled viewport instead of consuming batches that will be discarded.
   if(mapRef.current?.isMoving()){clearTimeout(retry);retry=setTimeout(()=>void load(),1000);return;}
   setLoading(true);
   try{
    const response=await fetch(`/api/world/weather?bbox=${bbox}&zoom=${level}&quality=${low?'low':'standard'}`,{priority:'high',signal:AbortSignal.any([c.signal,AbortSignal.timeout(45000)])});const body=await response.json();if(c.signal.aborted)return;
    if(!body.diagnostics){setResult(null);throw new Error(body.error||`HTTP_${response.status}`);}
    setResult(body);setError(body.diagnostics.error||null);
    if(body.diagnostics.retry_after_seconds>0){clearTimeout(retry);retry=setTimeout(()=>void load(),Math.max(5000,Math.min(3600000,body.diagnostics.retry_after_seconds*1000+500)));}
   }catch(e){if(!c.signal.aborted){setResult(null);setError(e instanceof Error?e.message:'NETWORK_ERROR');}}
   finally{if(!c.signal.aborted)setLoading(false);}
  };
  const delay=setTimeout(()=>void load(),900),poll=setInterval(()=>void load(),120000);
  return()=>{c.abort();clearTimeout(delay);clearTimeout(retry);clearInterval(poll);};
 },[live,bbox,level,mapRef]);
 const field=selectedWeatherField(layers),windEnabled=live&&!!layers.wx_wind;
 const drawing=useMemo(()=>({field:live?field:null,scalar:live&&field&&result?scalarFeatures(result.records,result.grid,field.property):EMPTY,wind:windEnabled&&result?windFeatures(result.records,level):EMPTY,windEnabled}),[live,field,result,windEnabled,level]);
 useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;return bindWeather(map,drawing,id=>{const r=result?.records.find(r=>r.id===id);if(r)onSelect(r);},setRenderError);},[ready,mapRef,drawing,result,onSelect]);
 useEffect(()=>{const map=mapRef.current;return()=>{if(map)removeWeather(map);};},[mapRef]);
 if(!enabled)return null;
 const d=result?.diagnostics,values=field?result?.records.map(r=>r.properties[field.property]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v))||[]:[];
 return <section aria-label={t('Weather diagnostics')} className="my-2 border-t border-slate-600 pt-2" data-weather-status={replayAt!==null?'REPLAY_HIDDEN':d?.status||'UNKNOWN'} data-weather-samples={result?.records.length||0}>
  <p><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · {replayAt!==null?t('REPLAY: current weather hidden'):loading?t('Loading weather…'):d?.status||'UNKNOWN'}</p>
  {replayAt===null&&<><p>{d?.normalized??0}/{d?.requested??0} {t('model samples')} · {t('Received records')}: {d?.received??0} · {t('Cache')}: {d?.cache||'UNKNOWN'} · {d?.mode||'free'}</p>
  {d?.data_at&&<p>{t('Model time')}: {new Date(d.data_at).toUTCString()}</p>}
  {d?.fetched_at&&<p>{t('Fetched:')} {new Date(d.fetched_at).toUTCString()}</p>}
  {error&&<p role="status" className="text-orange-300">{error}{d?.retry_after_seconds?` · ${t('Retry in')} ${d.retry_after_seconds}s`:''}</p>}
  {renderError&&<p role="alert" className="text-orange-300">{t('Weather rendering failed')}: {renderError}</p>}
  {field&&<><p>{t(field.label)} · {field.unit}</p><div className="h-2 my-1 rounded" style={{background:`linear-gradient(to right,${FIELD_COLORS.join(',')})`}}/><p className="flex justify-between"><span>{field.min}</span><span>{field.max} {field.unit}</span></p><p>{t('Rendered cells')}: {drawing.scalar.features.length} · {t('Sample range')}: {values.length?`${Math.min(...values).toFixed(1)} – ${Math.max(...values).toFixed(1)} ${field.unit}`:t('Not available')}</p></>}
  {windEnabled&&<p>{t('Wind 10m · m/s')} · {drawing.wind.features.length} {t('arrows')}<br/>{t('Arrows point downwind; circles indicate calm. Gusts in details.')}</p>}
  {result&&<p>{t('Source sampling grid')}: {result.grid.columns}×{result.grid.rows} · Δ {result.grid.spacing_degrees.map(n=>n.toFixed(3)).join('° / ')}°</p>}
  <p className="text-slate-400">{t('Interpolated model field, not measured resolution. Native model resolution varies; no extra observations are created.')}</p>
  {!!result?.records.length&&<details><summary>{t('Weather sample details')}</summary>{result.records.slice(0,5).map(r=><button key={r.id} className="block underline py-1 text-left" onClick={()=>onSelect(r)}>{r.lat?.toFixed(3)}, {r.lon?.toFixed(3)} · {String(r.properties.temperature_c??'?')} °C · {String(r.properties.wind_speed_ms??'?')} m/s</button>)}</details>}
  </>}
 </section>;
}
