import { it, expect, vi, afterEach } from 'vitest';
vi.mock('@/lib/ssrf-guard', () => ({ getClientIp: () => 'test', isRateLimited: () => false }));
import { POST } from './route';
afterEach(() => vi.unstubAllGlobals());
it('accepts Docker same-origin Host while forwarding only to configured intel', async () => { const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'SCENARIO_ONLY' }))); vi.stubGlobal('fetch', f); const r = await POST(new Request('http://0.0.0.0:3000/api/intelligence/air-threat/acoustic', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, body: JSON.stringify({ observation_id: 'fixture' }) })); expect(r.status).toBe(200); expect(String(f.mock.calls[0][0])).toMatch(/\/intelligence\/air-threat\/acoustic$/); });
it('rejects malformed input, arbitrary URL probes and excessive bodies', async () => { const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); for (const body of ['{', JSON.stringify({ url: 'http://localhost' }), 'x'.repeat(2001)]) {
    const r = await POST(new Request('http://localhost/api/intelligence/air-threat/acoustic', { method: 'POST', body }));
    expect([400, 413]).toContain(r.status);
} expect(fetcher).not.toHaveBeenCalled(); });
it('denies cross-origin request', async () => { expect((await POST(new Request('http://localhost/api/intelligence/air-threat/acoustic', { method: 'POST', headers: { origin: 'https://unrelated.test' }, body: '{}' }))).status).toBe(403); });
