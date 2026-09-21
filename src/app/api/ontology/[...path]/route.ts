import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
export const dynamic = 'force-dynamic';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
type Context = { params: Promise<{ path: string[] }> };
export async function proxyOntology(req: Request, context: Context) {
  const { path } = await context.params;
  const route = path.join('/');
  const allowed = req.method === 'GET' ? new RegExp(`^(types|objects|objects/${UUID}(/(graph|relationships))?)$`).test(route) : req.method === 'POST' && new RegExp(`^(resolve|objects/${UUID}/expand)$`).test(route);
  if (!allowed) return NextResponse.json({ error: 'Unknown ontology endpoint' }, { status: 404 });
  if (isRateLimited(`ontology:${getClientIp(req)}`, 90, 60000)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (req.method === 'POST') {
    const origin = req.headers.get('origin');
    // Next standalone uses its internal bind address in req.url behind Docker.
    // The browser-visible Host remains the same-origin authority.
    const host = req.headers.get('host') || new URL(req.url).host;
    if (origin) {
      let sameOrigin = false;
      try { const parsed = new URL(origin); sameOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host; } catch { /* invalid origin */ }
      if (!sameOrigin) return NextResponse.json({ error: 'Cross-origin mutation denied' }, { status: 403 });
    }
  }
  const params = new URL(req.url).searchParams;
  const keys = new Set(['q', 'type', 'namespace', 'value', 'limit', 'depth', 'max_nodes', 'max_edges', 'direction']);
  for (const [key, value] of params) if (!keys.has(key) || params.getAll(key).length > 1 || value.length > 300) return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  try {
    let body: string | undefined;
    if (req.method === 'POST') {
      if (Number(req.headers.get('content-length')) > 16384) return NextResponse.json({ error: 'Body too large' }, { status: 413 });
      const reader = req.body?.getReader(), decoder = new TextDecoder();
      let bytes = 0; body = '';
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 16384) { await reader.cancel(); return NextResponse.json({ error: 'Body too large' }, { status: 413 }); }
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
        } finally { reader.releaseLock(); }
      }
      try { JSON.parse(body || '{}'); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    }
    const base = process.env.INTEL_URL || (process.env.NODE_ENV === 'production' ? 'http://osiris-intel:4000' : 'http://localhost:4000');
    const response = await fetch(`${base}/ontology/${route}?${params}`, { method: req.method, body, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000) });
    return NextResponse.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'Ontology unavailable. Check osiris-intel and PostgreSQL.' }, { status: 502 }); }
}
export const GET = proxyOntology;
export const POST = proxyOntology;
