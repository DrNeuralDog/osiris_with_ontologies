'use client';
import {useEffect,type RefObject} from 'react';
import type {Map,GeoJSONSource,MapLayerMouseEvent} from 'maplibre-gl';
import {replayFeatures,type ReplayItem} from '@/lib/replay';
export function useReplayMap(mapRef:RefObject<Map|null>,ready:boolean,items:ReplayItem[]|null,onSelect?: (item:ReplayItem)=>void){
 useEffect(()=>{
  const map=mapRef.current;if(!ready||!map)return;
  if(!map.getSource('world-replay')){
   map.addSource('world-replay',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
   map.addLayer({id:'world-replay-dots',type:'circle',source:'world-replay',paint:{'circle-radius':7,'circle-color':['get','color'],'circle-opacity':0.8,'circle-stroke-color':'#e0f2fe','circle-stroke-width':1.5}});
   map.addLayer({id:'world-replay-labels',type:'symbol',source:'world-replay',minzoom:5,layout:{'text-field':['get','label'],'text-font':['Noto Sans Regular'],'text-size':10,'text-offset':[0,1.8]},paint:{'text-color':'#cffafe','text-halo-color':'#111827','text-halo-width':1.5}});
  }
  (map.getSource('world-replay') as GeoJSONSource).setData(replayFeatures(items||[]));
  map.getContainer().dataset.worldMode=items?'replay':'live';
  map.getContainer().dataset.historicalPoints=String(replayFeatures(items||[]).features.length);
  const click=(e:MapLayerMouseEvent)=>{const item=items?.find(i=>i.id===e.features?.[0]?.properties?.id);if(item)onSelect?.(item);};
  map.on('click','world-replay-dots',click);return()=>{map.off('click','world-replay-dots',click);};
 },[mapRef,ready,items,onSelect]);
}
