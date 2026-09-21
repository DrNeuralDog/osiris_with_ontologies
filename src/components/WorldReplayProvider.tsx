'use client';
import {createContext,useContext,useState,useEffect,useMemo,useRef,type ReactNode,type Dispatch,type SetStateAction} from 'react';
import {intelligenceRequest} from '@/lib/intelligence';
import {initialReplay,parseReplayURL,replayURL,advanceReplay,jumpReplay,returnLive,chunkRange,replayItemsAt,replayFreshness,REPLAY_DOMAINS,type ReplayState,type ReplayItem,type ReplayCoverage,type ReplayChunk,type ReplayBounds,type ReplayDomain} from '@/lib/replay';
interface ReplayContext {
 state:ReplayState;setState:Dispatch<SetStateAction<ReplayState>>;domains:ReplayDomain[];setDomains:Dispatch<SetStateAction<ReplayDomain[]>>;
 items:ReplayItem[];coverage:ReplayCoverage|null;policies:ReplayChunk['policies'];busy:boolean;error:string;truncated:boolean;selection:ReplayItem|null;select:(item:ReplayItem|null)=>void;
 jump:(at:number,item?:ReplayItem)=>void;live:()=>void;setBounds:Dispatch<SetStateAction<ReplayBounds|null>>;
}
const Context=createContext<ReplayContext|null>(null);
export function useWorldReplay(){const c=useContext(Context);if(!c)throw new Error('WorldReplayProvider required');return c;}
export default function WorldReplayProvider({children}:{children:ReactNode}){
 const [state,setState]=useState(()=>initialReplay(Date.now())),[domains,setDomains]=useState<ReplayDomain[]>([...REPLAY_DOMAINS]),[bounds,setBounds]=useState<ReplayBounds|null>(null);
 const [coverage,setCoverage]=useState<ReplayCoverage|null>(null),[chunk,setChunk]=useState<ReplayChunk>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[coverageError,setCoverageError]=useState(''),[selection,select]=useState<ReplayItem|null>(null);
 const cache=useRef(new Map<string,{value:ReplayChunk;until:number}>());
 useEffect(()=>{const t=setTimeout(()=>setState(parseReplayURL(window.location.href,Date.now())),0);return()=>clearTimeout(t);},[]);
 useEffect(()=>{const t=setTimeout(()=>window.history.replaceState(null,'',replayURL(window.location.href,state)),500);return()=>clearTimeout(t);},[state]);
 useEffect(()=>{if(!state.playing||state.mode!=='replay'||busy)return;let last=performance.now();const timer=setInterval(()=>{const now=performance.now(),elapsed=now-last;last=now;setState(s=>document.hidden?{...s,playing:false}:advanceReplay(s,elapsed));},1000);return()=>clearInterval(timer);},[state.playing,state.mode,busy]);
 const domainKey=domains.join(','),bbox=bounds?.map(n=>n.toFixed(2)).join(',')||'',range=chunkRange(state);
 useEffect(()=>{if(!state.open)return;const c=new AbortController();const t=setTimeout(()=>{
  const p=new URLSearchParams({from:new Date(state.from).toISOString(),to:new Date(state.to).toISOString(),domains:domainKey});if(bbox)p.set('bbox',bbox);
  void intelligenceRequest<ReplayCoverage>(`timeline/coverage?${p}`,c.signal).then(r=>{if(!c.signal.aborted){setCoverage(r);setCoverageError('');}}).catch(e=>{if(!c.signal.aborted)setCoverageError(e.message);});
 },350);return()=>{clearTimeout(t);c.abort();};},[state.open,state.from,state.to,domainKey,bbox]);
 useEffect(()=>{if(state.mode!=='replay')return;const c=new AbortController();
  const p=new URLSearchParams({from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString(),domains:domainKey,limit:'5000'});if(bbox)p.set('bbox',bbox);const key=p.toString();
  const timer=setTimeout(()=>{setError('');const saved=cache.current.get(key);if(saved&&saved.until>Date.now()){setChunk(saved.value);setBusy(false);return;}setBusy(true);setChunk(undefined);
   void intelligenceRequest<ReplayChunk>(`timeline/chunk?${p}`,c.signal).then(r=>{if(c.signal.aborted)return;if(cache.current.size>=4)cache.current.delete(cache.current.keys().next().value!);cache.current.set(key,{value:r,until:Date.now()+60000});setChunk(r);}).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setBusy(false);});
  },300);return()=>{clearTimeout(timer);c.abort();};
 },[state.mode,range.from,range.to,domainKey,bbox]);
 const items=useMemo(()=>state.mode==='replay'?replayItemsAt(chunk,state.at):[],[chunk,state.at,state.mode]);
 const currentSelection=useMemo(()=>{
  if(!selection)return null;
  const current=selection.correlation_id?items.find(i=>i.correlation_id===selection.correlation_id):selection;
  return current?{...current,freshness:replayFreshness(current,state.at,chunk?.policies||{})}:null;
 },[selection,state.at,chunk,items]);
 const value:ReplayContext={state,setState,domains,setDomains,items,coverage,policies:chunk?.policies||{},busy,error:error||coverageError,truncated:!!chunk?.truncated||items.length>2000,selection:currentSelection,select,setBounds,
  jump:(at,item)=>{setState(s=>jumpReplay(s,at));select(item||null);},live:()=>{setState(returnLive);select(null);}};
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
