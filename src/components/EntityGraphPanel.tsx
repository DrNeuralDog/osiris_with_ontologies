'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-2d';
import { X, Crosshair, RotateCcw, Search, Network, LoaderCircle } from 'lucide-react';
import EvidenceView from './EvidenceView';
import ObjectHistory from './ObjectHistory';
import { investigationView, type InvestigationIntent, type InvestigationContext } from '@/lib/investigation';
import { intelligenceRequest } from '@/lib/intelligence';
import type { InvestigationMapFocus } from '@/lib/intelligence';
import { OBJECT_COLORS, mergeGraph, ontologyRequest, type InvestigationSeed, type OntologyGraph, type OntologyObject, type OntologyLink } from '@/lib/ontology';

type GraphNode = NodeObject<OntologyObject>;
const buttonClass = 'px-2 py-1.5 rounded border border-[var(--border-primary)] hover:border-[var(--gold-primary)] disabled:opacity-40 text-xs';
const empty: OntologyGraph = { root_id: '', nodes: [], links: [], truncated: false };
const tooltip = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export default function EntityGraphPanel({ seed, objectId, intent='graph', onContext, onMap, onClose }: { seed?: InvestigationSeed; objectId?: string; intent?: InvestigationIntent; onContext?: (context: InvestigationContext) => void; onMap?: (focus: InvestigationMapFocus) => void; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<'details' | 'history'>(investigationView(intent).tab);
  const [graph, setGraph] = useState<OntologyGraph>(empty);
  const [selected, setSelected] = useState<string>('');
  const [selectedLink, setSelectedLink] = useState<OntologyLink | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [type, setType] = useState(seed?.type || 'company');
  const [results, setResults] = useState<OntologyObject[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 640, height: 480 });
  const viewport = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const canvas = useRef<ForceGraphMethods<OntologyObject, OntologyLink>>(undefined);
  const fittedRoot = useRef('');
  const controller = useRef<AbortController | null>(null), generation = useRef(0), lock = useRef(false);
  const selectedObject = graph.nodes.find(n => n.id === selected);
  // The renderer mutates endpoints and positions; API state stays immutable.
  const rendered = useMemo(() => ({ nodes: graph.nodes.map(n => ({ ...n })), links: graph.links.map(l => ({ ...l })) }), [graph]);
  useEffect(() => {
    const linkForce = canvas.current?.d3Force('link') as { distance: (value: number) => void } | undefined;
    const charge = canvas.current?.d3Force('charge') as { strength: (value: number) => void } | undefined;
    linkForce?.distance(140); charge?.strength(-500);
    canvas.current?.d3ReheatSimulation();
  }, [rendered]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const panel = closeButton.current?.closest('[role="dialog"]');
        const focusable = panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href], summary, [tabindex="0"]');
        const first = focusable?.[0], last = focusable?.[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { controller.current?.abort(); window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const resize = new ResizeObserver(entries => { const r = entries[0].contentRect; setSize({ width: Math.floor(r.width), height: Math.floor(r.height) }); });
    resize.observe(element); return () => resize.disconnect();
  }, []);
  const run = useCallback(async (action: (signal: AbortSignal) => Promise<OntologyGraph>, replace: boolean) => {
    if (!replace && lock.current) return;
    controller.current?.abort(); controller.current = new AbortController();
    const signal = controller.current.signal, version = ++generation.current;
    lock.current = true; setBusy(true); setError(''); setSelectedLink(null);
    try {
      const data = await action(signal); if (signal.aborted || generation.current !== version) return;
      setGraph(old => replace ? data : mergeGraph(old, data));
      if (replace) { setSelected(data.root_id); setResults([]);setType(data.nodes.find(n=>n.id===data.root_id)?.type||'company'); }
      else setSelected(old => data.aliases?.[old] || old);
    } catch (e) { if (!signal.aborted && generation.current === version) setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { if (generation.current === version) { lock.current = false; setBusy(false); } }
  }, []);
  useEffect(() => { if (seed) void run(signal => ontologyRequest('resolve', seed, signal), true); }, [seed, run]);
  useEffect(() => { if (objectId) void run(signal => ontologyRequest(`objects/${objectId}/graph?depth=${investigationView(intent).depth}`, undefined, signal), true); }, [objectId, intent, run]);
  useEffect(() => { if (!graph.root_id || !onContext) return; const c=new AbortController(); void intelligenceRequest<InvestigationContext>(`objects/${graph.root_id}/context`,c.signal).then(onContext).catch(()=>{});return()=>c.abort(); }, [graph.root_id,onContext]);

  const expand = (node: OntologyObject) => {
    setSelected(node.id); setSelectedLink(null);
    void run(signal => ontologyRequest(`objects/${node.id}/expand`, {}, signal), false);
  };
  const reset = () => { if (graph.root_id) void run(signal => ontologyRequest(`objects/${graph.root_id}/graph?depth=1`, undefined, signal), true); };
  const focus = () => {
    const root = rendered.nodes.find(n => n.id === graph.root_id) as GraphNode | undefined;
    if (root?.x != null && root.y != null) canvas.current?.centerAt(root.x, root.y, 500);
    if (rendered.nodes.length === 1) canvas.current?.zoom(1.5, 350);
    else canvas.current?.zoomToFit(500, 50);
  };
  const search = async () => {
    if (!query.trim() || lock.current) return;
    controller.current?.abort(); controller.current = new AbortController();
    const signal = controller.current.signal, version = ++generation.current;
    setError(''); setBusy(true); lock.current = true;
    try {
      const data = await ontologyRequest<{ objects: OntologyObject[] }>(`objects?q=${encodeURIComponent(query.trim())}&type=${type}`, undefined, signal);
      if (signal.aborted || generation.current !== version) return;
      setResults(data.objects); if (!data.objects.length) setError('No saved objects. Use “Resolve source” to search Wikidata or a stable identifier.');
    } catch (e) { if (!signal.aborted && generation.current === version) setError(e instanceof Error ? e.message : 'Search failed'); }
    finally { if (generation.current === version) { setBusy(false); lock.current = false; } }
  };
  return <section role="dialog" aria-modal="true" aria-label="Ontology graph explorer" className="fixed inset-2 md:inset-6 z-[1200] flex flex-col rounded-lg border border-[var(--gold-primary)]/50 bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-2xl font-mono overflow-hidden">
    <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-primary)] px-4 py-3">
      <Network size={17} className="text-[var(--gold-primary)]" /><div className="mr-auto min-w-0"><h2 className="text-sm tracking-widest">OBJECT EXPLORER</h2><p className="text-xs text-[var(--gold-primary)] truncate">{graph.nodes.find(n=>n.id===graph.root_id)?.canonical_name || seed?.name || 'Saved ontology'}{selectedObject&&selectedObject.id!==graph.root_id?` → ${selectedObject.canonical_name}`:''}</p></div>
      <button className={buttonClass} onClick={focus} disabled={!graph.root_id} title="Refocus root"><Crosshair size={16} /></button>
      <button className={buttonClass} onClick={reset} disabled={busy || !graph.root_id} title="Reset to root"><RotateCcw size={16} /></button>
      <button ref={closeButton} className={buttonClass} onClick={onClose} aria-label="Back to map / Close graph">Back to map <X className="inline" size={14} /></button>
    </header>
    <form onSubmit={e => { e.preventDefault(); void search(); }} className="flex flex-wrap gap-2 p-3 border-b border-[var(--border-primary)]">
      <select aria-label="Object type" value={type} onChange={e => setType(e.target.value)} className="bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded text-xs p-2">{['company', 'person', 'country', 'aircraft', 'vessel', 'ip', 'organization', 'location', 'event', 'infrastructure', 'airport', 'port', 'satellite', 'camera'].map(t => <option key={t}>{t}</option>)}</select>
      <input aria-label="Object name or identifier" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, Wikidata QID, ICAO24, MMSI or IP…" className="flex-1 min-w-36 bg-transparent border border-[var(--border-primary)] rounded px-2 text-xs" />
      <button disabled={busy || !query.trim()} className={buttonClass} title="Search saved objects"><Search size={15} /></button>
      <button type="button" disabled={busy || !query.trim()} className={buttonClass} onClick={() => void run(signal => ontologyRequest('resolve', { type, id: query.trim() }, signal), true)}>Resolve source</button>
    </form>
    {results.length > 0 && <div className="max-h-28 overflow-auto flex flex-wrap gap-2 p-2">{results.map(n => <button key={n.id} className={buttonClass} onClick={() => void run(signal => ontologyRequest(`objects/${n.id}/graph`, undefined, signal), true)}>{n.canonical_name} · {n.type}</button>)}</div>}
    <div aria-live="polite" className="px-3 text-xs">
      {busy && <div className="flex gap-2 py-2 text-[var(--cyan-primary)]"><LoaderCircle size={14} className="animate-spin" />Loading relationships…</div>}
      {error && <div role="alert" className="py-2 text-red-300">{error}</div>}
      {graph.truncated && <div className="py-1 text-amber-300">Graph limit reached (250 nodes / 500 links). Refocus or reset to continue.</div>}
      {graph.warnings?.map(w => <div key={w} className="py-1 text-amber-200">{w}</div>)}
    </div>
    <div className="flex-1 min-h-0 flex flex-col md:flex-row">
      <div ref={viewport} className="relative flex-1 min-h-52 overflow-hidden">
        {graph.nodes.length > 0 ? <ForceGraph2D<OntologyObject, OntologyLink> ref={canvas} width={size.width} height={size.height} graphData={rendered} backgroundColor="#090d12" maxZoom={6}
          nodeLabel={node => tooltip(`${node.canonical_name} · ${node.type}`)}
          nodeColor={node => OBJECT_COLORS[node.type] || '#90A4AE'} nodeVal={node => node.id === graph.root_id ? 10 : 5}
          onNodeClick={node => expand(node)} onLinkClick={link => setSelectedLink(graph.links.find(l => l.id === link.id) || null)}
          onNodeHover={node => setHoveredNode(node?.id || null)} onLinkHover={link => setHoveredLink(link?.id || null)}
          linkColor={link => link.provenance.some(p => p.kind === 'inferred') ? '#A67C43' : '#506574'} linkDirectionalArrowLength={4} linkDirectionalArrowRelPos={0.95}
          linkLineDash={link => link.provenance.some(p => p.kind === 'inferred') ? [4, 3] : []}
          linkLabel={link => tooltip(link.link_type)}
          nodeCanvasObjectMode={() => 'after'} nodeCanvasObject={(node, ctx, scale) => {
            const x = node.x || 0, y = node.y || 0;
            const radius = node.id === graph.root_id ? 15 : 11;
            if (node.id === selected || node.id === graph.root_id) { ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.strokeStyle = node.id === graph.root_id ? '#D4AF37' : '#FFFFFF'; ctx.lineWidth = 1.5 / scale; ctx.stroke(); }
            const important = node.id === selected || node.id === hoveredNode || node.id === graph.root_id;
            const limit = important ? 36 : scale < 0.7 ? 14 : 24;
            ctx.font = `${(important ? 12 : 10) / scale}px monospace`; ctx.textAlign = 'center'; ctx.fillStyle = important ? '#FFFFFF' : '#A6B6C4';
            ctx.fillText(node.canonical_name.length > limit ? `${node.canonical_name.slice(0, limit)}…` : node.canonical_name, x, y + radius + 12 / scale);
          }}
          linkCanvasObjectMode={() => 'after'} linkCanvasObject={(link, ctx, scale) => {
            const source = link.source as unknown as GraphNode, target = link.target as unknown as GraphNode;
            if (source.x == null || target.x == null) return;
            if (scale < 1.5 && link.id !== hoveredLink && link.id !== selectedLink?.id && source.id !== hoveredNode && target.id !== hoveredNode) return;
            ctx.font = `${9 / scale}px monospace`; ctx.fillStyle = '#9AAAB4'; ctx.textAlign = 'center'; ctx.fillText(link.link_type, (source.x + target.x) / 2, ((source.y || 0) + (target.y || 0)) / 2);
          }} cooldownTicks={100} onEngineStop={() => { if (fittedRoot.current !== graph.root_id) { fittedRoot.current = graph.root_id; focus(); } }} /> : <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-[var(--text-secondary)]">Select an object on the map or resolve a name / identifier above.</div>}
        <div className="absolute bottom-2 left-2 right-2 text-[10px] text-slate-400 pointer-events-none">{graph.nodes.length} objects · {graph.links.length} relationships · click to expand · dashed = inferred · history included</div>
      </div>
      <aside className="w-full md:w-80 max-h-[40vh] md:max-h-none overflow-y-auto border-t md:border-t-0 md:border-l border-[var(--border-primary)] p-3 space-y-3">
        <div className="flex flex-wrap gap-2 text-[10px]">{[...new Set(graph.nodes.map(n => n.type))].map(t => <span key={t} style={{ color: OBJECT_COLORS[t] || '#90A4AE' }}>● {t}</span>)}</div>
        {selectedLink ? <><button className={buttonClass} onClick={() => setSelectedLink(null)}>← Object details</button><h3 className="text-sm text-[var(--gold-primary)]">{selectedLink.link_type}</h3><p className="text-xs">{graph.nodes.find(n => n.id === selectedLink.source)?.canonical_name} → {graph.nodes.find(n => n.id === selectedLink.target)?.canonical_name}</p><p className="text-xs">Confidence: {selectedLink.confidence == null ? 'not supplied' : `${Math.round(selectedLink.confidence * 100)}%`}</p>{(selectedLink.valid_from || selectedLink.valid_to) && <p className="text-xs">Valid: {selectedLink.valid_from || '?'} — {selectedLink.valid_to || '?'}</p>}<pre className="text-[11px] whitespace-pre-wrap break-words">{JSON.stringify(selectedLink.properties, null, 2)}</pre><EvidenceView items={selectedLink.provenance} /></> : selectedObject ? <>
          <h3 className="text-sm text-[var(--gold-primary)]">{selectedObject.canonical_name}</h3><p className="text-xs">{selectedObject.type}{selectedObject.id === graph.root_id ? ' · ROOT' : ''}</p>
          <button disabled={busy} className={buttonClass} onClick={() => expand(selectedObject)}>Expand relationships</button>
          <button disabled={busy} className={`${buttonClass} ml-1`} onClick={() => void run(signal => ontologyRequest(`objects/${selectedObject.id}/graph`, undefined, signal), true)}>Make root</button>
          <div className="text-[10px] break-all text-[var(--text-secondary)]">{selectedObject.id}</div>
          <div className="flex gap-2"><button className={buttonClass} aria-pressed={detailTab === 'details'} onClick={() => setDetailTab('details')}>DETAILS / EVIDENCE</button><button className={buttonClass} aria-pressed={detailTab === 'history'} onClick={() => setDetailTab('history')}>HISTORY</button></div>
          {detailTab === 'history' ? <ObjectHistory key={selectedObject.id} objectId={selectedObject.id} onMap={onMap} /> : <><details open><summary className="cursor-pointer text-xs">Properties & identifiers</summary><pre className="text-[11px] whitespace-pre-wrap break-words py-2">{JSON.stringify({ external_ids: selectedObject.external_ids, ...selectedObject.properties }, null, 2)}</pre></details><details open><summary className="cursor-pointer text-xs mb-2">Provenance (latest 50) / property evidence</summary><EvidenceView items={selectedObject.provenance} /></details></>}
          <div className="text-xs space-y-1">{graph.links.filter(l => l.source === selectedObject.id || l.target === selectedObject.id).map(l => <button className="block text-left text-[var(--cyan-primary)] hover:underline" key={l.id} onClick={() => setSelectedLink(l)}>{l.source === selectedObject.id ? '→' : '←'} {l.link_type} · {graph.nodes.find(n => n.id === (l.source === selectedObject.id ? l.target : l.source))?.canonical_name}</button>)}</div>
        </> : <p className="text-xs text-[var(--text-secondary)]">Select a node or relationship to inspect its evidence.</p>}
        <details><summary className="cursor-pointer text-xs">Loaded objects · keyboard navigation</summary>{graph.nodes.map(n => <button disabled={busy} className="block text-left text-xs py-1 hover:underline" key={n.id} onClick={() => expand(n)}>{n.canonical_name} · {n.type}</button>)}</details>
      </aside>
    </div>
  </section>;
}
