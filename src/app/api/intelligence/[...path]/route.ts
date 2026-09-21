import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
export const dynamic = 'force-dynamic';
const uuid = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
export async function proxyIntelligence(req: Request, context: { params: Promise<{ path: string[] }> }) {
  const route = (await context.params).path.join('/');
  const allowed = req.method === 'GET' ? new RegExp(`^(summary|objects/${uuid}/context|policies|sources|sources/[a-zA-Z0-9:._-]{1,160}/samples|correlations|correlations/${uuid})$`).test(route) : req.method === 'POST' && new RegExp(`^correlations/${uuid}/dismiss$`).test(route);
  if (!allowed) return NextResponse.json({ error: 'Unknown intelligence endpoint' }, { status: 404 });
  if (isRateLimited(`intelligence:${getClientIp(req)}`, 90, 60000)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (req.method === 'POST') {
    const origin = req.headers.get('origin');
    try { if (origin && new URL(origin).host !== (req.headers.get('host') || new URL(req.url).host)) return NextResponse.json({ error: 'Cross-origin mutation denied' }, { status: 403 }); }
    catch { return NextResponse.json({ error: 'Invalid origin' }, { status: 403 }); }
    // Dismiss has no input body. Never forward arbitrary payloads or report keys.
    if (req.headers.get('content-length') && Number(req.headers.get('content-length')) > 2) return NextResponse.json({ error: 'Body not supported' }, { status: 413 });
  }
  const params = new URL(req.url).searchParams, keys = new Set(['scope', 'category', 'status', 'limit', 'cursor', 'type', 'object_id']);
  for (const [key, value] of params) if (!keys.has(key) || params.getAll(key).length > 1 || value.length > 200) return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  try {
    const base = process.env.INTEL_URL || (process.env.NODE_ENV === 'production' ? 'http://osiris-intel:4000' : 'http://localhost:4000');
    const response = await fetch(`${base}/intelligence/${route}?${params}`, { method: req.method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
    return NextResponse.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'Intelligence storage unavailable' }, { status: 502 }); }
}
export const GET = proxyIntelligence;
export const POST = proxyIntelligence;
