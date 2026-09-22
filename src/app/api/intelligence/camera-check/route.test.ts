import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/app/api/cctv/route', () => ({ GET: vi.fn() }));
vi.mock('@/lib/ssrf-guard', () => ({ getClientIp: () => 'test', isRateLimited: () => false, safeFetch: vi.fn() }));
import { GET as catalog } from '@/app/api/cctv/route';
vi.mock('@/lib/cctv-snapshot', () => ({ lookupCachedCamera: vi.fn() }));
import { lookupCachedCamera } from '@/lib/cctv-snapshot';
import { safeFetch } from '@/lib/ssrf-guard';
import { POST } from './route';
const request = (id: string) => new Request(`http://localhost/api/intelligence/camera-check?id=${id}`, { method: 'POST' });
describe('catalog-bound camera probes', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 404 }))); vi.mocked(lookupCachedCamera).mockResolvedValue(null); });
  afterEach(() => vi.unstubAllGlobals());
  it('rejects arbitrary URLs and unknown IDs without a camera request', async () => { expect((await POST(new Request('http://localhost/x?id=x&url=http://localhost', { method: 'POST' }))).status).toBe(400); expect((await (await POST(request('unknown'))).json()).status).toBe('UNKNOWN'); expect(catalog).not.toHaveBeenCalled(); expect(safeFetch).not.toHaveBeenCalled(); });
  it('leaves iframe availability unknown', async () => { vi.mocked(lookupCachedCamera).mockResolvedValue({ id: 'video', stream_type: 'iframe', stream_url: 'https://example.com' }); expect((await (await POST(request('video'))).json()).status).toBe('UNKNOWN'); expect(safeFetch).not.toHaveBeenCalled(); });
  it('requires image bytes and persists the real outcome', async () => {
    vi.mocked(lookupCachedCamera).mockResolvedValue({ id: 'frame', name: 'Camera', feed_url: 'https://known.example/frame.jpg' });
    vi.mocked(safeFetch).mockResolvedValue(new Response(new Uint8Array([255,216,255,...Array(50).fill(0)]), { status: 200 }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 404 })).mockResolvedValueOnce(Response.json({ accepted: 1 }));
    const response = await POST(request('frame')); expect(response.status).toBe(200); expect((await response.json()).status).toBe('SNAPSHOT_AVAILABLE');
    expect(vi.mocked(safeFetch).mock.calls[0][1]?.maxRedirects).toBe(0);
    const report = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)); expect(report.reports[0].sample.camera_media).toEqual({snapshot_status:'SNAPSHOT_AVAILABLE',stream_status:'UNKNOWN'}); expect(report.reports[0].sample.ok).toBe(true); expect(report.reports[0].sample.data_at).toBeUndefined();
  });
  it('honors persistent backoff without probing or loading the catalog', async () => { vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: 'OFFLINE', next_check_at: new Date(Date.now() + 300000).toISOString() })); expect((await (await POST(request('backoff'))).json()).cached).toBe(true); expect(catalog).not.toHaveBeenCalled(); expect(safeFetch).not.toHaveBeenCalled(); });
});
