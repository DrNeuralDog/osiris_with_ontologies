'use client';
import { useEffect, useState } from 'react';
import {useAirThreat} from './AirThreatProvider';
import { Activity, ChevronDown, ChevronUp, Network } from 'lucide-react';
import { intelligenceRequest, displayTime } from '@/lib/intelligence';
import type { InvestigationContext, InvestigationIntent } from '@/lib/investigation';
export interface IntelligenceSummary {
  objects: number | null; relationships: number | null; observations: number | null; active_correlations: number | null; expired_correlations: number | null;
  database: string; sources: Record<string, number> | null; checked_at: string;
  worker: { status: string; last_cycle_at?: string; last_ingestion_at?: string };
  latest_correlation: { id: string; correlation_type: string; last_confirmed_at: string } | null;
}
export default function IntelligenceCenter({ onExplorer, onHealth, onCorrelations, context, onContext, busy, error }: {
  onExplorer: () => void; onHealth: () => void; onCorrelations: () => void; context: InvestigationContext | null;
  onContext: (intent: InvestigationIntent) => void; busy: boolean; error: string;
}) {
  const air = useAirThreat();
  const [expanded,setExpanded]=useState(true),[summary,setSummary]=useState<IntelligenceSummary|null>(null),[failure,setFailure]=useState('');
  useEffect(()=>{const c=new AbortController();let pending=false,lastAttempt=0;
    const refresh=async(initial=false)=>{if(pending||(!initial&&document.hidden)||Date.now()-lastAttempt<10000)return;pending=true;lastAttempt=Date.now();try{const s=await intelligenceRequest<IntelligenceSummary>('summary',c.signal);if(!c.signal.aborted){setSummary(s);setFailure('');}}catch{if(!c.signal.aborted){setSummary(null);setFailure('Intelligence service unavailable');}}finally{pending=false;}};
    void refresh(true);const visible=()=>void refresh();document.addEventListener('visibilitychange',visible);const timer=setInterval(()=>void refresh(),20000);return()=>{c.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const count=(n:number|null|undefined)=>n==null?'—':n.toLocaleString();
  const button='rounded border border-[var(--gold-primary)]/30 px-2 py-2 hover:bg-[var(--gold-primary)]/10 text-left';
  return <section aria-label="Intelligence Center" className="absolute right-14 md:right-16 top-24 z-[240] w-[290px] max-w-[calc(100vw-120px)] rounded-lg border border-[var(--gold-primary)]/50 bg-[var(--bg-primary)]/95 shadow-xl font-mono text-[11px] text-[var(--text-primary)]">
    <button aria-expanded={expanded} className="w-full flex gap-2 items-center p-3 text-[var(--gold-primary)] tracking-wider" onClick={()=>setExpanded(!expanded)}><Network size={16}/><strong className="flex-1 text-left">INTELLIGENCE CENTER</strong>{expanded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}</button>
      {context&&<div aria-label="Investigation context" className="border-t border-[var(--gold-primary)]/30 p-3"><div className="text-[var(--gold-primary)]">INVESTIGATING</div><strong className="block truncate">{context.object.canonical_name}</strong><div>{context.object.type} · {context.relationships} relationships · {context.observations} observations</div><div className="flex gap-3 mt-2"><button className="underline" onClick={()=>onContext('graph')}>Graph</button><button className="underline" onClick={()=>onContext('history')}>History</button><button className="underline" onClick={()=>onContext('evidence')}>Evidence</button></div></div>}
    {expanded&&<div className="border-t border-[var(--border-primary)] p-3 space-y-3 max-h-[55vh] overflow-auto">
      <div className="grid grid-cols-3 gap-2">{[['Objects',summary?.objects],['Links',summary?.relationships],['Observations',summary?.observations]].map(([label,value])=><div key={String(label)}><strong className="block text-base text-cyan-300">{count(value as number|null|undefined)}</strong><span className="text-[9px] text-slate-400">{label}</span></div>)}</div>
      <div className="grid grid-cols-3 gap-2 text-[9px]"><button className={button} onClick={onExplorer}>OBJECT EXPLORER</button><button className={button} onClick={onCorrelations}>CORRELATIONS</button><button className={button} onClick={onHealth}>SOURCE HEALTH</button></div>
      <button className={`${button} w-full`} onClick={onCorrelations}><strong className="text-[var(--gold-primary)]">{count(summary?.active_correlations)} ACTIVE CORRELATIONS</strong><span className="block text-slate-400">{count(summary?.expired_correlations)} expired · related signals</span>{summary?.latest_correlation&&<span className="block mt-1 text-[9px] break-words">{summary.latest_correlation.correlation_type.replaceAll('_',' ')} · {displayTime(summary.latest_correlation.last_confirmed_at)}</span>}</button>
      <button className={`${button} w-full`} onClick={()=>air.setOpen(true)}><strong className="text-amber-300">CIVILIAN AIR THREAT</strong><span className="block">{air.aoi?.name||"Choose an area of interest"}</span>{air.state&&<span className="block">{air.state.counts.official_active} official active · {air.state.counts.last60} reports / 1h · {air.state.counts.acoustic} acoustic · {air.state.counts.clusters} clusters<br/>{air.state.coverage}</span>}</button>
      <div><div className="text-slate-400 mb-1">SOURCES · all scopes</div><div className="flex flex-wrap gap-x-3 gap-y-1">{['HEALTHY','DEGRADED','OFFLINE','STALE','UNKNOWN'].map(s=><span key={s} className={s==='HEALTHY'?'text-emerald-300':s==='OFFLINE'?'text-red-300':'text-slate-300'}>{s} {count(summary?.sources?.[s])}</span>)}</div></div>
      <div className="border-t border-[var(--border-primary)] pt-2 text-[10px] space-y-1"><div className="flex items-center gap-2"><Activity size={12}/>Worker: {summary?.worker.status||'UNKNOWN'}</div><div>Ontology DB: {summary?.database||'UNKNOWN'}</div><div className="text-slate-400">Cycle: {displayTime(summary?.worker.last_cycle_at)}</div><div className="text-slate-400">Ingestion: {displayTime(summary?.worker.last_ingestion_at)}</div></div>
      {busy&&<p role="status" className="text-cyan-300">Registering selected object…</p>}{(failure||error)&&<p role="alert" className="text-amber-300">{error||failure}</p>}
    </div>}
  </section>;
}
