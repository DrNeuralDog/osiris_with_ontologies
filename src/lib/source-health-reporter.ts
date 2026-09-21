/** Server-only passive instrumentation. A cache hit is not a new upstream success. */
export interface SourceReport {
  source: { id: string; name: string; category: string; endpoint: string; scope?: 'provider' | 'service' | 'camera'; parent_id?: string; policy?: Record<string, number> };
  sample: { ok: boolean; latency_ms?: number; http_status?: number; error_category?: string; record_count?: number; data_at?: string; checked_at?: string };
}
const pending = new Map<string, SourceReport>();
let timer: ReturnType<typeof setTimeout> | null = null;
export function recordSourceCheck(report: SourceReport): void {
  if (process.env.INTELLIGENCE_REPORTING !== '1' || process.env.NODE_ENV === 'test') return;
  if (pending.size >= 200 && !pending.has(report.source.id)) return;
  pending.set(report.source.id, { ...report, sample: { ...report.sample, checked_at: new Date().toISOString() } });
  if (!timer) { timer = setTimeout(() => { timer = null; void flushReports(); }, 1000); timer.unref?.(); }
}
async function flushReports() {
  const batch = [...pending.values()].slice(0, 50); for (const report of batch) pending.delete(report.source.id);
  if (!batch.length) return;
  try {
    await globalThis.fetch(`${process.env.INTEL_URL || 'http://localhost:4000'}/intelligence/source-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intelligence-Key': process.env.INTELLIGENCE_REPORT_KEY || 'osiris-local-reports' }, body: JSON.stringify({ reports: batch }), redirect: 'error', signal: AbortSignal.timeout(3000) });
  } catch { /* Health storage must not break an existing data route. Next real check retries. */ }
  if (pending.size && !timer) { timer = setTimeout(() => { timer = null; void flushReports(); }, 1000); timer.unref?.(); }
}
const PROVIDERS: Record<string, { name: string; category: string }> = {
  'opensky-network.org': { name: 'OpenSky', category: 'aircraft' }, 'opendata.adsb.fi': { name: 'adsb.fi', category: 'aircraft' },
  'earthquake.usgs.gov': { name: 'USGS', category: 'earthquake' }, 'firms.modaps.eosdis.nasa.gov': { name: 'NASA FIRMS', category: 'fire' },
  'eonet.gsfc.nasa.gov': { name: 'NASA EONET', category: 'weather' }, 'api.weather.gov': { name: 'NOAA / NWS', category: 'weather' },
  'www.gdacs.org': { name: 'GDACS', category: 'weather' }, 'celestrak.org': { name: 'CelesTrak', category: 'satellite' },
  'celestrak.com': { name: 'CelesTrak', category: 'satellite' }, 'feodotracker.abuse.ch': { name: 'abuse.ch Feodo', category: 'cyber' },
};
export async function trackedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), provider = PROVIDERS[url.hostname];
  if (!provider || process.env.INTELLIGENCE_REPORTING !== '1') return globalThis.fetch(input, init);
  const source = { id: `upstream:${url.hostname}`, ...provider, endpoint: url.hostname }; const start = Date.now();
  try {
    const result = await globalThis.fetch(input, init);
    recordSourceCheck({ source, sample: { ok: result.ok, latency_ms: Date.now() - start, http_status: result.status, error_category: result.ok ? undefined : `HTTP_${result.status}` } }); return result;
  } catch (error) {
    recordSourceCheck({ source, sample: { ok: false, latency_ms: Date.now() - start, error_category: error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK' } }); throw error;
  }
}
