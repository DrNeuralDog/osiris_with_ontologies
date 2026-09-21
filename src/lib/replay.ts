import type { Observation, Correlation, InvestigationMapFocus } from './intelligence';
export const REPLAY_DOMAINS=['aircraft','vessel','satellite','fire','earthquake','weather','news','cyber','infrastructure','correlations','conflict'] as const;
export type ReplayDomain=typeof REPLAY_DOMAINS[number];
export type ReplayBounds=[number,number,number,number];
export interface ReplayRange {from:number;to:number}
export interface ReplayState extends ReplayRange {mode:'live'|'replay';at:number;playing:boolean;speed:number;open:boolean}
export interface ReplayItem {id:string;object_id?:string;correlation_id?:string;name:string;domain:ReplayDomain;from:string;to:string;lat:number|null;lon:number|null;freshness?:string;status?:string;observation?:Observation;correlation?:Correlation & {evidence_available:boolean}}
export interface ReplayBucket {index:number;at:string;count:number;lat:number;lon:number;name:string;object_id:string;domains:Record<string,number>}
export interface ReplayCoverage {earliest:string|null;latest:string|null;buckets:ReplayBucket[];truncated:boolean;domains:ReplayDomain[];retention:{telemetry_days:number;events_days:number}}
export interface ReplayChunk {items:ReplayItem[];from:string;to:string;truncated:boolean;policies:Record<string,{live:number;fresh:number;historical:number}>}
export const REPLAY_SPEEDS=[1,5,20,60];
export const initialReplay=(now:number):ReplayState=>({mode:'live',at:now,from:now-21600000,to:now,playing:false,speed:1,open:false});
export function sliderTime(value:number,range:ReplayRange){return Math.round(range.from+(range.to-range.from)*Math.min(1000,Math.max(0,value))/1000);}
export function sliderValue(at:number,range:ReplayRange){return Math.max(0,Math.min(1000,1000*(at-range.from)/Math.max(1,range.to-range.from)));}
export function advanceReplay(s:ReplayState,elapsedMs:number):ReplayState {if(s.mode==='live'||!s.playing)return s;const at=Math.min(s.to,s.at+Math.max(0,elapsedMs)*s.speed);return {...s,at,playing:at<s.to};}
export function jumpReplay(s:ReplayState,at:number):ReplayState {const inside=at>=s.from&&at<=s.to;return {...s,mode:'replay',open:true,playing:false,at,from:inside?s.from:at-10800000,to:inside?s.to:Math.min(Date.now(),at+10800000)};}
export const returnLive=(s:ReplayState):ReplayState=>({...s,mode:'live',playing:false});
export function replayURL(input:string,s:ReplayState){const u=new URL(input);for(const k of ['replay','replayFrom','replayTo'])u.searchParams.delete(k);if(s.mode==='replay'){u.searchParams.set('replay',new Date(s.at).toISOString());u.searchParams.set('replayFrom',new Date(s.from).toISOString());u.searchParams.set('replayTo',new Date(s.to).toISOString());}return u.pathname+u.search+u.hash;}
export function parseReplayURL(input:string,now:number){const u=new URL(input),s=initialReplay(now),at=Date.parse(u.searchParams.get('replay')||'');if(!Number.isFinite(at)||at>now)return s;const from=Date.parse(u.searchParams.get('replayFrom')||'')||at-21600000,to=Date.parse(u.searchParams.get('replayTo')||'')||Math.min(now,at+3600000);if(from>at||to<at||to>now+60000||to-from>31*86400000)return s;return {...s,mode:'replay' as const,open:true,at,from,to};}
export function replayItemsAt(chunk:ReplayChunk|undefined,at:number){return (chunk?.items||[]).filter(i=>Date.parse(i.from)<=at&&Date.parse(i.to)>at).map(i=>({...i,freshness:replayFreshness(i,at,chunk?.policies||{})}));}
export function replayFreshness(item:ReplayItem,at:number,policies:ReplayChunk['policies']){const time=item.observation?.observed_at;if(!time)return 'UNKNOWN';const category=item.domain==='vessel'?'maritime':item.domain==='infrastructure'?'static':item.domain,p=policies[category];if(!p)return 'UNKNOWN';const age=(at-Date.parse(time))/1000;return age<0?'UNKNOWN':age<=p.live?'LIVE':age<=p.fresh?'FRESH':age<=p.historical?'STALE':'HISTORICAL';}
export const replayFeatures=(items:ReplayItem[]):GeoJSON.FeatureCollection=>({type:'FeatureCollection',features:items.filter(i=>i.lat!=null&&i.lon!=null&&(i.domain!=='correlations'||i.status==='ACTIVE')).slice(0,2000).map(i=>({type:'Feature',geometry:{type:'Point',coordinates:[i.lon!,i.lat!]},properties:{id:i.id,label:i.name,domain:i.domain,color:REPLAY_COLORS[i.domain]}}))});
export const REPLAY_COLORS:Record<ReplayDomain,string>={conflict:'#fb7185',aircraft:'#67e8f9',vessel:'#60a5fa',satellite:'#c4b5fd',fire:'#fb923c',earthquake:'#f87171',weather:'#a5b4fc',news:'#fde68a',cyber:'#e879f9',infrastructure:'#94a3b8',correlations:'#facc15'};
export function chunkRange(s:ReplayState){const hour=3600000,from=Math.max(s.from,Math.floor(s.at/hour)*hour);return {from,to:Math.min(s.to,from+hour)};}

export function replayLiveLayers(layers:Record<string,boolean>):Record<string,boolean>{return {...Object.fromEntries(Object.entries(layers).map(([k,v])=>[k,k.startsWith('terrain_')?v:false])),conflict_zones:false,sdk_sea:false,sdk_air:false,sdk_naval:false};}
export function normalizeReplayBounds(b:{west:number;south:number;east:number;north:number}):ReplayBounds {const wrap=(n:number)=>((n+180)%360+360)%360-180;return Math.abs(b.east-b.west)>=360?[-180,Math.max(-90,b.south),180,Math.min(90,b.north)]:[wrap(b.west),Math.max(-90,b.south),wrap(b.east),Math.min(90,b.north)];}
export function replayInvestigation(focus:InvestigationMapFocus|null,s:ReplayState):InvestigationMapFocus|null {if(!focus?.track)return null;return {...focus,points:(focus.points||[]).filter(p=>p.at&&Date.parse(p.at)>=s.from&&Date.parse(p.at)<=Math.min(s.at,s.to))};}

export function historyReplayItem(o:Observation,objectType:string,name:string):ReplayItem|undefined {
 const mapping:Record<string,string>={CONFLICT_REPORT:'conflict',POSITION:objectType,FIRE:'fire',EARTHQUAKE:'earthquake',SEVERE_WEATHER:'weather',WEATHER:'weather',NEWS_EVENT:'news',CYBER_INDICATOR:'cyber',REFERENCE_LOCATION:'infrastructure'};
 const domain=mapping[o.event_type];
 if(!REPLAY_DOMAINS.includes(domain as ReplayDomain))return undefined;
 return {id:o.id,object_id:o.object_id,name,domain:domain as ReplayDomain,from:o.timeline_at,to:new Date(Date.parse(o.timeline_at)+1).toISOString(),lat:o.lat,lon:o.lon,observation:o};
}
