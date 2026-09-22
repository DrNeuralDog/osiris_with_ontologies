'use client';
import {useLocale as useUILocale} from '@/lib/i18n';
import AddToCaseButton from './AddToCaseButton';
import { INVESTIGATION_ACTIONS, mapEntitySeed, type InvestigationIntent } from '@/lib/investigation';
import { mapInvestigationSeed, type InvestigationSeed } from '@/lib/ontology';
export default function InvestigationActions({ entity, seed: suppliedSeed, onInvestigate }: { entity: Record<string, unknown>; seed?: InvestigationSeed; onInvestigate: (seed: InvestigationSeed, intent: InvestigationIntent) => void }) {
  const {t:uiText}=useUILocale();
  const seed = suppliedSeed || mapEntitySeed(entity) || (['company','person','country'].includes(String(entity.type)) ? mapInvestigationSeed(entity) : null);
  return <section aria-label={uiText("Intelligence actions")} className="font-mono text-[11px] p-3 border-t border-[var(--gold-primary)]/30 bg-[var(--bg-primary)] text-[var(--text-primary)]"><div className="text-[var(--gold-primary)] tracking-widest mb-2">{uiText("INTELLIGENCE")}</div>{seed && <div className="mb-2"><AddToCaseButton seed={seed}/></div>}{seed ? <div className="grid grid-cols-2 gap-2">{INVESTIGATION_ACTIONS.map(a => <button key={a.intent} className="text-left rounded border border-[var(--gold-primary)]/30 p-2 hover:bg-[var(--gold-primary)]/10" onClick={() => onInvestigate(seed, a.intent)}>{uiText(String(a.label))}</button>)}</div> : <p className="text-slate-400">{uiText("Investigation unavailable: no stable source identity.")}</p>}</section>;
}
