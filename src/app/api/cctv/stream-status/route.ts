import { NextResponse } from 'next/server';
import { validateHost, getClientIp, isRateLimited } from '@/lib/ssrf-guard';
export const dynamic = 'force-dynamic';
/** Legacy page check: a loaded embed is never proof of video playback. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('url') || '';
  let url: URL;
  try { url = new URL(raw); } catch { return NextResponse.json({ available: null, stream_status: 'UNKNOWN', reason: 'not_rtsp_me' }, { status: 400 }); }
  if (raw.length > 2048 || url.protocol !== 'https:' || url.hostname !== 'rtsp.me' || url.port || url.username || url.password || !/^\/embed\/[A-Za-z0-9]+\/?$/.test(url.pathname) || url.search) return NextResponse.json({ available: null, stream_status: 'UNKNOWN', reason: 'not_rtsp_me' }, { status: 400 });
  if (isRateLimited(`stream-page:${getClientIp(req)}`, 12, 60_000)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (!(await validateHost(url.hostname)).ok) throw new Error('HOST_BLOCKED');
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'text/html' } });
    if (!res.ok) { await res.body?.cancel(); return NextResponse.json({ available: null, document_available: false, stream_status: [401, 403].includes(res.status) ? 'STREAM_BLOCKED' : 'UNKNOWN', http_status: res.status, provider: 'rtsp.me' }, { headers }); }
    const reader = res.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('PAGE_TOO_LARGE'); } chunks.push(chunk.value); } } finally { reader?.releaseLock(); }
    const blocked = /temporarily limited|Top up/i.test(Buffer.concat(chunks).toString('utf8'));
    return NextResponse.json({ available: blocked ? false : null, document_available: true, blocked, stream_status: blocked ? 'STREAM_BLOCKED' : 'UNKNOWN', provider: 'rtsp.me', reason: blocked ? 'PROVIDER_LIMIT' : 'PLAYBACK_NOT_CHECKED' }, { headers });
  } catch { return NextResponse.json({ available: null, stream_status: 'UNKNOWN', provider: 'rtsp.me', reason: 'PAGE_UNAVAILABLE' }, { status: 502, headers }); }
}
