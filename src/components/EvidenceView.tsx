'use client';
import type { Provenance } from '@/lib/ontology';
import { displayTime, confidenceLabel } from '@/lib/intelligence';
export default function EvidenceView({ items }: { items: Provenance[] }) {
  return <div className="space-y-2">{!items.length && <p className="text-xs text-slate-400">Evidence not provided</p>}{items.map((p, index) => <div key={`${p.provider}:${p.source_id}:${index}`} className="p-2 border border-[var(--border-primary)] rounded text-[11px] break-words">
    <div className="flex justify-between gap-2"><strong>{p.provider}</strong><span className={['inferred', 'derived', 'reported'].includes(p.kind) ? 'text-amber-300' : 'text-cyan-300'}>{p.kind.toUpperCase()}</span></div>
    <div>Source ID: {p.source_id || 'Not provided'}</div>{p.source_record_id && <div>Record: {p.source_record_id}</div>}
    <div>Observed: {displayTime(p.observed_at)}</div><div>Fetched: {displayTime(p.fetched_at)}</div>
    <div>Confidence: {confidenceLabel(p.confidence)}{p.confidence != null ? ' (source score)' : ''}</div>
    {p.confidence_basis && <div>Basis: {p.confidence_basis}</div>}{p.extraction_method && <div>Method: {p.extraction_method}</div>}
    {p.url && /^https?:\/\//i.test(p.url) && <a className="text-[var(--gold-primary)] underline" href={p.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>}
    {Object.keys(p.metadata || {}).length > 0 && <details><summary className="cursor-pointer">Evidence metadata / property values</summary><pre className="whitespace-pre-wrap break-words mt-1">{JSON.stringify(p.metadata, null, 2)}</pre></details>}
  </div>)}</div>;
}
