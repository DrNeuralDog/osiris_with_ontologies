'use client';
import {useLocale as useUILocale} from '@/lib/i18n';
import type { Provenance } from '@/lib/ontology';
import { displayTime, confidenceLabel } from '@/lib/intelligence';
export default function EvidenceView({ items }: { items: Provenance[] }) {
  const {t:uiText}=useUILocale();
  return <div className="space-y-2">{!items.length && <p className="text-xs text-slate-400">{uiText("Evidence not provided")}</p>}{items.map((p, index) => <div key={`${p.provider}:${p.source_id}:${index}`} className="p-2 border border-[var(--border-primary)] rounded text-[11px] break-words">
    <div className="flex justify-between gap-2"><strong>{p.provider}</strong><span className={['inferred', 'derived', 'reported'].includes(p.kind) ? 'text-amber-300' : 'text-cyan-300'}>{uiText(p.kind.toUpperCase())}</span></div>
    <div>{uiText("Source ID:")}{" "}{p.source_id || uiText("Not provided")}</div>{p.source_record_id && <div>{uiText("Record:")}{" "}{p.source_record_id}</div>}
    <div>{uiText("Observed:")}{" "}{uiText(displayTime(p.observed_at))}</div><div>{uiText("Fetched:")}{" "}{uiText(displayTime(p.fetched_at))}</div>
    <div>{uiText("Confidence:")}{" "}{uiText(confidenceLabel(p.confidence))}{p.confidence != null ? ' ('+uiText('source score')+')' : ''}</div>
    {p.confidence_basis && <div>{uiText("Basis:")}{" "}{p.confidence_basis}</div>}{p.extraction_method && <div>{uiText("Method:")}{" "}{p.extraction_method}</div>}
    {p.url && /^https?:\/\//i.test(p.url) && <a className="text-[var(--gold-primary)] underline" href={p.url} target="_blank" rel="noopener noreferrer">{uiText("Open source ↗")}</a>}
    {Object.keys(p.metadata || {}).length > 0 && <details><summary className="cursor-pointer">{uiText("Evidence metadata / property values")}</summary><pre className="whitespace-pre-wrap break-words mt-1">{JSON.stringify(p.metadata, null, 2)}</pre></details>}
  </div>)}</div>;
}
