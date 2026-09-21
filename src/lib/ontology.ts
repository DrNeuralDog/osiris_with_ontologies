export interface Provenance {
  provider: string; source_id: string | null; url: string | null;
  observed_at: string | null; fetched_at: string; confidence: number | null;
  kind: 'observed' | 'reported' | 'derived' | 'inferred' | 'imported'; metadata: Record<string, unknown>;
  source_record_id?: string | null; extraction_method?: string | null; confidence_basis?: string | null;
}
export interface OntologyObject {
  id: string; type: string; canonical_name: string;
  external_ids: { namespace: string; value: string }[];
  properties: Record<string, unknown>; provenance: Provenance[];
  created_at: string; updated_at: string;
}
export interface OntologyLink {
  id: string; source: string; target: string; link_type: string;
  properties: Record<string, unknown>; confidence: number | null;
  valid_from: string | null; valid_to: string | null; provenance: Provenance[];
}
export interface OntologyGraph { root_id: string; nodes: OntologyObject[]; links: OntologyLink[]; truncated: boolean; warnings?: string[]; aliases?: Record<string, string> }
export interface InvestigationSeed {
  record?: Record<string, unknown>;
  type: string; id: string; name?: string; icao24?: string; registration?: string;
  callsign?: string; model?: string; imo?: string; mmsi?: string; wikidata?: string;
  iso3166?: string; provider?: string; source_id?: string;
}
export const OBJECT_COLORS: Record<string, string> = { aircraft: '#00E5FF', vessel: '#4FC3F7', company: '#D4AF37', person: '#CE93D8', country: '#81C784', ip: '#FF8A65', location: '#AED581', organization: '#FFD54F', event: '#F06292', infrastructure: '#90A4AE', observation: '#FFFFFF', camera: '#FBBF24', satellite: '#A78BFA', airport: '#38BDF8', port: '#2DD4BF' };
export function mergeGraph(current: OntologyGraph, incoming: OntologyGraph): OntologyGraph {
  const aliases = { ...current.aliases, ...incoming.aliases };
  const canonical = (id: string) => { const seen = new Set<string>(); while (aliases[id] && !seen.has(id)) { seen.add(id); id = aliases[id]; } return id; };
  const nodes = new Map(current.nodes.map(n => [canonical(n.id), { ...n, id: canonical(n.id) }]));
  let truncated = current.truncated || incoming.truncated;
  for (const node of incoming.nodes) { if (nodes.has(node.id) || nodes.size < 250) nodes.set(node.id, node); else truncated = true; }
  const linkKey = (link: OntologyLink) => JSON.stringify([canonical(link.source), canonical(link.target), link.link_type, link.valid_from, link.valid_to]);
  const links = new Map(current.links.map(l => [linkKey(l), { ...l, source: canonical(l.source), target: canonical(l.target) }]));
  for (const link of incoming.links) {
    if (nodes.has(link.source) && nodes.has(link.target) && (links.has(linkKey(link)) || links.size < 500)) links.set(linkKey(link), link);
    else truncated = true;
  }
  return { ...current, root_id: canonical(current.root_id), aliases, nodes: [...nodes.values()], links: [...links.values()], truncated, warnings: [...new Set([...(current.warnings || []), ...(incoming.warnings || [])])] };
}
export function mapInvestigationSeed(entity: Record<string, unknown>): InvestigationSeed | null {
  const type = String(entity.type || '').toLowerCase();
  if (!['aircraft', 'vessel', 'company', 'person', 'country', 'ip'].includes(type)) return null;
  const value = (key: string) => typeof entity[key] === 'string' || typeof entity[key] === 'number' ? String(entity[key]).trim() : undefined;
  const stable = (key: string) => {
    const raw = value(key); if (!raw || /^(N\/A|UNKNOWN|UNK|0|—)$/i.test(raw)) return undefined;
    const patterns: Record<string, RegExp> = { icao24: /^[a-f\d]{6}$/i, registration: /^[a-z\d -]{3,14}$/i, imo: /^\d{7}$/, mmsi: /^\d{9}$/, wikidata: /^Q[1-9]\d*$/i, iso3166: /^[a-z]{2}$/i };
    return !patterns[key] || patterns[key].test(raw) ? raw : undefined;
  };
  const id = stable('wikidata') || (type === 'aircraft' ? stable('icao24') || stable('registration') : type === 'vessel' ? stable('imo') || stable('mmsi') : type === 'ip' ? value('ip') : undefined) || value('id') || value('name');
  if (!id) return null;
  const seed: InvestigationSeed = { type, id, name: value('name') || value('callsign') || id, provider: value('provider') || 'OSIRIS map' };
  for (const key of ['icao24', 'registration', 'callsign', 'model', 'imo', 'mmsi', 'wikidata', 'iso3166', 'source_id'] as const) { const v = stable(key); if (v) seed[key] = v; }
  return seed;
}
export async function ontologyRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/ontology/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ontology HTTP ${response.status}`);
  return data;
}
