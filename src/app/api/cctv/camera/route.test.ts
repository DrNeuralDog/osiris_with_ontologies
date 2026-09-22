import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cctv-snapshot', () => ({ lookupCachedCamera: vi.fn() }));
vi.mock('@/lib/ssrf-guard', () => ({ isRateLimited: () => false, getClientIp: () => 'test' }));
import { lookupCachedCamera } from '@/lib/cctv-snapshot';
import { GET } from './route';
describe('catalog camera viewer lookup', () => {
  it('only uses bounded local ID index and rejects arbitrary URLs', async () => {
    expect((await GET(new Request('http://localhost/api/cctv/camera?id=x&url=https://evil.example'))).status).toBe(400);
    expect(lookupCachedCamera).not.toHaveBeenCalled();
    vi.mocked(lookupCachedCamera).mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/cctv/camera?id=x'))).status).toBe(404);
    vi.mocked(lookupCachedCamera).mockResolvedValue({ id: 'x', name: 'Public camera', stream_type: 'mp4', private_metadata: 'excluded' });
    expect(await (await GET(new Request('http://localhost/api/cctv/camera?id=x'))).json()).toEqual({ id: 'x', name: 'Public camera', stream_type: 'mp4' });
  });
});
