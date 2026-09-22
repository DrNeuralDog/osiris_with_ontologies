import { NextResponse } from 'next/server';
import { lookupCachedCamera } from '@/lib/cctv-snapshot';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
export const dynamic = 'force-dynamic';
/** Bounded ID lookup for a shareable viewer; never starts catalog/provider fan-out. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams, id = params.get('id');
  if (!id || id.length > 200 || params.getAll('id').length !== 1 || [...params.keys()].some(k => k !== 'id')) return NextResponse.json({ error: 'A catalog camera ID is required' }, { status: 400 });
  if (isRateLimited(`camera-lookup:${getClientIp(req)}`, 60, 60000)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  const camera = await lookupCachedCamera(id);
  if (!camera) return NextResponse.json({ error: 'Camera is not in the local catalog. Load its region on the map first.', code: 'NOT_AVAILABLE' }, { status: 404 });
  const fields = ['id', 'name', 'source', 'city', 'country', 'lat', 'lng', 'feed_url', 'stream_url', 'stream_type', 'external_url'];
  return NextResponse.json(Object.fromEntries(fields.filter(k => camera[k] != null).map(k => [k, camera[k]])), { headers: { 'Cache-Control': 'no-store' } });
}
