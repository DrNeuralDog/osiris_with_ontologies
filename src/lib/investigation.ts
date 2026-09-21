import type { InvestigationSeed, OntologyObject } from './ontology';
export type InvestigationIntent = 'graph' | 'history' | 'evidence' | 'related';
export const INVESTIGATION_ACTIONS: { intent: InvestigationIntent; label: string }[] = [
  { intent: 'graph', label: 'Explore relationships' }, { intent: 'history', label: 'History' },
  { intent: 'evidence', label: 'Evidence' }, { intent: 'related', label: 'Related objects' },
];
export interface InvestigationContext { object: OntologyObject; relationships: number; observations: number }
/** Vector-tile hit coordinates are quantised; identity must retain source coordinates. */
export function investigationPoint(record: Record<string, unknown>, rendered: number[]) {
  return { lat: typeof record.lat==='number'?record.lat:rendered[1], lng: typeof (record.lng??record.lon)==='number'?Number(record.lng??record.lon):rendered[0] };
}
export function investigationView(intent: InvestigationIntent) { return { tab: intent === 'history' ? 'history' as const : 'details' as const, depth: intent === 'history' || intent === 'evidence' ? 0 : 1 }; }
export function mapEntitySeed(entity: Record<string, unknown>): InvestigationSeed | null {
  const aliases: Record<string, string> = { cctv: 'camera', severe_weather: 'weather', news_event: 'news' };
  const type = aliases[String(entity.type)] || String(entity.type || '').toLowerCase();
  const value = (key: string) => ['string','number'].includes(typeof entity[key]) ? String(entity[key]).trim() : '';
  const valid = (key: string, pattern: RegExp) => pattern.test(value(key)) ? value(key) : '';
  const point = typeof entity.lat === 'number' && Number.isFinite(entity.lat) && Math.abs(entity.lat) <= 90 && typeof (entity.lng ?? entity.lon) === 'number' && Math.abs(Number(entity.lng ?? entity.lon)) <= 180;
  let id = '', provider = value('provider') || value('source') || 'OSIRIS map';
  switch (type) {
    case 'aircraft': id = valid('icao24', /^[\da-f]{6}$/i) || valid('registration', /^(?!UNKNOWN$|N\/A$)[a-z\d -]{3,14}$/i); break;
    case 'vessel': id = valid('imo', /^\d{7}$/) || valid('mmsi', /^\d{9}$/); break;
    case 'country': id = valid('wikidata', /^Q[1-9]\d*$/i) || valid('iso3166', /^[a-z]{2}$/i) || valid('id', /^[a-z]{2}$/i); break;
    case 'company': case 'person': id = valid('wikidata', /^Q[1-9]\d*$/i) || valid('id', /^Q[1-9]\d*$/i) || value('source_id'); break;
    case 'ip': id = value('ip') || value('id'); if (!/^[\da-f.:]+$/i.test(id)) return null; break;
    case 'earthquake': id = valid('id', /^[a-z]{2}[a-z\d]+$/i); if (value('source') && value('source') !== 'USGS') return null; provider = 'USGS'; break;
    case 'fire': if (!point || !/^\d{4}-\d{2}-\d{2}$/.test(value('date')) || !/^\d{1,4}$/.test(value('time')) || !/^NASA-FIRMS \((VIIRS|MODIS)\)$/.test(provider)) return null; id = `${entity.lat},${entity.lng ?? entity.lon}:${value('date')}:${value('time')}`; break;
    case 'weather': id = valid('id', /^(nws-|eonet-|gdacs-).+/); break;
    case 'satellite': id = valid('noradId', /^\d{1,9}$/) || valid('norad', /^\d{1,9}$/); provider = 'CelesTrak / OSIRIS SGP4'; break;
    case 'airport': id = valid('icao', /^[A-Z0-9]{4}$/i) || valid('iata', /^[A-Z]{3}$/i); provider = 'OSIRIS reference catalog'; break;
    case 'port': if (!point || !value('name')) return null; id = value('catalog_id') || value('id') || `${value('name')}:${entity.lat},${entity.lng ?? entity.lon}`; provider = 'OSIRIS reference catalog'; break;
    case 'infrastructure': id = value('id'); provider = 'OSIRIS reference catalog'; break;
    case 'camera': id = valid('id', /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/); break;
    case 'news': case 'event': {
      if (!point || ['country','region','country-anchor'].includes(value('location_precision'))) return null;
      try { const url = new URL(value('link') || value('url')); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; url.hash = ''; id = url.href; } catch { return null; } break;
    }
    default: return null;
  }
  if (!id || id.length > 500 || id === '0') return null;
  const patterns: Record<string,RegExp> = { icao24:/^[a-f\d]{6}$/i, registration:/^[a-z\d -]{3,14}$/i, imo:/^\d{7}$/, mmsi:/^\d{9}$/, wikidata:/^Q[1-9]\d*$/i, iso3166:/^[a-z]{2}$/i };
  const identifiers: Record<string,string> = {};
  const record = { ...entity };
  for (const key of Object.keys(patterns)) {
    const v=valid(key,patterns[key]);
    if(v && !/^(N\/A|UNKNOWN|UNK|0|—)$/i.test(v)) identifiers[key]=v;
    else delete record[key];
  }
  if(value('source_id')) identifiers.source_id=value('source_id');
  return { type, id, name: (value('name') || value('title') || value('place') || value('callsign') || id).slice(0,300), provider: provider.slice(0,100), record, ...identifiers };
}
export async function registerInvestigation(seed: InvestigationSeed, signal?: AbortSignal): Promise<InvestigationContext> {
  const response = await fetch('/api/intelligence/investigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed), signal });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Investigation unavailable'); return data;
}
