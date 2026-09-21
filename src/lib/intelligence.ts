import type { Provenance, OntologyObject } from './ontology';
export interface Observation {
  id: string; object_id: string; event_type: string; observed_at: string | null; fetched_at: string; timeline_at: string;
  time_basis: 'observed' | 'received'; lat: number | null; lon: number | null; data: Record<string, unknown>;
  source_id: string; confidence: number | null; evidence_state: string; provenance: Provenance[]; freshness: string;
}
export interface SourceStatus {
  id: string; name: string; category: string; scope: string; endpoint: string; status: string; freshness: string;
  last_success_at: string | null; last_failure_at: string | null; last_checked_at: string | null; data_at: string | null;
  consecutive_failures: number; success_rate: number | null; median_latency_ms: number | null; sample_count: number;
  last_error_category: string | null; last_http_status: number | null; record_count: number | null; next_check_at: string;
}
export interface Correlation {
  id: string; correlation_type: string; status: string; strength: string; confidence: number | null;
  rule_id: string; rule_version: number; explanation: string; detected_at: string; last_confirmed_at: string; resolved_at: string | null;
  window_start: string; window_end: string; expires_at: string; related_object_ids: string[];
  geographic_context: { center: { lat: number; lon: number } | null; distance_km: number | null; points: { lat: number; lon: number; object_id: string }[] };
  rationale: { facts: string[]; method: string; independent_providers: string[]; thresholds: Record<string, number> };
  evidence?: { observation_id: string | null; object_id: string; role: string; observed_at: string | null; fetched_at: string | null; data: Record<string, unknown>; provenance: Provenance[] }[];
  objects?: OntologyObject[]; lifecycle?: { status: string; changed_at: string; reason: string }[];
}
export interface Page<T> { items: T[]; next_cursor: string | null }
export interface InvestigationMapFocus { lat: number; lng: number; label: string; objectId?: string; points?: { lat: number; lng: number; at?: string }[]; track?: boolean }
export async function intelligenceRequest<T>(path: string, signal?: AbortSignal, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/intelligence/${path}`, { method, cache: 'no-store', signal });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
export const displayTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not provided';
export const confidenceLabel = (value: number | null | undefined) => value == null ? 'Not provided' : String(value);
// Imported reports retain their source's epistemic status in history and replay.
export function observationEvidenceLabel(o: Pick<Observation, 'evidence_state' | 'provenance'>): string {
  const state = o.evidence_state.toUpperCase();
  return state === 'IMPORTED' && o.provenance.length > 0 && o.provenance.every(p => p.kind === 'reported') ? 'REPORTED' : state;
}
