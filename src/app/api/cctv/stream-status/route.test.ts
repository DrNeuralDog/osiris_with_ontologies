import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ssrf-guard', () => ({ validateHost: vi.fn(async () => ({ ok: true })), getClientIp: () => 'test', isRateLimited: () => false }));
import { GET } from './route';
afterEach(() => vi.unstubAllGlobals());
it('embed HTTP 200 never certifies playback; explicit provider limit is distinct', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>Player</html>')).mockResolvedValueOnce(new Response('Temporarily limited. Top up'));
  vi.stubGlobal('fetch', fetcher);
  const req = () => new Request('http://localhost/api/cctv/stream-status?url=https://rtsp.me/embed/abc123/');
  expect(await (await GET(req())).json()).toMatchObject({ available: null, document_available: true, stream_status: 'UNKNOWN' });
  expect(await (await GET(req())).json()).toMatchObject({ available: false, stream_status: 'STREAM_BLOCKED' });
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
});
it('rejects unrelated URLs and oversized upstream responses', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1))); vi.stubGlobal('fetch', fetcher);
  expect((await GET(new Request('http://localhost/api/cctv/stream-status?url=https://evil.test/?x=rtsp.me/embed/abc'))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await GET(new Request('http://localhost/api/cctv/stream-status?url=https://rtsp.me/embed/abc'))).status).toBe(502);
});
