'use client';
import { useEffect, useRef, useState } from 'react';
import { ontologyRequest } from '@/lib/ontology';
import { displayTime, confidenceLabel, observationEvidenceLabel, type Observation, type Page, type InvestigationMapFocus } from '@/lib/intelligence';
import EvidenceView from './EvidenceView';
import { useWorldReplay } from './WorldReplayProvider';
import { replayFreshness, historyReplayItem } from '@/lib/replay';
const localInput=(at:number)=>new Date(at-new Date(at).getTimezoneOffset()*60000).toISOString().slice(0,16);
const button = 'border border-[var(--border-primary)] rounded px-2 py-1 text-xs hover:border-[var(--gold-primary)] disabled:opacity-40';
export default function ObjectHistory({ objectId, objectType, objectName, onMap, onJump }: { objectId: string; objectType: string; objectName: string; onMap?: (focus: InvestigationMapFocus) => void; onJump?: () => void }) {
  const replay=useWorldReplay();
  const [items, setItems] = useState<Observation[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [from, setFrom] = useState(()=>replay.state.mode==='replay'?localInput(Math.min(replay.state.from,replay.selection?.object_id===objectId?Date.parse(replay.selection.from):replay.state.from)):''), [to, setTo] = useState(()=>replay.state.mode==='replay'?localInput(replay.state.to):''), [locations, setLocations] = useState(false);
  const abort = useRef<AbortController | null>(null);
  async function load(more = false) {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError('');
    const params = new URLSearchParams({ limit: '50', order: 'desc', location_only: String(locations) });
    if (from) params.set('from', new Date(from).toISOString()); if (to) params.set('to', new Date(to).toISOString()); if (more && cursor) params.set('cursor', cursor);
    try { const result = await ontologyRequest<Page<Observation>>(`objects/${objectId}/history?${params}`, undefined, controller.signal); if (controller.signal.aborted) return; setItems(old => more ? [...old, ...result.items] : result.items); setCursor(result.next_cursor); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'History unavailable'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => { clearTimeout(timer); abort.current?.abort(); }; /* ObjectHistory is keyed by object ID; date inputs apply explicitly. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId]);
  const points = items.filter(o => o.lat != null && o.lon != null && o.event_type === 'POSITION' && (replay.state.mode==='live'||Date.parse(o.timeline_at)>=replay.state.from&&Date.parse(o.timeline_at)<=replay.state.at)).slice(0, 200).reverse().map(o => ({ lat: o.lat!, lng: o.lon!, at: o.observed_at || o.timeline_at }));
  const historicalItem=(o:Observation)=>historyReplayItem(o,objectType,objectName);
  function jump(o:Observation){const at=Date.parse(o.timeline_at);if(at>Date.now()){setError('This model value has a future valid time. Replay becomes available at that time.');return;}replay.jump(at,historicalItem(o));if(o.lat!=null&&o.lon!=null)onMap?.({lat:o.lat,lng:o.lon,objectId,label:`Retained observation · ${o.timeline_at}`});onJump?.();}
  return <section className="space-y-2 text-xs" aria-label="Object history"><h4 className="tracking-widest text-[var(--gold-primary)]">HISTORY / TIMELINE</h4>
    <form onSubmit={e => { e.preventDefault(); void load(); }} className="space-y-2"><label className="block">From <input aria-label="History from" type="datetime-local" className="w-full bg-[var(--bg-secondary)] p-1" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="block">To <input aria-label="History to" type="datetime-local" className="w-full bg-[var(--bg-secondary)] p-1" value={to} onChange={e => setTo(e.target.value)} /></label><label className="block"><input type="checkbox" checked={locations} onChange={e => setLocations(e.target.checked)} /> Location observations only</label><button disabled={busy} className={button}>Apply / refresh</button></form>
    <p className="text-[10px] text-slate-400">Default: last 90 days. Maximum range: 366 days. Local time shown. Unknown observation time is labelled received.</p>
    {onMap && points.length > 1 && <button className={button} onClick={() => onMap({ ...points[points.length - 1], objectId, points, track: true, label: `Retained positions · ${points.length} loaded observations` })}>Show loaded track on map</button>}
    {error && <p role="alert" className="text-red-300">{error}</p>}{busy && <p role="status">Loading history…</p>}
    {!busy && !items.length && <p className="text-slate-400">No retained observations yet for this range. Telemetry begins after the object is registered; source timestamps are required.</p>}
    {items.map(o => <article key={o.id} aria-current={replay.selection?.id===o.id?"true":undefined} className="aria-[current=true]:bg-cyan-900/30 border-l-2 border-[var(--gold-primary)]/40 pl-2 space-y-1 py-2"><div className="text-cyan-300">{displayTime(o.timeline_at)}{o.time_basis === 'received' ? ' · RECEIVED' : ''}</div><strong className="break-words">{o.event_type}</strong><div>{observationEvidenceLabel(o)} · {replay.state.mode==='replay'?(historicalItem(o)?replayFreshness(historicalItem(o)!,replay.state.at,replay.policies):'UNKNOWN')+' relative to replay time':o.freshness}</div><div>{o.source_id} · Confidence: {confidenceLabel(o.confidence)}</div>{o.lat != null && o.lon != null && <button className={button} disabled={!onMap} onClick={() => onMap?.({ lat: o.lat!, lng: o.lon!, objectId, label: `${o.event_type} · ${displayTime(o.observed_at)}` })}>Locate {o.lat.toFixed(4)}, {o.lon.toFixed(4)}</button>}<button className={button} onClick={()=>jump(o)}>Jump to this time on global timeline</button><details><summary className="cursor-pointer">Properties & provenance</summary><pre className="whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(o.data, null, 2)}</pre><EvidenceView items={o.provenance} /></details></article>)}
    {cursor && items.length < 500 && <button className={button} disabled={busy} onClick={() => void load(true)}>Load next 50</button>}{items.length >= 500 && <p>500 events loaded. Narrow the time range to continue.</p>}
  </section>;
}
