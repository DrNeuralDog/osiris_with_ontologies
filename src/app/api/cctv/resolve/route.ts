import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { resolutionTTL, resolvableUrl, resolveCameraPage, type Resolution } from '@/lib/camera-resolver';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;
const cache = new Map<string, { at: number; value: Resolution }>();
const pending = new Map<string, Promise<Resolution>>();
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams, url = params.get('url');
  if (!url || !resolvableUrl(url) || params.getAll('url').length !== 1 || [...params.keys()].some(k => k !== 'url')) return NextResponse.json({ embeddable: false, kind: 'unknown', reason: 'not_resolvable' }, { status: 400 });
  if (isRateLimited(`camera-resolve:${getClientIp(req)}`, 30, 60000)) return NextResponse.json({ embeddable: false, kind: 'unreachable', reason: 'rate_limit' }, { status: 429 });
  const hit = cache.get(url); let value: Resolution, cached = false;
  if (hit && Date.now() - hit.at < resolutionTTL(hit.value)) { value = hit.value; cached = true; }
  else {
    if (!pending.has(url)) {
      if (pending.size >= 4) return NextResponse.json({ kind: 'unreachable', reason: 'busy' }, { status: 429 });
      pending.set(url, resolveCameraPage(url).finally(() => pending.delete(url)));
    }
    value = await pending.get(url)!;
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(url, { at: Date.now(), value });
  }
  // In-process cache owns the TTLs; no CDN may stretch a transient failure.
  return NextResponse.json({ ...value, retry_after_ms: resolutionTTL(value) }, { headers: { 'X-Cache': cached ? 'HIT' : 'MISS', 'Cache-Control': 'no-store' } });
}
