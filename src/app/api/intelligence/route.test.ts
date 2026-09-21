import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/ssrf-guard', () => ({ getClientIp: () => 'test', isRateLimited: () => false }));
import { proxyIntelligence } from './[...path]/route';
const id = '11111111-2222-3333-4444-555555555555';
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
describe('intelligence proxy boundary', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ items: [] }))));
  afterEach(() => vi.unstubAllGlobals());
  it('only exposes read endpoints and explicit dismissal', async () => {
    expect((await proxyIntelligence(new Request('http://localhost/api/intelligence/sources?scope=camera&limit=10'), context('sources'))).status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:4000/intelligence/sources?scope=camera&limit=10');
    for (const path of [['source-reports'], ['run'], ['http:', 'evil'], ['sources', '..', 'health']]) expect((await proxyIntelligence(new Request('http://localhost/api/intelligence/x'), context(...path))).status).toBe(404);
    expect((await proxyIntelligence(new Request(`http://localhost/api/intelligence/correlations/${id}/dismiss`, { method: 'POST' }), context('correlations', id, 'dismiss'))).status).toBe(200);
  });
  it('rejects duplicate and arbitrary query parameters', async () => {
    for (const params of ['limit=1&limit=2', 'url=http://localhost', `cursor=${'a'.repeat(201)}`]) expect((await proxyIntelligence(new Request(`http://localhost/api/intelligence/sources?${params}`), context('sources'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutations and oversized bodies', async () => {
    expect((await proxyIntelligence(new Request('http://localhost/x', { method: 'POST', headers: { origin: 'https://evil.example' } }), context('correlations', id, 'dismiss'))).status).toBe(403);
    expect((await proxyIntelligence(new Request('http://localhost/x', { method: 'POST', headers: { 'content-length': '10000' } }), context('correlations', id, 'dismiss'))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports a failed service without exposing its details or secrets', async () => { vi.mocked(fetch).mockRejectedValueOnce(new Error('password=secret')); const result = await proxyIntelligence(new Request('http://localhost/x'), context('policies')); expect(result.status).toBe(502); expect(JSON.stringify(await result.json())).not.toContain('secret'); });
});
