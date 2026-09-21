import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { lookupCachedCamera } from '@/lib/cctv-snapshot';
import { getClientIp, isRateLimited, safeFetch } from '@/lib/ssrf-guard';
export const dynamic = 'force-dynamic';
interface Check { id: string; camera_id: string; status: string; checked_at: string; error: string | null; next_check_at: string }
const results = new Map<string, Check>();
let running = 0;
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  try { if (origin && new URL(origin).host !== (req.headers.get('host') || new URL(req.url).host)) return NextResponse.json({ error: 'Cross-origin probe denied' }, { status: 403 }); } catch { return NextResponse.json({ error: 'Invalid origin' }, { status: 403 }); }
  const params = new URL(req.url).searchParams, id = params.get('id');
  if (!id || id.length > 200 || [...params.keys()].some(k => k !== 'id') || params.getAll('id').length !== 1) return NextResponse.json({ error: 'A catalog camera ID is required' }, { status: 400 });
  if (isRateLimited(`camera-check:${getClientIp(req)}`, 12, 60000)) return NextResponse.json({ error: 'Probe rate limit exceeded' }, { status: 429 });
  const previous = results.get(id); if (previous && Date.now() < Date.parse(previous.next_check_at)) return NextResponse.json({ ...previous, cached: true });
  if (running >= 2) return NextResponse.json({ error: 'Two camera checks already in progress' }, { status: 429 });
  running++;
  try {
    const sourceId = `camera:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
    const base = process.env.INTEL_URL || (process.env.NODE_ENV === 'production' ? 'http://osiris-intel:4000' : 'http://localhost:4000');
    const prior = await fetch(`${base}/intelligence/sources/${sourceId}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (prior.ok) { const saved = await prior.json(); if (saved.next_check_at && Date.parse(saved.next_check_at) > Date.now()) return NextResponse.json({ id: sourceId, camera_id: id, status: saved.status, checked_at: saved.last_checked_at, error: saved.last_error_category, next_check_at: saved.next_check_at, cached: true }); }
    else if (prior.status !== 404) return NextResponse.json({ error: 'Health storage unavailable; check postponed' }, { status: 502 });
    const camera = await lookupCachedCamera(id);
    if (!camera) return NextResponse.json({ status: 'UNKNOWN', code: 'NOT_AVAILABLE', camera_id: id, error: 'Camera is not available in the local catalog yet. Load its region on the map first.' });
    if (!camera.feed_url || camera.stream_type && camera.stream_type !== 'jpg') return NextResponse.json({ status: 'UNKNOWN', camera_id: id, error: 'Only catalog snapshot cameras support server frame checks. Embedded video availability remains unknown.' });
    const target = new URL(String(camera.feed_url));
    if (target.username || target.password || !['http:', 'https:'].includes(target.protocol)) return NextResponse.json({ error: 'Unsupported catalog target' }, { status: 400 });
    // The exact catalog URL is the allowlist. Redirects are rejected, DNS/private addresses checked.
    const start = Date.now(); let ok = false, code: number | undefined, error: string | undefined;
    try {
      const frame = await safeFetch(target.href, { maxRedirects: 0, signal: AbortSignal.timeout(8000), headers: { Accept: 'image/*' } }); code = frame.status;
      if (!frame.ok) { await frame.body?.cancel(); error = `HTTP_${frame.status}`; }
      else {
        const reader = frame.body?.getReader(); let size = 0, head = Buffer.alloc(0);
        try { if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk.value)]).subarray(0, 16); if (size > 2 * 1024 * 1024) { await reader.cancel(); error = 'FRAME_SIZE_LIMIT'; break; } } } finally { reader?.releaseLock(); }
        const signature = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff || head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || head.toString('ascii', 0, 4) === 'GIF8' || head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
        ok = !error && size > 32 && signature; if (!ok && !error) error = 'NOT_AN_IMAGE';
      }
    } catch (e) { error = e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name) ? 'TIMEOUT' : 'NETWORK_OR_BLOCKED_REDIRECT'; }
    const saved = await fetch(`${base}/intelligence/source-reports`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', 'X-Intelligence-Key': process.env.INTELLIGENCE_REPORT_KEY || 'osiris-local-reports' }, body: JSON.stringify({ reports: [{ source: { id: sourceId, name: String(camera.name || id).slice(0, 160), category: 'cctv', scope: 'camera', endpoint: id }, sample: { ok, latency_ms: Date.now() - start, http_status: code, error_category: error, record_count: ok ? 1 : 0 } }] }) });
    if (!saved.ok) return NextResponse.json({ error: 'Camera checked but health could not be persisted' }, { status: 502 });
    const result: Check = { id: sourceId, camera_id: id, status: ok ? 'FRAME_AVAILABLE' : 'CHECK_FAILED', checked_at: new Date().toISOString(), error: error || null, next_check_at: new Date(Date.now() + (ok ? 600000 : 120000)).toISOString() };
    if (results.size >= 1000) results.delete(results.keys().next().value!); results.set(id, result);
    return NextResponse.json(result);
  } catch { return NextResponse.json({ error: 'Camera health unavailable' }, { status: 502 }); } finally { running--; }
}
